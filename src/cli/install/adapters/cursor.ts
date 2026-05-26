/**
 * cursor adapter — writes an OpenLore-managed block to `.cursorrules`, a
 * companion `.cursor/rules/openlore.mdc` file describing the orient() workflow,
 * and registers the OpenLore MCP server in `.cursor/mcp.json`.
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkdownBlock, uninstallMarkdownBlock } from './markdown-block.js';
import { fingerprint } from '../block.js';
import { mergeEntries, readMeta, removeManaged, isHandEdited } from '../json-managed.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';

const RULES_FILE = '.cursorrules';
const MDC_FILE = '.cursor/rules/openlore.mdc';
const MCP_FILE = '.cursor/mcp.json';

const MCP_ENTRY = {
  command: 'npx',
  args: ['--yes', 'openlore', 'mcp'],
};

async function loadMdcTemplate(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // adapters/ → ../templates/cursor-openlore.mdc (dist + tsx run share this layout)
    join(here, '..', 'templates', 'cursor-openlore.mdc'),
    // tsx fallback if for any reason we're not co-located with templates
    join(here, '..', '..', '..', '..', 'src', 'cli', 'install', 'templates', 'cursor-openlore.mdc'),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error('cursor adapter: could not locate cursor-openlore.mdc template');
}

async function renderMdc(instructions: string): Promise<string> {
  const tmpl = await loadMdcTemplate();
  return tmpl
    .replace('{{fingerprint}}', fingerprint(instructions.trimEnd()))
    .replace('{{instructions}}', instructions.trimEnd());
}

export const cursorAdapter: Adapter = {
  name: 'cursor',
  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const rulesResult = await applyMarkdownBlock(ctx, {
      fileName: RULES_FILE,
      createIfMissing: true,
      blockBody: ctx.instructionTemplate,
    });

    const mdcPath = join(ctx.root, MDC_FILE);
    const desired = await renderMdc(ctx.instructionTemplate);
    let existing: string | null = null;
    try {
      existing = await readFile(mdcPath, 'utf8');
    } catch {
      existing = null;
    }

    if (existing === desired) {
      rulesResult.changes.push({
        path: mdcPath,
        kind: 'noop',
        summary: `${MDC_FILE}: already up to date`,
      });
      return rulesResult;
    }

    const isOurs =
      existing === null ||
      /^openlore-fingerprint:/m.test(existing);

    if (existing !== null && !isOurs && !ctx.force) {
      rulesResult.changes.push({
        path: mdcPath,
        kind: 'noop',
        summary: `${MDC_FILE}: refused to overwrite non-OpenLore file (use --force)`,
      });
      rulesResult.warnings.push(`${MDC_FILE} exists but was not written by OpenLore`);
      rulesResult.conflict = true;
      return rulesResult;
    }

    const change: PlannedChange = {
      path: mdcPath,
      kind: existing === null ? 'create' : 'update',
      summary: existing === null ? `create ${MDC_FILE}` : `update ${MDC_FILE}`,
    };
    if (!ctx.dryRun) {
      await mkdir(dirname(mdcPath), { recursive: true });
      await writeFile(mdcPath, desired, 'utf8');
    }
    rulesResult.changes.push(change);

    // MCP server registration via .cursor/mcp.json (standard Cursor path).
    const mcpPath = join(ctx.root, MCP_FILE);
    let mcpExisting: Record<string, unknown> = {};
    let mcpHad = true;
    try {
      const parsed = JSON.parse(await readFile(mcpPath, 'utf8'));
      mcpExisting =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      mcpHad = false;
    }
    const mcpMeta = readMeta(mcpExisting);
    if (mcpMeta && isHandEdited(mcpExisting, mcpMeta) && !ctx.force) {
      rulesResult.changes.push({
        path: mcpPath,
        kind: 'noop',
        summary: `${MCP_FILE}: refused to overwrite hand-edited OpenLore entries (use --force)`,
      });
      rulesResult.warnings.push(
        `${MCP_FILE} has hand-edits in OpenLore-managed paths — pass --force to overwrite`
      );
      rulesResult.conflict = true;
      return rulesResult;
    }
    const { next: nextMcp, action: mcpAction } = mergeEntries(mcpExisting, [
      { path: 'mcpServers.openlore', value: MCP_ENTRY },
    ]);
    rulesResult.changes.push({
      path: mcpPath,
      kind: !mcpHad ? 'create' : mcpAction === 'noop' ? 'noop' : 'update',
      summary: !mcpHad
        ? `create ${MCP_FILE} with mcpServers.openlore`
        : mcpAction === 'noop'
          ? `${MCP_FILE}: already up to date`
          : `update mcpServers.openlore in ${MCP_FILE}`,
    });
    if (!ctx.dryRun && (mcpAction !== 'noop' || !mcpHad)) {
      await mkdir(dirname(mcpPath), { recursive: true });
      await writeFile(mcpPath, JSON.stringify(nextMcp, null, 2) + '\n', 'utf8');
    }
    return rulesResult;
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const rules = await uninstallMarkdownBlock(ctx, RULES_FILE, true);
    const mdcPath = join(ctx.root, MDC_FILE);
    try {
      const raw = await readFile(mdcPath, 'utf8');
      if (/^openlore-fingerprint:/m.test(raw)) {
        if (!ctx.dryRun) await unlink(mdcPath);
        rules.changes.push({
          path: mdcPath,
          kind: 'delete',
          summary: `remove ${MDC_FILE}`,
        });
      }
    } catch {
      /* not present, nothing to do */
    }

    // Strip our MCP entry from .cursor/mcp.json.
    const mcpPath = join(ctx.root, MCP_FILE);
    try {
      const parsed = JSON.parse(await readFile(mcpPath, 'utf8')) as Record<string, unknown>;
      const { next, removed } = removeManaged(parsed);
      if (removed) {
        const isEmpty = Object.keys(next).length === 0;
        if (isEmpty) {
          if (!ctx.dryRun) await unlink(mcpPath);
          rules.changes.push({
            path: mcpPath,
            kind: 'delete',
            summary: `remove ${MCP_FILE} (was OpenLore-only)`,
          });
        } else {
          if (!ctx.dryRun) await writeFile(mcpPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
          rules.changes.push({
            path: mcpPath,
            kind: 'update',
            summary: `strip OpenLore entries from ${MCP_FILE}`,
          });
        }
      }
    } catch {
      /* not present, nothing to do */
    }
    return rules;
  },
};
