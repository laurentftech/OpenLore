/**
 * cursor adapter — writes an OpenLore-managed block to `.cursorrules` and a
 * companion `.cursor/rules/openlore.mdc` file describing the orient() workflow.
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyMarkdownBlock, uninstallMarkdownBlock } from './markdown-block.js';
import { fingerprint } from '../block.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './types.js';

const RULES_FILE = '.cursorrules';
const MDC_FILE = '.cursor/rules/openlore.mdc';

function renderMdc(template: string): string {
  const fp = fingerprint(template);
  return `---
description: OpenLore orient() workflow
alwaysApply: true
openlore-fingerprint: ${fp}
---

${template.trimEnd()}
`;
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
    const desired = renderMdc(ctx.instructionTemplate);
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
    return rules;
  },
};
