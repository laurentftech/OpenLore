/**
 * Tests for the epistemic lease — session-level architectural confidence decay.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTracker, updateTracker, injectFreshness, getSourceRoots, trackerToPanicState } from './epistemic-lease.js';
import type { EpistemicTracker } from './epistemic-lease.js';

// ============================================================================
// Mock git hash — default returns stable hash
// ============================================================================

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ stdout: 'deadbeef1234\n', status: 0 })),
}));


import { spawnSync } from 'node:child_process';
const mockSpawnSync = vi.mocked(spawnSync);

// ============================================================================
// HELPERS
// ============================================================================

function freshTracker(): EpistemicTracker {
  const t = createTracker('/fake/repo');
  // No db at /fake/repo so sourceRoots=[] — set explicitly for module-drift tests.
  t.sourceRoots = ['src'];
  return t;
}

// ============================================================================
// getSourceRoots
// ============================================================================

describe('getSourceRoots', () => {
  it('returns empty array when no analysis db exists', () => {
    // /fake/repo has no .openlore/analysis/call-graph.db
    expect(getSourceRoots('/fake/repo')).toEqual([]);
  });

  it('returns empty array for non-existent directory', () => {
    expect(getSourceRoots('/does/not/exist')).toEqual([]);
  });

  it('tracker sourceRoots empty before analyze has run', () => {
    const t = createTracker('/fake/repo');
    expect(t.sourceRoots).toEqual([]);
  });
});

// ============================================================================
// createTracker
// ============================================================================

describe('createTracker', () => {
  it('starts fresh with zero load', () => {
    const t = freshTracker();
    expect(t.freshnessState).toBe('fresh');
    expect(t.cognitiveLoad).toBe(0);
    expect(t.modulesVisited.size).toBe(0);
  });

  it('captures git hash at creation', () => {
    mockSpawnSync.mockReturnValueOnce({ stdout: 'abc123\n', status: 0 } as ReturnType<typeof spawnSync>);
    const t = createTracker('/fake/repo');
    expect(t.graphVersionAtOrient).toBe('abc123');
  });

  it('handles git unavailable gracefully', () => {
    mockSpawnSync.mockReturnValueOnce({ stdout: null, status: 128 } as unknown as ReturnType<typeof spawnSync>);
    const t = createTracker('/fake/repo');
    expect(t.graphVersionAtOrient).toBe('');
    expect(t.freshnessState).toBe('fresh');
  });
});

// ============================================================================
// updateTracker — orient resets
// ============================================================================

describe('updateTracker — orient reset', () => {
  it('resets load, modules, and state to fresh', () => {
    const t = freshTracker();
    // Manually degrade
    t.cognitiveLoad = 50;
    t.freshnessState = 'degraded';
    t.modulesVisited.add('auth');

    updateTracker(t, 'orient', '/fake/repo');

    expect(t.freshnessState).toBe('fresh');
    expect(t.cognitiveLoad).toBe(0);
    expect(t.modulesVisited.size).toBe(0);
  });

  it('updates git hash on orient reset', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'old-hash';
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'orient', '/fake/repo');

    expect(t.graphVersionAtOrient).toBe('new-hash');
  });

  it('injectFreshness returns text unchanged after orient', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    updateTracker(t, 'orient', '/fake/repo');
    expect(injectFreshness('result text', t)).toBe('result text');
  });
});

// ============================================================================
// updateTracker — cognitive load accumulation
// ============================================================================

describe('updateTracker — cognitive load', () => {
  it('accumulates load by tool weight', () => {
    const t = freshTracker();
    updateTracker(t, 'search_code', '/fake/repo');         // weight 1
    updateTracker(t, 'get_subgraph', '/fake/repo');        // weight 5
    updateTracker(t, 'trace_execution_path', '/fake/repo'); // weight 8
    expect(t.cognitiveLoad).toBe(14);
  });

  it('assigns weight 1 to unknown tools', () => {
    const t = freshTracker();
    updateTracker(t, 'unknown_future_tool', '/fake/repo');
    expect(t.cognitiveLoad).toBe(1);
  });

  it('does not accumulate load for orient', () => {
    const t = freshTracker();
    updateTracker(t, 'orient', '/fake/repo');
    expect(t.cognitiveLoad).toBe(0);
  });
});

// ============================================================================
// updateTracker — state transitions (load-based)
// ============================================================================

describe('updateTracker — load-based decay', () => {
  it('transitions fresh → degraded at load >= 30', () => {
    const t = freshTracker();
    // trace_execution_path = 8, call 4 times = 32
    for (let i = 0; i < 4; i++) updateTracker(t, 'trace_execution_path', '/fake/repo');
    expect(t.freshnessState).toBe('degraded');
  });

  it('transitions directly to stale at load >= 60', () => {
    const t = freshTracker();
    // trace_execution_path = 8, call 8 times = 64
    for (let i = 0; i < 8; i++) updateTracker(t, 'trace_execution_path', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('state never reverses: stale stays stale after orient-weight-0 tool', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('degraded never drops back to fresh', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    // Low-weight calls shouldn't reverse state
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.freshnessState).toBe('degraded');
  });
});

// ============================================================================
// updateTracker — time-based decay
// ============================================================================

describe('updateTracker — time-based decay', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('degrades after 15 minutes', () => {
    const t = freshTracker();
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    // Trigger check with a lightweight call (won't hit load threshold alone)
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.freshnessState).toBe('degraded');
  });

  it('goes stale after 30 minutes', () => {
    const t = freshTracker();
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('stays fresh within 15 minutes with low load', () => {
    const t = freshTracker();
    vi.advanceTimersByTime(14 * 60 * 1000);
    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('fresh');
  });
});

// ============================================================================
// updateTracker — git hash invalidation
// ============================================================================

describe('updateTracker — git hash invalidation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('goes stale immediately when git hash changes', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'old-hash';
    // Advance past git check interval so the check fires
    vi.advanceTimersByTime(31_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
  });

  it('stays fresh when git hash unchanged', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'same-hash';
    vi.advanceTimersByTime(31_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'same-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('fresh');
  });

  it('skips git check within interval window', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'old-hash';
    // Only 5 seconds in — within 30s interval, git check skipped
    vi.advanceTimersByTime(5_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    // Hash changed but check was skipped — not stale yet
    expect(t.freshnessState).toBe('fresh');
  });

  it('git-divergence stale transition starts at depth 1 (load and age below d2 thresholds)', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = 'old-hash';
    vi.advanceTimersByTime(31_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);
    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
    expect(t.staleDepth).toBe(1);
  });

  it('skips git comparison when either hash is empty', () => {
    const t = freshTracker();
    t.graphVersionAtOrient = '';
    vi.advanceTimersByTime(31_000);
    mockSpawnSync.mockReturnValueOnce({ stdout: 'new-hash\n', status: 0 } as ReturnType<typeof spawnSync>);

    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.freshnessState).toBe('fresh');
  });
});

// ============================================================================
// updateTracker — module drift
// ============================================================================

describe('updateTracker — module drift', () => {
  it('tracks module from src/ path', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/middleware.ts');
    expect(t.modulesVisited.has('auth')).toBe(true);
  });

  it('tracks distinct modules', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/stripe.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/analytics/events.ts');
    expect(t.modulesVisited.size).toBe(3);
  });

  it('goes stale via high cross-module density (6 sequential distinct modules)', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/stripe.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/analytics/events.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/infra/db.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/core/index.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/api/run.ts');
    // 5 switches / 15 window size = 0.33 >= 0.30 stale threshold
    expect(t.freshnessState).toBe('stale');
  });

  it('ignores filePath without src/ prefix — no module pollution', () => {
    const t = freshTracker();
    // Absolute path with no src/ segment
    updateTracker(t, 'get_function_body', '/fake/repo', '/Users/foo/bar.ts');
    expect(t.modulesVisited.size).toBe(0);
  });

  it('deduplicates same module across calls', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/session.ts');
    expect(t.modulesVisited.size).toBe(1);
  });

  it('does not accumulate when filePath absent', () => {
    const t = freshTracker();
    updateTracker(t, 'get_subgraph', '/fake/repo');
    expect(t.modulesVisited.size).toBe(0);
  });
});

// ============================================================================
// updateTracker — stale short-circuit (no load accumulation)
// ============================================================================

describe('updateTracker — stale short-circuit', () => {
  it('does not accumulate load when already stale', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.cognitiveLoad = 10;
    updateTracker(t, 'trace_execution_path', '/fake/repo');
    expect(t.cognitiveLoad).toBe(10); // unchanged
  });

  it('does not add modules when already stale', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/jwt.ts');
    expect(t.modulesVisited.size).toBe(0);
  });
});

// ============================================================================
// injectFreshness
// ============================================================================

describe('injectFreshness', () => {
  it('returns text unchanged when fresh', () => {
    const t = freshTracker();
    expect(injectFreshness('tool result', t)).toBe('tool result');
  });

  it('appends degraded signal — does not prepend', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    const out = injectFreshness('tool result', t);
    expect(out.startsWith('tool result')).toBe(true);
    expect(out).toContain('EPISTEMIC LEASE: DEGRADED');
    expect(out).toContain('orient()');
  });

  it('prepends stale block — agent sees it first', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    const out = injectFreshness('tool result', t);
    expect(out.indexOf('EPISTEMIC LEASE: STALE')).toBeLessThan(out.indexOf('tool result'));
  });

  it('stale block contains capability-invalidation language (depth 1)', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 1;
    const out = injectFreshness('', t);
    expect(out).toContain('Cached architectural reasoning reliability: LOW');
    expect(out).toContain('Cross-module dependency assumptions: UNRELIABLE');
    expect(out).toContain('Internal repository model: NOT AUTHORITATIVE');
  });

  it('degraded signal contains orient call-to-action', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    const out = injectFreshness('', t);
    expect(out).toContain('orient()');
    expect(out).toContain('DEGRADED');
  });

  it('stale block shows age in minutes', () => {
    vi.useFakeTimers();
    const t = freshTracker();
    t.freshnessState = 'stale';
    vi.advanceTimersByTime(25 * 60 * 1000);
    const out = injectFreshness('', t);
    expect(out).toContain('25min');
    vi.useRealTimers();
  });

  it('degraded signal shows module count', () => {
    const t = freshTracker();
    t.freshnessState = 'degraded';
    t.modulesVisited.add('auth');
    t.modulesVisited.add('billing');
    const out = injectFreshness('', t);
    expect(out).toContain('modules visited: 2');
  });

  it('stale block shows cognitive load score', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 1;
    t.cognitiveLoad = 42;
    const out = injectFreshness('', t);
    expect(out).toContain('42');
  });
});

// ============================================================================
// Stale depth escalation
// ============================================================================

describe('stale depth escalation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts at depth 1 when crossing stale threshold', () => {
    const t = freshTracker();
    // load = 64, below depth-2 threshold of 85
    for (let i = 0; i < 8; i++) updateTracker(t, 'trace_execution_path', '/fake/repo');
    expect(t.freshnessState).toBe('stale');
    expect(t.staleDepth).toBe(1);
  });

  it('enters depth 2 when load >= 85 at stale transition', () => {
    const t = freshTracker();
    // Pre-seed just below depth-2 threshold, then one more call crosses it
    t.cognitiveLoad = 84;
    updateTracker(t, 'search_code', '/fake/repo'); // +1 → 85 >= 85, also >= stale threshold 60
    expect(t.freshnessState).toBe('stale');
    expect(t.staleDepth).toBe(2);
  });

  it('enters depth 3 when load >= 110 at stale transition', () => {
    const t = freshTracker();
    t.cognitiveLoad = 109;
    updateTracker(t, 'search_code', '/fake/repo'); // +1 → 110
    expect(t.freshnessState).toBe('stale');
    expect(t.staleDepth).toBe(3);
  });

  it('escalates depth 1 → 2 via time when already stale', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 1;
    // Advance to 45+ minutes
    vi.advanceTimersByTime(46 * 60 * 1000);
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.staleDepth).toBe(2);
  });

  it('escalates depth 2 → 3 via time when already stale', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 2;
    vi.advanceTimersByTime(61 * 60 * 1000);
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.staleDepth).toBe(3);
  });

  it('depth never decreases — stays at 3', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 3;
    vi.advanceTimersByTime(1000);
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.staleDepth).toBe(3);
  });

  it('depth resets to 0 on orient', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 3;
    updateTracker(t, 'orient', '/fake/repo');
    expect(t.staleDepth).toBe(0);
    expect(t.freshnessState).toBe('fresh');
  });

  it('depth 1 block contains procedural NOT-DO instructions', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 1;
    const out = injectFreshness('', t);
    expect(out).toContain('Do NOT rely on previous dependency assumptions');
    expect(out).toContain('STALE');
    expect(out).not.toContain('[ELEVATED]');
    expect(out).not.toContain('[CRITICAL]');
  });

  it('depth 2 block names downstream risks', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 2;
    const out = injectFreshness('', t);
    expect(out).toContain('[ELEVATED]');
    expect(out).toContain('HALLUCINATION RISK');
  });

  it('depth 3 block is imperative — STOP command present', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';
    t.staleDepth = 3;
    const out = injectFreshness('', t);
    expect(out).toContain('[CRITICAL]');
    expect(out).toContain('STOP');
    expect(out).toContain('CRITICALLY LOW');
  });

  it('depth 3 block is shorter than depth 1 — harder to skim', () => {
    const t = freshTracker();
    t.freshnessState = 'stale';

    t.staleDepth = 1;
    const d1 = injectFreshness('', t);

    t.staleDepth = 3;
    const d3 = injectFreshness('', t);

    expect(d3.length).toBeLessThan(d1.length);
  });
});

// ============================================================================
// V3.1 cross-module trajectory model
// ============================================================================

describe('updateTracker — V3.1 cross-module trajectory', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('degrades when density reaches 0.15 threshold', () => {
    const t = freshTracker();
    // 9 nulls + 4 alternating file calls = 3 switches / 15 window = 0.20 >= 0.15
    for (let i = 0; i < 9; i++) updateTracker(t, 'search_code', '/fake/repo');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/x.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/y.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/y.ts');
    expect(t.freshnessState).toBe('degraded');
  });

  it('module switch adds 5 to cognitiveLoad', () => {
    const t = freshTracker();
    // Pre-pad window with 13 nulls so first switch stays at density 1/15 ≈ 0.07 — no bonus fires
    for (let i = 0; i < 13; i++) updateTracker(t, 'search_code', '/fake/repo');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts'); // no switch (lastModule null)
    const loadBeforeSwitch = t.cognitiveLoad; // 13*1 + 2 = 15
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/x.ts');
    // window=[null×13,auth,billing], switch=1, density=1/15≈0.067 — no bonus, no stale
    expect(t.cognitiveLoad).toBe(loadBeforeSwitch + 2 + 5);
  });

  it('switch dampening prevents double-counting rapid back-and-forth', () => {
    const t = freshTracker();
    // Pre-pad so density stays low throughout
    for (let i = 0; i < 12; i++) updateTracker(t, 'search_code', '/fake/repo');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts'); // no switch
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/x.ts'); // switch +5, density=1/14≈0.07
    const loadAfterSwitch = t.cognitiveLoad; // 12 + 2 + 2 + 5 = 21
    // Return immediately — within dampening window, no +5
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts'); // density=2/15≈0.13, no stale
    expect(t.cognitiveLoad).toBe(loadAfterSwitch + 2); // only tool weight
  });

  it('switch dampening lifts after 5s', () => {
    const t = freshTracker();
    for (let i = 0; i < 12; i++) updateTracker(t, 'search_code', '/fake/repo');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts'); // no switch
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/x.ts'); // switch +5
    vi.advanceTimersByTime(5001);
    const loadBefore = t.cognitiveLoad; // 12 + 2 + 2 + 5 = 21
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts'); // switch fires again
    // density=2/15≈0.13, no stale, no bonus
    expect(t.cognitiveLoad).toBe(loadBefore + 2 + 5);
  });

  it('burst spike (+20) applied when density >= 0.60', () => {
    const t = freshTracker();
    // Full window of 15 alternating entries = 14 switches / 15 = 0.93 >= 0.60
    t.moduleAccessWindow = [
      'auth','billing','auth','billing','auth','billing','auth','billing',
      'auth','billing','auth','billing','auth','billing','auth',
    ] as (string | null)[];
    t.lastModule = 'auth';
    // One non-file call: density check fires with burst spike (+20), then stale
    updateTracker(t, 'search_code', '/fake/repo'); // weight=1
    expect(t.cognitiveLoad).toBe(1 + 20); // tool weight + burst spike
  });

  it('orient resets lastModule and moduleAccessWindow', () => {
    const t = freshTracker();
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts');
    updateTracker(t, 'orient', '/fake/repo');
    expect(t.lastModule).toBeNull();
    expect(t.moduleAccessWindow).toHaveLength(0);
  });

  it('non-file calls dilute density below threshold', () => {
    const t = freshTracker();
    // Pre-pad 13 nulls, then 1 switch — density = 1/15 ≈ 0.067 < 0.15 → fresh
    for (let i = 0; i < 13; i++) updateTracker(t, 'search_code', '/fake/repo');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts');
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/billing/x.ts');
    // window=[null×13,auth,billing], density=1/15≈0.067 < 0.15
    expect(t.freshnessState).toBe('fresh');
  });

  it('window slides — old entries fall off after 15 calls', () => {
    const t = freshTracker();
    // Fill window with auth calls (no switches)
    for (let i = 0; i < 15; i++) updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/x.ts');
    expect(t.moduleAccessWindow).toHaveLength(15);
    // One more call — oldest entry drops off
    updateTracker(t, 'get_function_body', '/fake/repo', 'src/auth/y.ts');
    expect(t.moduleAccessWindow).toHaveLength(15);
  });
});

// ============================================================================
// Panic — score accumulation and level transitions
// ============================================================================

describe('panic — score and level via updateTracker', () => {
  it('starts at panicScore 0, panicLevel 0', () => {
    const t = freshTracker();
    expect(t.panicScore).toBe(0);
    expect(t.panicLevel).toBe(0);
  });

  it('panicScore increases with oscillation', () => {
    const t = freshTracker();
    // Build A→B→A→B oscillation (bigram repetition) driving oscillation score up
    for (let i = 0; i < 15; i++) {
      const mod = i % 2 === 0 ? 'auth' : 'billing';
      updateTracker(t, 'search_code', '/fake/repo', `src/${mod}/x.ts`);
    }
    expect(t.panicScore).toBeGreaterThan(0);
  });

  it('panicLevel rises to 1 when panicScore >= 30', () => {
    const t = freshTracker();
    t.panicScore = 29;
    // One more call with high density should push it over 30
    t.moduleAccessWindow = ['auth','billing','auth','billing','auth','billing','auth','billing',
      'auth','billing','auth','billing','auth','billing','auth'] as (string|null)[];
    t.lastModule = 'auth';
    updateTracker(t, 'trace_execution_path', '/fake/repo', 'src/billing/x.ts');
    expect(t.panicLevel).toBeGreaterThanOrEqual(1);
  });

  it('staleDepth floors panicLevel via panic ceiling (staleDepth=3 → min L2)', () => {
    const t = freshTracker();
    t.panicScore = 0;
    // Force stale at depth 3
    t.freshnessState = 'stale';
    t.staleDepth = 3;
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    // Panic ceiling: staleDepth≥3 → panicLevel ≥ 2
    expect(t.panicLevel).toBeGreaterThanOrEqual(2);
  });

  it('panicLevel resets interventionCountSinceStable when dropping to 0', () => {
    const t = freshTracker();
    t.panicLevel = 1;
    t.panicScore = 5; // below down-threshold for L1 (20) → drops to L0
    t.interventionCountSinceStable = 5;
    updateTracker(t, 'list_spec_domains', '/fake/repo');
    expect(t.panicLevel).toBe(0);
    expect(t.interventionCountSinceStable).toBe(0);
  });

  it('localityConfidence near 1 at low density', () => {
    const t = freshTracker();
    updateTracker(t, 'search_code', '/fake/repo');
    expect(t.localityConfidence).toBeGreaterThan(0.9);
  });
});

// ============================================================================
// Panic — orient spam protection
// ============================================================================

describe('panic — orient spam protection', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('normal orient (>2min gap) applies -40 recovery', () => {
    const t = freshTracker();
    t.panicScore = 50;
    vi.advanceTimersByTime(3 * 60 * 1000); // 3min gap
    updateTracker(t, 'orient', '/fake/repo');
    expect(t.panicScore).toBe(10); // 50 - 40
  });

  it('rapid orient (<2min gap) applies only -15', () => {
    const t = freshTracker();
    t.panicScore = 50;
    // Simulate a prior orient 30s ago so the next orient is "rapid"
    t.lastOrientResetAt = Date.now() - 30_000;
    t.recentOrientCount = 1;
    updateTracker(t, 'orient', '/fake/repo');
    expect(t.panicScore).toBe(35); // 50 - 15
  });

  it('3rd+ rapid orient applies 0 recovery (spam)', () => {
    const t = freshTracker();
    t.panicScore = 50;
    // Simulate 2 prior rapid orients (count already 2)
    t.lastOrientResetAt = Date.now() - 30_000;
    t.recentOrientCount = 2;
    updateTracker(t, 'orient', '/fake/repo'); // count=3 → spam, delta=0
    expect(t.panicScore).toBe(50); // no change
  });

  it('non-rapid orient resets spam counter', () => {
    const t = freshTracker();
    t.panicScore = 50;
    // Simulate: spam state (2 rapid orients), last orient was 30s ago
    t.lastOrientResetAt = Date.now() - 30_000;
    t.recentOrientCount = 2;
    // Now advance 3min — next orient will be non-rapid
    vi.advanceTimersByTime(3 * 60 * 1000);
    updateTracker(t, 'orient', '/fake/repo'); // counter reset to 0, +1 = 1, non-rapid → -40
    expect(t.panicScore).toBe(10); // 50 - 40
    expect(t.recentOrientCount).toBe(1);
  });

  it('panicScore never goes below 0', () => {
    const t = freshTracker();
    t.panicScore = 10;
    vi.advanceTimersByTime(3 * 60 * 1000);
    updateTracker(t, 'orient', '/fake/repo'); // -40 would give -30, clamped to 0
    expect(t.panicScore).toBe(0);
  });
});

// ============================================================================
// trackerToPanicState
// ============================================================================

describe('trackerToPanicState', () => {
  it('maps tracker fields to PanicState correctly', () => {
    const t = freshTracker();
    t.panicScore = 42;
    t.panicLevel = 1;
    t.localityConfidence = 0.8;
    t.recentOrientCount = 2;
    t.interventionCountSinceStable = 1;

    const state = trackerToPanicState(t, 'claude-code', 'sess-123');

    expect(state.schemaVersion).toBe(1);
    expect(state.panicScore).toBe(42);
    expect(state.panicLevel).toBe(1);
    expect(state.localityConfidence).toBe(0.8);
    expect(state.recentOrientCount).toBe(2);
    expect(state.interventionCountSinceStable).toBe(1);
    expect(state.agentId).toBe('claude-code');
    expect(state.sessionId).toBe('sess-123');
    expect(state.updatedAt).toBeTruthy();
    expect(state.lastOrientAt).toBeTruthy();
  });

  it('agentId and sessionId are optional', () => {
    const t = freshTracker();
    const state = trackerToPanicState(t);
    expect(state.agentId).toBeUndefined();
    expect(state.sessionId).toBeUndefined();
  });
});
