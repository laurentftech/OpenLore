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
import { queryGryphSignals, applyGryphDelta } from '../../core/services/mcp-handlers/gryph-bridge.js';
import { emit } from '../../core/services/telemetry.js';

type HookFormat = 'claude' | 'kilo' | 'codex';

export const panicCheckCommand = new Command('panic-check')
  .description('Check current panic level (PreToolUse hook consumer)')
  .option('-d, --directory <path>', 'Project directory', process.cwd())
  .option('-f, --format <format>', 'Hook format: claude|kilo|codex', 'claude')
  .action((options: { directory: string; format: string }) => {
    const dir = options.directory;
    const format = options.format as HookFormat;
    let state = readPanicState(dir);

    // Gryph enrichment — fail-open, query from lastOrientAt (or 15min ago if absent)
    const since = state.lastOrientAt ?? new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const gryphSignals = queryGryphSignals(since);
    if (gryphSignals) {
      const enrichedTriggers = [...state.triggers];
      const enrichedScore = applyGryphDelta(
        state.panicScore,
        gryphSignals,
        state.panicLevel >= 2,  // isStale when at L2+
        enrichedTriggers,
      );
      if (enrichedScore !== state.panicScore) {
        state = {
          ...state,
          panicScore: enrichedScore,
          triggers: enrichedTriggers,
        };
      }
    }

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
        format,
        panic_level: state.panicLevel,
        severity: output.severity,
        directive_mode: newCount >= 3,
        intervention_count: newCount,
        gryph_enriched: gryphSignals !== null,
      });
    }

    process.stdout.write(formatOutput(output, format) + '\n');
    process.exit(0);
  });

function formatOutput(output: ReturnType<typeof buildPanicCheckOutput>, format: HookFormat): string {
  // claude and codex both consume raw JSON — codex uses the same Claude Code hook schema
  if (format === 'claude' || format === 'codex') {
    return JSON.stringify(output);
  }

  // kilo: plain-text message (some runtimes just want a string signal)
  if (output.decision === 'allow') return '';
  return `[PANIC:${output.severity?.toUpperCase() ?? 'WARN'}] ${output.message ?? 'Destabilization detected — call orient().'}`;
}
