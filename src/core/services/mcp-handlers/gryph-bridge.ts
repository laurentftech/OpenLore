/**
 * Gryph bridge — optional integration with safedep/gryph observability tool.
 *
 * Gryph records shell exec and file-write events to a local SQLite store,
 * queryable via its CLI. Enriches panic score with signals openlore cannot
 * observe directly (commandEntropy, retry bursts, large patches while stale).
 *
 * MUST degrade gracefully to zero-impact absence semantics:
 * - gryph binary absent → returns null, no error, no log noise
 * - query timeout (200ms) → returns null
 * - unexpected output format → returns null
 * - any exception → returns null
 */

import { spawnSync } from 'node:child_process';

// ============================================================================
// TYPES
// ============================================================================

export interface GryphSignals {
  /** [0,1] diversity of recent command invocations. Low = retry loop. */
  commandEntropy: number;
  /** Low-entropy + repeated failing commands = destabilized shell activity. */
  repetitiveRetryBurst: boolean;
  /** Any write event > 500 LOC detected in the time window. */
  largePatchWhileActive: boolean;
  /** LOC count of the largest write event seen, 0 if none. */
  largePatchLoc: number;
}

interface GryphExecEvent {
  timestamp?: string;
  action?: string;
  command?: string;
  cmd?: string;       // alternate key some versions use
  exit_code?: number;
  exitCode?: number;
}

interface GryphWriteEvent {
  timestamp?: string;
  action?: string;
  path?: string;
  file?: string;
  lines?: number;
  loc?: number;
  additions?: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const GRYPH_TIMEOUT_MS         = 150;   // hard budget per query; total ≤ 200ms
const GRYPH_DETECT_TIMEOUT_MS  = 50;    // PATH check
const LARGE_PATCH_LOC_THRESHOLD = 500;
const ENTROPY_LOW_THRESHOLD    = 0.30;  // below = low-diversity / retry-loop

// ============================================================================
// ENTROPY COMPUTATION
// ============================================================================

/**
 * Normalised Shannon entropy of a command sequence.
 * Returns 1.0 (high entropy / fail-open) when sequence is empty.
 */
function computeCommandEntropy(commands: string[]): number {
  if (commands.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const cmd of commands) {
    const key = cmd.trim().split(/\s+/)[0] ?? cmd; // normalise to base command
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const n = commands.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / n;
    entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.max(counts.size, 1));
  return maxEntropy > 0 ? Math.min(1, entropy / maxEntropy) : 1;
}

// ============================================================================
// GRYPH DETECTION
// ============================================================================

let _gryphAvailable: boolean | undefined;

function isGryphAvailable(): boolean {
  if (_gryphAvailable !== undefined) return _gryphAvailable;
  const result = spawnSync('which', ['gryph'], {
    timeout: GRYPH_DETECT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  _gryphAvailable = result.status === 0 && Boolean(result.stdout?.toString().trim());
  return _gryphAvailable;
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

function queryGryph(action: 'exec' | 'write', since: string): unknown[] {
  const result = spawnSync(
    'gryph',
    ['query', '--format', 'json', '--action', action, '--since', since],
    {
      timeout: GRYPH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    },
  );
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Query Gryph for behavioral signals since `since` (ISO 8601).
 * Returns null when Gryph is absent or any error occurs — callers must
 * treat null as "no additional signals" (fail-open, zero-impact).
 */
export function queryGryphSignals(since: string): GryphSignals | null {
  try {
    if (!isGryphAvailable()) return null;

    const execEvents = queryGryph('exec', since) as GryphExecEvent[];
    const writeEvents = queryGryph('write', since) as GryphWriteEvent[];

    // commandEntropy from exec event command strings
    const commands = execEvents
      .map(e => e.command ?? e.cmd ?? '')
      .filter(Boolean);
    const commandEntropy = computeCommandEntropy(commands);

    // Repetitive retry burst: low entropy AND any failing command in window
    const hasFailures = execEvents.some(e => (e.exit_code ?? e.exitCode ?? 0) !== 0);
    const repetitiveRetryBurst = commandEntropy < ENTROPY_LOW_THRESHOLD && hasFailures;

    // Large patch: find max LOC write event
    const locs = writeEvents.map(e => e.lines ?? e.loc ?? e.additions ?? 0);
    const largePatchLoc = locs.length > 0 ? Math.max(...locs) : 0;
    const largePatchWhileActive = largePatchLoc > LARGE_PATCH_LOC_THRESHOLD;

    return { commandEntropy, repetitiveRetryBurst, largePatchWhileActive, largePatchLoc };
  } catch {
    return null; // always fail open
  }
}

/**
 * Apply Gryph-derived score deltas to a base panic score.
 * Returns the adjusted score (clamped [0,100]).
 *
 * Weights from spec:
 *   repetitive retry burst: +15
 *   large patch (low entropy): +30
 *   large patch (high entropy / legitimate refactor): +10
 */
export function applyGryphDelta(
  baseScore: number,
  signals: GryphSignals,
  isStale: boolean,
  triggers: string[],
): number {
  let delta = 0;

  if (signals.repetitiveRetryBurst) {
    delta += 15;
    triggers.push('repetitive_retry_burst');
  }

  if (signals.largePatchWhileActive && isStale) {
    // Large patch attenuation: high entropy = deliberate refactor → +10, not +30
    const attenuated = signals.commandEntropy > 0.60;
    delta += attenuated ? 10 : 30;
    triggers.push(attenuated ? 'large_patch_attenuated' : 'large_patch_stale');
  }

  return Math.min(100, Math.max(0, baseScore + delta));
}
