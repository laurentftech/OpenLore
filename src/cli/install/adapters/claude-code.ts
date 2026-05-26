/**
 * claude-code adapter — appends the OpenLore instruction block to CLAUDE.md
 * (creating it if absent) and adds a SessionStart hook + MCP server
 * registration to `.claude/settings.json`.
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyMarkdownBlock, uninstallMarkdownBlock } from './markdown-block.js';
import { mergeEntries, readMeta, removeManaged, isHandEdited } from '../json-managed.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';

const MD_FILE = 'CLAUDE.md';
const SETTINGS_PATH = '.claude/settings.json';

const MCP_ENTRY = {
  command: 'npx',
  args: ['--yes', 'openlore', 'mcp'],
};

const SESSION_HOOK = {
  matcher: '',
  hooks: [
    {
      type: 'command',
      command: 'npx --yes openlore orient --json',
    },
  ],
};

async function readJsonOrEmpty(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  async apply(ctx: ApplyContext): Promise<ApplyResult> {
    const mdResult = await applyMarkdownBlock(ctx, {
      fileName: MD_FILE,
      createIfMissing: true,
      blockBody: ctx.instructionTemplate,
    });

    const settingsPath = join(ctx.root, SETTINGS_PATH);
    const existing = await readJsonOrEmpty(settingsPath);
    const had = await fileExists(settingsPath);
    const prevMeta = readMeta(existing);
    if (prevMeta && isHandEdited(existing, prevMeta) && !ctx.force) {
      mdResult.changes.push({
        path: settingsPath,
        kind: 'noop',
        summary: `${SETTINGS_PATH}: refused to overwrite hand-edited OpenLore entries (use --force)`,
      });
      mdResult.warnings.push(
        `${SETTINGS_PATH} has hand-edits in OpenLore-managed paths — pass --force to overwrite`
      );
      mdResult.conflict = true;
      return mdResult;
    }

    const { next, action } = mergeEntries(existing, [
      { path: 'mcpServers.openlore', value: MCP_ENTRY },
      { path: 'hooks.SessionStart', value: [SESSION_HOOK] },
    ]);

    const change: PlannedChange = {
      path: settingsPath,
      kind: !had ? 'create' : action === 'noop' ? 'noop' : 'update',
      summary: !had
        ? `create ${SETTINGS_PATH} with SessionStart hook + mcpServers.openlore`
        : action === 'noop'
          ? `${SETTINGS_PATH}: already up to date`
          : `update SessionStart hook + mcpServers.openlore in ${SETTINGS_PATH}`,
    };

    if (!ctx.dryRun && (action !== 'noop' || !had)) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    }

    mdResult.changes.push(change);
    return mdResult;
  },

  async uninstall(ctx: ApplyContext): Promise<ApplyResult> {
    const md = await uninstallMarkdownBlock(ctx, MD_FILE, false);
    const settingsPath = join(ctx.root, SETTINGS_PATH);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
    } catch {
      return md;
    }
    const { next, removed } = removeManaged(parsed);
    if (!removed) return md;

    // If file is now empty (only had our entries), delete it.
    const isEmpty = Object.keys(next).length === 0;
    if (isEmpty) {
      if (!ctx.dryRun) await unlink(settingsPath);
      md.changes.push({
        path: settingsPath,
        kind: 'delete',
        summary: `remove ${SETTINGS_PATH} (was OpenLore-only)`,
      });
    } else {
      if (!ctx.dryRun) await writeFile(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
      md.changes.push({
        path: settingsPath,
        kind: 'update',
        summary: `strip OpenLore entries from ${SETTINGS_PATH}`,
      });
    }
    return md;
  },
};
