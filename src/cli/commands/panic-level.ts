/**
 * openlore panic-level
 *
 * Read-only status line output: current panic level as a compact string.
 * No side effects, no writes — safe to call from a status line poller.
 *
 * Output: "P:L{n}" at L1–L4, empty string at L0.
 * Exit: always 0.
 */

import { Command } from 'commander';
import { readPanicState } from '../../core/services/mcp-handlers/panic-response.js';

export const panicLevelCommand = new Command('panic-level')
  .description('Output current panic level for status line display (read-only, exits 0)')
  .option('-d, --directory <path>', 'Project directory', process.cwd())
  .action((options: { directory: string }) => {
    try {
      const state = readPanicState(options.directory);
      if (state.panicLevel > 0) {
        process.stdout.write(`P:L${state.panicLevel}`);
      }
    } catch {
      // fail-open: output nothing
    }
    process.exit(0);
  });
