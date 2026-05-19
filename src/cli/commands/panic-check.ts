/**
 * openlore panic-check
 *
 * Reads panic-state.json and outputs a structured JSON decision for the
 * Claude Code PreToolUse hook. Always exits 0 — severity is encoded in
 * the payload, not the exit code, so the hook runtime never sees an error.
 *
 * Designed for minimal startup overhead: imports only node built-ins and
 * constants. Heavy MCP dependencies are never loaded.
 */

import { Command } from 'commander';
import { readPanicState, writePanicState, buildPanicCheckOutput } from '../../core/services/mcp-handlers/panic-response.js';
import { emit } from '../../core/services/telemetry.js';

export const panicCheckCommand = new Command('panic-check')
  .description('Check current panic level (PreToolUse hook consumer)')
  .option('-d, --directory <path>', 'Project directory', process.cwd())
  .action((options: { directory: string }) => {
    const dir = options.directory;
    const state = readPanicState(dir);
    const output = buildPanicCheckOutput(state);

    if (output.decision === 'warn') {
      const newCount = state.interventionCountSinceStable + 1;
      writePanicState(dir, {
        ...state,
        lastHookInterventionAt: new Date().toISOString(),
        interventionCountSinceStable: newCount,
      });
      emit(dir, 'panic', {
        event: 'hook_intervention',
        channel: 'pre_tool_use',
        panic_level: state.panicLevel,
        severity: output.severity,
        directive_mode: newCount >= 3,
        intervention_count: newCount,
      });
    }

    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(0);
  });
