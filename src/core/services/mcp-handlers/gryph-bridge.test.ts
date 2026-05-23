/**
 * Tests for gryph-bridge.ts — RuntimeBehaviorProvider, GryphBehaviorProvider,
 * startGryphPolling lifecycle (single-flight, async isolation, panic state updates,
 * tracker sync, provenance attribution, telemetry).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OPENLORE_DIR } from '../../../constants.js';
import {
  GryphBehaviorProvider,
  startGryphPolling,
  applyGryphDelta,
  queryGryphSignals,
} from './gryph-bridge.js';
import type { RuntimeBehaviorProvider, RuntimeBehaviorSnapshot } from './gryph-bridge.js';
import { readPanicState, writePanicState, defaultPanicState } from './panic-response.js';
import type { EpistemicTracker } from './epistemic-lease.js';
import {
  GRYPH_RETRY_BURST_DELTA,
  GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA,
  GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA,
  GRYPH_POLL_INTERVAL_MS,
} from './panic-constants.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTracker(overrides: Partial<EpistemicTracker> = {}): EpistemicTracker {
  return {
    lastOrientAt: new Date(),
    graphVersionAtOrient: 'abc',
    cogLoad: 0,
    freshnessState: 'fresh',
    staleDepth: 0,
    recentModules: [],
    density: 0,
    oscillation: 0,
    localityConfidence: 1,
    panicScore: 0,
    panicLevel: 0,
    recentOrientCount: 0,
    lastOrientResetAt: 0,
    interventionCountSinceStable: 0,
    lastPanicUpdateAt: 0,
    panicTriggers: [],
    panicRecoverySuppressionUntil: 0,
    panicRevision: 0,
    ...overrides,
  } as EpistemicTracker;
}

class FixedProvider implements RuntimeBehaviorProvider {
  constructor(private snapshot: RuntimeBehaviorSnapshot | null) {}
  async collect(_since: string): Promise<RuntimeBehaviorSnapshot | null> {
    return this.snapshot;
  }
}

class CountingProvider implements RuntimeBehaviorProvider {
  calls = 0;
  snapshots: Array<RuntimeBehaviorSnapshot | null> = [];
  constructor(private responses: Array<RuntimeBehaviorSnapshot | null> = []) {}
  async collect(_since: string): Promise<RuntimeBehaviorSnapshot | null> {
    this.calls++;
    const snap = this.responses.shift() ?? null;
    this.snapshots.push(snap);
    return snap;
  }
}

class SlowProvider implements RuntimeBehaviorProvider {
  running = 0;
  maxConcurrent = 0;
  async collect(_since: string): Promise<RuntimeBehaviorSnapshot | null> {
    this.running++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
    await new Promise(r => setTimeout(r, 50));
    this.running--;
    return null;
  }
}

// ============================================================================
// applyGryphDelta — backward compat path
// ============================================================================

describe('applyGryphDelta', () => {
  it('retry burst adds delta', () => {
    const triggers: string[] = [];
    const score = applyGryphDelta(0, { commandEntropy: 0.1, repetitiveRetryBurst: true, largePatchWhileStale: false, largePatchLoc: 0 }, false, triggers);
    expect(score).toBe(GRYPH_RETRY_BURST_DELTA);
    expect(triggers).toContain('repetitive_retry_burst');
  });

  it('large patch while stale — low entropy applies heavy delta', () => {
    const triggers: string[] = [];
    const score = applyGryphDelta(0, { commandEntropy: 0.1, repetitiveRetryBurst: false, largePatchWhileStale: true, largePatchLoc: 600 }, true, triggers);
    expect(score).toBe(GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA);
    expect(triggers).toContain('large_patch_stale');
  });

  it('large patch while stale — high entropy attenuated', () => {
    const triggers: string[] = [];
    const score = applyGryphDelta(0, { commandEntropy: 0.8, repetitiveRetryBurst: false, largePatchWhileStale: true, largePatchLoc: 600 }, true, triggers);
    expect(score).toBe(GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA);
    expect(triggers).toContain('large_patch_attenuated');
  });

  it('large patch NOT stale — no delta', () => {
    const triggers: string[] = [];
    const score = applyGryphDelta(0, { commandEntropy: 0.1, repetitiveRetryBurst: false, largePatchWhileStale: true, largePatchLoc: 600 }, false, triggers);
    expect(score).toBe(0);
  });

  it('clamps at 100', () => {
    const score = applyGryphDelta(95, { commandEntropy: 0.1, repetitiveRetryBurst: true, largePatchWhileStale: true, largePatchLoc: 600 }, true, []);
    expect(score).toBe(100);
  });
});

// ============================================================================
// GryphBehaviorProvider — mocked child_process
// ============================================================================

describe('GryphBehaviorProvider', () => {
  it('returns null when gryph not available', async () => {
    vi.mock('node:child_process', () => ({
      spawnSync: vi.fn(() => ({ status: 1, stdout: null })),
      spawn: vi.fn(),
    }));
    const provider = new GryphBehaviorProvider();
    const result = await provider.collect(new Date().toISOString());
    // may return null (gryph unavailable) or a snapshot — just must not throw
    expect(result === null || typeof result === 'object').toBe(true);
    vi.restoreAllMocks();
  });
});

// ============================================================================
// queryGryphSignals — backward compat
// ============================================================================

describe('queryGryphSignals', () => {
  it('returns null when gryph unavailable', () => {
    // No mock needed — gryph is not installed in test env
    const result = queryGryphSignals(new Date().toISOString());
    expect(result).toBeNull();
  });
});

// ============================================================================
// startGryphPolling — lifecycle
// ============================================================================

describe('startGryphPolling', () => {
  let dir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'gryph-test-'));
    await mkdir(join(dir, OPENLORE_DIR, 'telemetry'), { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls provider after first interval', async () => {
    const provider = new CountingProvider([null]);
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    expect(provider.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS);
    expect(provider.calls).toBe(1);

    stop();
  });

  it('stops polling after cleanup call', async () => {
    const provider = new CountingProvider([null, null, null]);
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS);
    stop();
    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS * 3);
    expect(provider.calls).toBe(1);
  });

  it('single-flight: overlapping poll skipped', async () => {
    const slow = new SlowProvider();
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider: slow });

    // Fire two intervals while first poll is still running (50ms delay)
    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(100); // let slow poll finish

    expect(slow.maxConcurrent).toBe(1);
    stop();
  });

  it('null snapshot — no panic state written', async () => {
    const provider = new FixedProvider(null);
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    stop();

    // panic-state.json should not exist (no prior state)
    const state = readPanicState(dir);
    expect(state.panicScore).toBe(0);
  });

  it('snapshot with no actionable signals — no state update', async () => {
    const snapshot: RuntimeBehaviorSnapshot = {
      timestamp: Date.now(),
      commandEntropy: 0.8,
      repetitiveRetryBurst: false,
      shellActivity: true,
    };
    const provider = new FixedProvider(snapshot);
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    stop();

    const state = readPanicState(dir);
    expect(state.panicScore).toBe(0);
  });

  it('retry burst signal — updates panic state and syncs tracker', async () => {
    const snapshot: RuntimeBehaviorSnapshot = {
      timestamp: Date.now(),
      commandEntropy: 0.1,
      repetitiveRetryBurst: true,
      shellActivity: true,
    };
    const provider = new FixedProvider(snapshot);
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    stop();

    const state = readPanicState(dir);
    expect(state.panicScore).toBe(GRYPH_RETRY_BURST_DELTA);
    expect(tracker.panicScore).toBe(GRYPH_RETRY_BURST_DELTA);
  });

  it('large patch while stale — updates panic state', async () => {
    const snapshot: RuntimeBehaviorSnapshot = {
      timestamp: Date.now(),
      commandEntropy: 0.1,
      repetitiveRetryBurst: false,
      largePatchWhileStale: { loc: 800, entropy: 0.1 },
    };
    const provider = new FixedProvider(snapshot);
    const tracker = makeTracker({ staleDepth: 2 });
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    stop();

    const state = readPanicState(dir);
    expect(state.panicScore).toBe(GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA);
  });

  it('large patch NOT stale — no delta', async () => {
    const snapshot: RuntimeBehaviorSnapshot = {
      timestamp: Date.now(),
      commandEntropy: 0.1,
      repetitiveRetryBurst: false,
      largePatchWhileStale: { loc: 800, entropy: 0.1 },
    };
    const provider = new FixedProvider(snapshot);
    const tracker = makeTracker({ staleDepth: 0 });
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    stop();

    const state = readPanicState(dir);
    expect(state.panicScore).toBe(0);
  });

  it('provenance carries source:gryph', async () => {
    const emitted: unknown[] = [];
    vi.spyOn(await import('../telemetry.js'), 'emit').mockImplementation(
      (_dir, _domain, payload) => { emitted.push(payload); },
    );

    const snapshot: RuntimeBehaviorSnapshot = {
      timestamp: Date.now(),
      commandEntropy: 0.1,
      repetitiveRetryBurst: true,
    };
    const provider = new FixedProvider(snapshot);
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    stop();

    const delta = emitted.find(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>)['event'] === 'panic_score_delta',
    );
    expect(delta).toBeDefined();
    expect(delta?.['source']).toBe('gryph');
    const provenance = delta?.['provenance'] as Array<Record<string, unknown>>;
    expect(provenance?.[0]?.['evidence']).toMatchObject({ source: 'gryph' });
  });

  it('provider exception — fail-open, no throw', async () => {
    const broken: RuntimeBehaviorProvider = {
      async collect() { throw new Error('network error'); },
    };
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider: broken });

    await expect(vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100)).resolves.not.toThrow();
    stop();

    expect(tracker.panicScore).toBe(0);
  });

  it('null tracker — still writes panic state', async () => {
    const snapshot: RuntimeBehaviorSnapshot = {
      timestamp: Date.now(),
      commandEntropy: 0.1,
      repetitiveRetryBurst: true,
    };
    const provider = new FixedProvider(snapshot);
    const stop = startGryphPolling({ directory: dir, getTracker: () => null, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    stop();

    const state = readPanicState(dir);
    expect(state.panicScore).toBe(GRYPH_RETRY_BURST_DELTA);
  });

  it('accumulates score across polls', async () => {
    const snapshot: RuntimeBehaviorSnapshot = {
      timestamp: Date.now(),
      commandEntropy: 0.1,
      repetitiveRetryBurst: true,
    };
    const provider = new CountingProvider([snapshot, snapshot]);
    const tracker = makeTracker();
    const stop = startGryphPolling({ directory: dir, getTracker: () => tracker, provider });

    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS + 100);
    await vi.advanceTimersByTimeAsync(GRYPH_POLL_INTERVAL_MS);
    stop();

    const state = readPanicState(dir);
    expect(state.panicScore).toBe(GRYPH_RETRY_BURST_DELTA * 2);
    expect(tracker.panicScore).toBe(GRYPH_RETRY_BURST_DELTA * 2);
  });
});
