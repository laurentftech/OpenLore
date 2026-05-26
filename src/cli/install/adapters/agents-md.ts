/**
 * agents-md adapter — universal fallback that writes an AGENTS.md file at
 * the project root. This is the convention OpenAI Codex (and an increasing
 * number of other tools) read, so it's the safest "always do this" target.
 */

import { applyMarkdownBlock, uninstallMarkdownBlock } from './markdown-block.js';
import type { Adapter, ApplyContext } from './types.js';

const FILE_NAME = 'AGENTS.md';

export const agentsMdAdapter: Adapter = {
  name: 'agents-md',
  async apply(ctx: ApplyContext) {
    return applyMarkdownBlock(ctx, {
      fileName: FILE_NAME,
      createIfMissing: true,
      blockBody: ctx.instructionTemplate,
    });
  },
  async uninstall(ctx: ApplyContext) {
    return uninstallMarkdownBlock(ctx, FILE_NAME, true);
  },
};
