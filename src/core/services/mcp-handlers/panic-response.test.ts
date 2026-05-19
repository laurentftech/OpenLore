/**
 * Tests for panic-response.ts
 *   - applyPanicHysteresis
 *   - readPanicState / writePanicState
 *   - buildPanicCheckOutput
 *   - getPanicSignalText
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyPanicHysteresis,
  defaultPanicState,
  readPanicState,
  writePanicState,
  buildPanicCheckOutput,
  getPanicSignalText,
} from './panic-response.js';
import type { PanicState, PanicLevel } from './panic-response.js';
import { OPENLORE_DIR } from '../../../constants.js';

// ============================================================================
// applyPanicHysteresis
// ============================================================================

describe('applyPanicHysteresis', () => {
  it('stays 0 below up-threshold', () => {
    expect(applyPanicHysteresis(0, 29, 0)).toBe(0);
  });

  it('transitions 0→1 at score 30', () => {
    expect(applyPanicHysteresis(0, 30, 0)).toBe(1);
  });

  it('transitions 1→2 at score 50', () => {
    expect(applyPanicHysteresis(1, 50, 0)).toBe(2);
  });

  it('transitions 2→3 at score 70', () => {
    expect(applyPanicHysteresis(2, 70, 0)).toBe(3);
  });

  it('L3→L4 requires staleDepth ≥ 3', () => {
    expect(applyPanicHysteresis(3, 90, 2)).toBe(3); // score meets threshold but stale too low
    expect(applyPanicHysteresis(3, 90, 3)).toBe(4);
  });

  it('does not downgrade when score above down-threshold', () => {
    expect(applyPanicHysteresis(2, 41, 0)).toBe(2); // down-threshold for L2 is 40
  });

  it('downgrade 2→1 when score below 40', () => {
    expect(applyPanicHysteresis(2, 39, 0)).toBe(1);
  });

  it('downgrade 3→2 when score below 60', () => {
    expect(applyPanicHysteresis(3, 59, 0)).toBe(2);
  });

  it('no simultaneous up and down transition', () => {
    // score 30 → up to 1; no further down in same call
    expect(applyPanicHysteresis(0, 30, 0)).toBe(1);
  });

  it('panic ceiling: staleDepth ≥ 3 floors minimum at L2', () => {
    // even score 0 → at least L2 when staleDepth=3
    expect(applyPanicHysteresis(0, 0, 3)).toBe(2);
  });

  it('panic ceiling: staleDepth ≥ 2 floors minimum at L1', () => {
    expect(applyPanicHysteresis(0, 0, 2)).toBe(1);
  });

  it('panic ceiling: staleDepth 0 no floor', () => {
    expect(applyPanicHysteresis(0, 0, 0)).toBe(0);
  });

  it('L4 stays at L4 — no upward beyond max', () => {
    expect(applyPanicHysteresis(4, 100, 3)).toBe(4);
  });
});

// ============================================================================
// readPanicState / writePanicState
// ============================================================================

describe('readPanicState', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-panic-test-'));
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
  });

  it('returns defaultPanicState when file missing (fail-open)', () => {
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
    expect(state.panicScore).toBe(0);
    expect(state.schemaVersion).toBe(1);
  });

  it('returns defaultPanicState on parse error (fail-open)', async () => {
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), 'not-json', 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
  });

  it('returns defaultPanicState on wrong schema version (fail-open)', async () => {
    const bad = JSON.stringify({ schemaVersion: 99, panicScore: 80, panicLevel: 3, updatedAt: new Date().toISOString() });
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), bad, 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
  });

  it('returns defaultPanicState when session expired (>30min)', async () => {
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const expired: PanicState = { ...defaultPanicState(), panicScore: 80, panicLevel: 3, updatedAt: old, lastOrientAt: old };
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), JSON.stringify(expired), 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
  });

  it('round-trips state within session', () => {
    const initial: PanicState = {
      ...defaultPanicState(),
      panicScore: 55,
      panicLevel: 2,
      triggers: ['oscillation'],
    };
    writePanicState(dir, initial);
    const read = readPanicState(dir);
    expect(read.panicScore).toBe(55);
    expect(read.panicLevel).toBe(2);
    expect(read.triggers).toEqual(['oscillation']);
  });
});

// ============================================================================
// buildPanicCheckOutput
// ============================================================================

describe('buildPanicCheckOutput', () => {
  it('returns allow at level 0', () => {
    const out = buildPanicCheckOutput(defaultPanicState());
    expect(out.decision).toBe('allow');
    expect(out.severity).toBeUndefined();
  });

  it('returns warn at level 1 with no prior intervention', () => {
    const state: PanicState = { ...defaultPanicState(), panicLevel: 1 };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('warn');
    expect(out.severity).toBe('elevated');
    expect(out.message).toContain('[PANIC:ELEVATED]');
  });

  it('returns allow when within L1 cooldown (120s)', () => {
    const recentIntervention = new Date(Date.now() - 60_000).toISOString(); // 60s ago < 120s cooldown
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 1,
      lastHookInterventionAt: recentIntervention,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('allow');
  });

  it('returns warn when L1 cooldown expired (>120s)', () => {
    const oldIntervention = new Date(Date.now() - 130_000).toISOString();
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 1,
      lastHookInterventionAt: oldIntervention,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('warn');
  });

  it('L4 always fires regardless of cooldown', () => {
    const recentIntervention = new Date(Date.now() - 1_000).toISOString();
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 4,
      lastHookInterventionAt: recentIntervention,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('warn');
    expect(out.severity).toBe('critical');
  });

  it('switches to directive message at interventionCountSinceStable ≥ 3', () => {
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 2,
      interventionCountSinceStable: 3,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.message).toContain('[PANIC:PLANNING:DIRECTIVE]');
  });

  it('uses advisory message at interventionCountSinceStable < 3', () => {
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 2,
      interventionCountSinceStable: 2,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.message).toContain('[PANIC:PLANNING]');
    expect(out.message).not.toContain('DIRECTIVE');
  });

  it('severity map: L1→elevated, L2→panic, L3→scope, L4→critical', () => {
    const levels: [PanicLevel, string][] = [[1, 'elevated'], [2, 'panic'], [3, 'scope'], [4, 'critical']];
    for (const [level, expected] of levels) {
      const state: PanicState = { ...defaultPanicState(), panicLevel: level };
      const out = buildPanicCheckOutput(state);
      expect(out.severity).toBe(expected);
    }
  });
});

// ============================================================================
// getPanicSignalText
// ============================================================================

describe('getPanicSignalText', () => {
  it('returns null at level 0', () => {
    expect(getPanicSignalText(defaultPanicState())).toBeNull();
  });

  it('returns advisory text at level 1', () => {
    const state: PanicState = { ...defaultPanicState(), panicLevel: 1 };
    const text = getPanicSignalText(state);
    expect(text).not.toBeNull();
    expect(text).toContain('[PANIC:ELEVATED]');
  });

  it('returns directive text when interventionCountSinceStable ≥ 3', () => {
    const state: PanicState = { ...defaultPanicState(), panicLevel: 3, interventionCountSinceStable: 3 };
    const text = getPanicSignalText(state);
    expect(text).toContain('DIRECTIVE');
  });
});
