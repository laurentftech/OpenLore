/**
 * cline adapter — appends the OpenLore instruction block to `.clinerules`.
 */

import { applyMarkdownBlock, uninstallMarkdownBlock } from './markdown-block.js';
import type { Adapter, ApplyContext } from './types.js';

const FILE_NAME = '.clinerules';

export const clineAdapter: Adapter = {
  name: 'cline',
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
