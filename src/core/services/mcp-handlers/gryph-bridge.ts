/**
 * Gryph bridge — runtime behavioral observability provider.
 *
 * Promotes Gryph from optional score enrichment to first-class behavioral source.
 * Runs a background poll loop that updates panic state independently of MCP tool
 * calls, closing the blind spot where agents work purely via Bash/Edit/Read.
 *
 * Architecture:
 *   RuntimeBehaviorProvider (interface)
 *     └── GryphBehaviorProvider (impl: gryph query CLI)
 *         └── startGryphPolling (background loop → panic state)
 *
 * All failures degrade to zero-impact null semantics:
 * - gryph binary absent → null
 * - timeout → null
 * - malformed output → null
 * - any exception → null
 *
 * The poll loop MUST NOT block MCP execution, delay tool responses, or overlap.
 */

import { spawnSync, spawn } from 'node:child_process';
import { emit } from '../telemetry.js';
import { readPanicState, writePanicState, applyPanicHysteresis } from './panic-response.js';
import type { PanicState, PanicLevel } from './panic-response.js';
import type { EpistemicTracker } from './epistemic-lease.js';
import {
  PANIC_SCORE_MAX,
  GRYPH_RETRY_BURST_DELTA,
  GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA,
  GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA,
  GRYPH_LARGE_PATCH_LOC_THRESHOLD,
  GRYPH_ENTROPY_LOW_THRESHOLD,
  GRYPH_ENTROPY_HIGH_THRESHOLD,
  GRYPH_POLL_INTERVAL_MS,
  GRYPH_POLL_INTERVAL_MIN_MS,
} from './panic-constants.js';

// ============================================================================
// TYPES
// ============================================================================

/** Behavioral snapshot from a runtime observability source. */
export interface RuntimeBehaviorSnapshot {
  timestamp: number;
  commandEntropy?: number;
  repetitiveRetryBurst?: boolean;
  failingCommandRate?: number;
  largePatchWhileStale?: { loc: number; entropy: number };
  commandCount?: number;
  shellActivity?: boolean;
}

/** Abstraction for runtime behavioral data sources. */
export interface RuntimeBehaviorProvider {
  collect(since: string): Promise<RuntimeBehaviorSnapshot | null>;
}

/** Kept for backward compat with panic-check.ts enrichment path. */
export interface GryphSignals {
  commandEntropy: number;
  repetitiveRetryBurst: boolean;
  largePatchWhileStale: boolean;
  largePatchLoc: number;
}

interface GryphExecEvent {
  timestamp?: string;
  action?: string;
  command?: string;
  cmd?: string;
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

interface SnapshotDeltaResult {
  newScore: number;
  newLevel: PanicLevel;
  provenance: Array<{ name: string; delta: number; evidence: Record<string, unknown> }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const GRYPH_TIMEOUT_MS        = Math.max(50, Number(process.env['OPENLORE_GRYPH_TIMEOUT_MS'] ?? 150));
const GRYPH_DETECT_TIMEOUT_MS = 50;

// ============================================================================
// ENTROPY COMPUTATION
// ============================================================================

function computeCommandEntropy(commands: string[]): number {
  if (commands.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const cmd of commands) {
    const key = cmd.trim().split(/\s+/)[0] ?? cmd;
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

/** Synchronous query — used by the backward-compat panic-check enrichment path. */
function queryGryphSync(action: 'exec' | 'write', since: string): unknown[] {
  const result = spawnSync(
    'gryph',
    ['query', '--format', 'json', '--action', action, '--since', since],
    { timeout: GRYPH_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
  );
  if (result.status !== 0 || !result.stdout) return [];
  try {
    const parsed = JSON.parse(result.stdout.trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Async query — used by GryphBehaviorProvider polling path (non-blocking). */
async function queryGryphAsync(action: 'exec' | 'write', since: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    const child = spawn(
      'gryph',
      ['query', '--format', 'json', '--action', action, '--since', since],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const timer = setTimeout(() => { child.kill(); resolve([]); }, GRYPH_TIMEOUT_MS);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !output) { resolve([]); return; }
      try {
        const parsed = JSON.parse(output.trim());
        resolve(Array.isArray(parsed) ? parsed : []);
      } catch {
        resolve([]);
      }
    });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
  });
}

// ============================================================================
// SNAPSHOT DELTA — applies RuntimeBehaviorSnapshot to a panic state
// ============================================================================

function applySnapshotDelta(
  snapshot: RuntimeBehaviorSnapshot,
  state: PanicState,
  staleDepth: number,
): SnapshotDeltaResult {
  let delta = 0;
  const provenance: SnapshotDeltaResult['provenance'] = [];
  const isStale = staleDepth >= 2;

  if (snapshot.repetitiveRetryBurst) {
    delta += GRYPH_RETRY_BURST_DELTA;
    provenance.push({
      name: 'gryph_retry_burst',
      delta: GRYPH_RETRY_BURST_DELTA,
      evidence: { source: 'gryph', entropy: snapshot.commandEntropy ?? null },
    });
  }

  if (snapshot.largePatchWhileStale && isStale) {
    const { loc, entropy } = snapshot.largePatchWhileStale;
    const attenuated = entropy > GRYPH_ENTROPY_HIGH_THRESHOLD;
    const d = attenuated ? GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA : GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA;
    delta += d;
    provenance.push({
      name: 'large_patch_while_stale',
      delta: d,
      evidence: { source: 'gryph', loc, entropy },
    });
  }

  if (delta === 0) {
    return { newScore: state.panicScore, newLevel: state.panicLevel, provenance };
  }

  const newScore = Math.min(PANIC_SCORE_MAX, Math.max(0, state.panicScore + delta));
  const newLevel = applyPanicHysteresis(state.panicLevel, newScore, staleDepth);
  return { newScore, newLevel, provenance };
}

// ============================================================================
// GryphBehaviorProvider — RuntimeBehaviorProvider implementation
// ============================================================================

export class GryphBehaviorProvider implements RuntimeBehaviorProvider {
  async collect(since: string): Promise<RuntimeBehaviorSnapshot | null> {
    try {
      if (!isGryphAvailable()) return null;

      const [execEvents, writeEvents] = await Promise.all([
        queryGryphAsync('exec', since) as Promise<GryphExecEvent[]>,
        queryGryphAsync('write', since) as Promise<GryphWriteEvent[]>,
      ]);

      const commands = (execEvents as GryphExecEvent[])
        .map(e => e.command ?? e.cmd ?? '')
        .filter(Boolean);
      const commandEntropy = computeCommandEntropy(commands);

      const failingCount = (execEvents as GryphExecEvent[])
        .filter(e => (e.exit_code ?? e.exitCode ?? 0) !== 0).length;
      const failingCommandRate = execEvents.length > 0 ? failingCount / execEvents.length : 0;
      const repetitiveRetryBurst = commandEntropy < GRYPH_ENTROPY_LOW_THRESHOLD && failingCount > 0;

      const locs = (writeEvents as GryphWriteEvent[]).map(e => e.lines ?? e.loc ?? e.additions ?? 0);
      const maxLoc = locs.length > 0 ? Math.max(...locs) : 0;

      return {
        timestamp: Date.now(),
        commandEntropy,
        repetitiveRetryBurst,
        failingCommandRate,
        largePatchWhileStale: maxLoc > GRYPH_LARGE_PATCH_LOC_THRESHOLD
          ? { loc: maxLoc, entropy: commandEntropy }
          : undefined,
        commandCount: commands.length,
        shellActivity: execEvents.length > 0,
      };
    } catch {
      return null;
    }
  }
}

// ============================================================================
// POLLING LIFECYCLE
// ============================================================================

export interface GryphPollingOptions {
  directory: string;
  /** Returns current stale depth from in-memory tracker. */
  getTracker: () => EpistemicTracker | null;
  /** Optional provider override (for testing). */
  provider?: RuntimeBehaviorProvider;
}

/**
 * Start background Gryph polling. Returns a cleanup function (call on shutdown).
 *
 * Invariants:
 * - Never overlaps: single-flight protection skips polls while previous is running
 * - Never blocks: async spawn, isolated from MCP execution path
 * - Never throws: all errors caught, fail-open
 * - Syncs tracker: panicScore/panicLevel updated in-memory after file write so
 *   the MCP path doesn't overwrite Gryph-elevated state on the next tool call
 */
export function startGryphPolling(opts: GryphPollingOptions): () => void {
  const { directory, getTracker, provider = new GryphBehaviorProvider() } = opts;

  const intervalMs = Math.max(
    GRYPH_POLL_INTERVAL_MIN_MS,
    Number(process.env['OPENLORE_GRYPH_POLL_INTERVAL_MS'] ?? GRYPH_POLL_INTERVAL_MS),
  );

  let isPolling = false;
  let lastPollAt = new Date(Date.now() - intervalMs).toISOString();

  const poll = async (): Promise<void> => {
    if (isPolling) return;
    isPolling = true;
    try {
      const since = lastPollAt;
      lastPollAt = new Date().toISOString();

      const snapshot = await provider.collect(since);

      emit(directory, 'panic', {
        event: 'gryph_poll',
        success: snapshot !== null,
        shell_activity: snapshot?.shellActivity ?? false,
      });

      if (!snapshot) return;

      // No actionable signals — skip state update
      if (!snapshot.repetitiveRetryBurst && !snapshot.largePatchWhileStale) return;

      const state = readPanicState(directory);
      const tracker = getTracker();
      const staleDepth = tracker?.staleDepth ?? 0;

      const { newScore, newLevel, provenance } = applySnapshotDelta(snapshot, state, staleDepth);
      if (newScore === state.panicScore && newLevel === state.panicLevel) return;

      const updatedState: PanicState = {
        ...state,
        panicScore: newScore,
        panicLevel: newLevel,
        updatedAt: new Date().toISOString(),
        triggers: [...(state.triggers ?? []), ...provenance.map(p => p.name)],
      };
      writePanicState(directory, updatedState);

      // Sync in-memory tracker so MCP path doesn't overwrite with stale score
      if (tracker) {
        tracker.panicScore = newScore;
        tracker.panicLevel = newLevel as PanicLevel;
      }

      emit(directory, 'panic', {
        event: 'panic_score_delta',
        source: 'gryph',
        delta: newScore - state.panicScore,
        from_score: state.panicScore,
        to_score: newScore,
        from_level: state.panicLevel,
        to_level: newLevel,
        provenance,
      });
    } catch {
      // fail-open: no error propagates
    } finally {
      isPolling = false;
    }
  };

  const handle = setInterval(() => { void poll(); }, intervalMs);
  return () => clearInterval(handle);
}

// ============================================================================
// BACKWARD COMPAT — panic-check.ts enrichment path (sync, pre-existing)
// ============================================================================

/**
 * Synchronous Gryph query for the panic-check hook enrichment path.
 * Returns null when Gryph is absent or any error occurs.
 */
export function queryGryphSignals(since: string): GryphSignals | null {
  try {
    if (!isGryphAvailable()) return null;

    const execEvents = queryGryphSync('exec', since) as GryphExecEvent[];
    const writeEvents = queryGryphSync('write', since) as GryphWriteEvent[];

    const commands = execEvents.map(e => e.command ?? e.cmd ?? '').filter(Boolean);
    const commandEntropy = computeCommandEntropy(commands);
    const hasFailures = execEvents.some(e => (e.exit_code ?? e.exitCode ?? 0) !== 0);
    const repetitiveRetryBurst = commandEntropy < GRYPH_ENTROPY_LOW_THRESHOLD && hasFailures;

    const locs = writeEvents.map(e => e.lines ?? e.loc ?? e.additions ?? 0);
    const largePatchLoc = locs.length > 0 ? Math.max(...locs) : 0;
    const largePatchWhileStale = largePatchLoc > GRYPH_LARGE_PATCH_LOC_THRESHOLD;

    return { commandEntropy, repetitiveRetryBurst, largePatchWhileStale, largePatchLoc };
  } catch {
    return null;
  }
}

/**
 * Apply Gryph-derived score deltas (backward compat — panic-check enrichment).
 */
export function applyGryphDelta(
  baseScore: number,
  signals: GryphSignals,
  isStale: boolean,
  triggers: string[],
): number {
  let delta = 0;

  if (signals.repetitiveRetryBurst) {
    delta += GRYPH_RETRY_BURST_DELTA;
    triggers.push('repetitive_retry_burst');
  }

  if (signals.largePatchWhileStale && isStale) {
    const attenuated = signals.commandEntropy > GRYPH_ENTROPY_HIGH_THRESHOLD;
    delta += attenuated ? GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA : GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA;
    triggers.push(attenuated ? 'large_patch_attenuated' : 'large_patch_stale');
  }

  return Math.min(PANIC_SCORE_MAX, Math.max(0, baseScore + delta));
}
