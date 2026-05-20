/**
 * Validates panic/lease telemetry metric aggregation with synthetic JSONL events.
 * Tests computePanicStats, computeRecovery, computeObstinacy directly.
 */

import { describe, it, expect } from 'vitest';
import { computePanicStats, computeRecovery, computeObstinacy } from './telemetry.js';
import type { PanicEvent, LeaseEvent, McpEvent } from './telemetry.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function ts(offsetMs: number = 0): string {
  return new Date(1_700_000_000_000 + offsetMs).toISOString();
}

function levelChange(from: number, to: number, offsetMs: number, extra?: Partial<PanicEvent>): PanicEvent {
  return { ts: ts(offsetMs), event: 'panic_level_change', from_level: from, to_level: to, ...extra };
}

function orientReset(kind: 'normal' | 'rapid' | 'spam', offsetMs: number): PanicEvent {
  return { ts: ts(offsetMs), event: 'panic_orient_reset', orient_kind: kind };
}

function hookIntervention(offsetMs: number, gryph = false, count = 1): PanicEvent {
  return { ts: ts(offsetMs), event: 'hook_intervention', intervention_count: count, gryph_enriched: gryph };
}

function injection(offsetMs: number): PanicEvent {
  return { ts: ts(offsetMs), event: 'panic_signal_injected' };
}

// ── computePanicStats ────────────────────────────────────────────────────────

describe('computePanicStats', () => {
  it('returns zeros on empty input', () => {
    const r = computePanicStats([]);
    expect(r.panic_episodes).toBe(0);
    expect(r.avg_recovery_ms).toBeNull();
    expect(r.failed_recovery_rate).toBe('—');
    expect(r.hook_intercepts).toBe(0);
    expect(r.mcp_injections).toBe(0);
    expect(r.orient_spam_events).toBe(0);
    expect(r.orient_rapid_events).toBe(0);
    expect(r.gryph_enriched_intercepts).toBe(0);
    expect(r.trigger_counts).toHaveLength(0);
  });

  it('counts a completed episode (0→L2→0)', () => {
    const events: PanicEvent[] = [
      levelChange(0, 2, 0),
      levelChange(2, 0, 60_000),
    ];
    const r = computePanicStats(events);
    expect(r.panic_episodes).toBe(1);
    expect(r.avg_recovery_ms).toBe(60_000);
    expect(r.failed_recovery_rate).toBe('0/1');
  });

  it('measures avg recovery latency over multiple completed episodes', () => {
    const events: PanicEvent[] = [
      levelChange(0, 1, 0),
      levelChange(1, 0, 30_000),       // 30s episode
      levelChange(0, 3, 100_000),
      levelChange(3, 0, 190_000),      // 90s episode
    ];
    const r = computePanicStats(events);
    expect(r.panic_episodes).toBe(2);
    expect(r.avg_recovery_ms).toBe(60_000);  // (30000 + 90000) / 2
  });

  it('tracks peak level within an episode', () => {
    // level escalates within episode
    const events: PanicEvent[] = [
      levelChange(0, 1, 0),
      levelChange(1, 3, 10_000),   // escalation mid-episode
      levelChange(3, 0, 60_000),
    ];
    const r = computePanicStats(events);
    expect(r.panic_episodes).toBe(1);
    expect(r.failed_recovery_rate).toBe('0/1');
  });

  it('counts failed recovery: episode with no return to L0', () => {
    const events: PanicEvent[] = [
      levelChange(0, 2, 0),
      // no return to 0
    ];
    const r = computePanicStats(events);
    expect(r.panic_episodes).toBe(1);
    expect(r.failed_recovery_rate).toBe('1/1');
    expect(r.avg_recovery_ms).toBeNull();  // no completed episodes
  });

  it('mixed: 1 completed + 1 failed → correct rate and avg', () => {
    const events: PanicEvent[] = [
      levelChange(0, 2, 0),
      levelChange(2, 0, 45_000),   // completed: 45s
      levelChange(0, 3, 200_000),  // new episode, never closes
    ];
    const r = computePanicStats(events);
    expect(r.panic_episodes).toBe(2);
    expect(r.failed_recovery_rate).toBe('1/2');
    expect(r.avg_recovery_ms).toBe(45_000);  // only completed episode
  });

  it('counts hook intercepts and mcp injections', () => {
    const events: PanicEvent[] = [
      hookIntervention(0),
      hookIntervention(5_000),
      injection(10_000),
      injection(15_000),
      injection(20_000),
    ];
    const r = computePanicStats(events);
    expect(r.hook_intercepts).toBe(2);
    expect(r.mcp_injections).toBe(3);
  });

  it('counts orient spam and rapid events', () => {
    const events: PanicEvent[] = [
      orientReset('normal', 0),
      orientReset('rapid', 30_000),
      orientReset('rapid', 60_000),
      orientReset('spam', 90_000),
      orientReset('spam', 120_000),
    ];
    const r = computePanicStats(events);
    expect(r.orient_spam_events).toBe(2);
    expect(r.orient_rapid_events).toBe(2);
  });

  it('counts gryph-enriched hook intercepts', () => {
    const events: PanicEvent[] = [
      hookIntervention(0, false),
      hookIntervention(5_000, true),
      hookIntervention(10_000, true),
    ];
    const r = computePanicStats(events);
    expect(r.hook_intercepts).toBe(3);
    expect(r.gryph_enriched_intercepts).toBe(2);
  });

  it('aggregates trigger frequency from call_triggers', () => {
    const events: PanicEvent[] = [
      { ts: ts(0),      event: 'hook_intervention', call_triggers: ['trajectory_burst', 'oscillation_spike'] },
      { ts: ts(5_000),  event: 'hook_intervention', call_triggers: ['trajectory_burst'] },
      { ts: ts(10_000), event: 'hook_intervention', call_triggers: ['stale_depth_3'] },
    ];
    const r = computePanicStats(events);
    const tmap = new Map(r.trigger_counts);
    expect(tmap.get('trajectory_burst')).toBe(2);
    expect(tmap.get('oscillation_spike')).toBe(1);
    expect(tmap.get('stale_depth_3')).toBe(1);
    // sorted descending by count
    expect(r.trigger_counts[0][0]).toBe('trajectory_burst');
  });

  it('handles level changes that arrive out of chronological order', () => {
    // sort should handle this
    const events: PanicEvent[] = [
      levelChange(2, 0, 60_000),   // end of episode (arrives first in array)
      levelChange(0, 2, 0),        // start
    ];
    const r = computePanicStats(events);
    expect(r.panic_episodes).toBe(1);
    expect(r.avg_recovery_ms).toBe(60_000);
    expect(r.failed_recovery_rate).toBe('0/1');
  });

  it('ignores non-level-change events for episode tracking', () => {
    const events: PanicEvent[] = [
      hookIntervention(0),
      orientReset('normal', 10_000),
      injection(20_000),
      // no level changes → no episodes
    ];
    const r = computePanicStats(events);
    expect(r.panic_episodes).toBe(0);
    expect(r.avg_recovery_ms).toBeNull();
  });
});

// ── computeRecovery ───────────────────────────────────────────────────────────

describe('computeRecovery', () => {
  function staleEvent(offsetMs: number): LeaseEvent {
    return { ts: ts(offsetMs), event: 'stale', depth: 1 };
  }
  function orientReset(offsetMs: number): LeaseEvent {
    return { ts: ts(offsetMs), event: 'orient_reset', prior_load: 0, prior_depth: 1 };
  }
  function orientCall(offsetMs: number): McpEvent {
    return { ts: ts(offsetMs), event: 'tool_call', tool: 'orient', ms: 50 };
  }
  function toolCall(name: string, offsetMs: number): McpEvent {
    return { ts: ts(offsetMs), event: 'tool_call', tool: name, ms: 20 };
  }
  function degraded(offsetMs: number): LeaseEvent {
    return { ts: ts(offsetMs), event: 'degraded' };
  }

  it('computes avg stale→orient latency', () => {
    const lease: LeaseEvent[] = [staleEvent(0)];
    const mcp: McpEvent[] = [orientCall(45_000)];
    const r = computeRecovery(mcp, lease);
    expect(r.avg_recovery_ms).toBe(45_000);
    expect(r.stale_events).toBe(1);
    expect(r.orient_calls).toBe(1);
  });

  it('averages latency over multiple stale→orient pairs', () => {
    const lease: LeaseEvent[] = [staleEvent(0), staleEvent(100_000)];
    const mcp: McpEvent[] = [orientCall(60_000), orientCall(130_000)];
    const r = computeRecovery(mcp, lease);
    expect(r.avg_recovery_ms).toBe(45_000); // (60000 + 30000) / 2
  });

  it('returns null avg when no stale event has a subsequent orient', () => {
    const lease: LeaseEvent[] = [staleEvent(100_000)];
    const mcp: McpEvent[] = [orientCall(0)]; // orient before stale
    const r = computeRecovery(mcp, lease);
    expect(r.avg_recovery_ms).toBeNull();
  });

  it('computes recovery half-life (orient_reset → next degradation)', () => {
    const lease: LeaseEvent[] = [orientReset(0), degraded(90_000)];
    const mcp: McpEvent[] = [];
    const r = computeRecovery(mcp, lease);
    expect(r.avg_stable_after_orient_ms).toBe(90_000);
  });

  it('returns null half-life when no degradation follows reset', () => {
    const lease: LeaseEvent[] = [orientReset(0)];
    const mcp: McpEvent[] = [];
    const r = computeRecovery(mcp, lease);
    expect(r.avg_stable_after_orient_ms).toBeNull();
  });

  it('computes correct recurrence rate', () => {
    const lease: LeaseEvent[] = [staleEvent(0), staleEvent(200_000)];
    const mcp: McpEvent[] = [orientCall(100_000)];
    const r = computeRecovery(mcp, lease);
    expect(r.stale_events).toBe(2);
    expect(r.orient_calls).toBe(1);
    expect(r.recurrence_rate).toBe('2.00 stale/orient');
  });

  it('returns — for recurrence rate when no orients', () => {
    const lease: LeaseEvent[] = [staleEvent(0)];
    const mcp: McpEvent[] = [];
    const r = computeRecovery(mcp, lease);
    expect(r.recurrence_rate).toBe('—');
  });
});

// ── computeObstinacy ─────────────────────────────────────────────────────────

describe('computeObstinacy', () => {
  function staleEvent(depth: number, offsetMs: number): LeaseEvent {
    return { ts: ts(offsetMs), event: 'stale', depth };
  }
  function orientResetEvent(offsetMs: number): LeaseEvent {
    return { ts: ts(offsetMs), event: 'orient_reset' };
  }
  function toolCall(name: string, offsetMs: number): McpEvent {
    return { ts: ts(offsetMs), event: 'tool_call', tool: name, ms: 10 };
  }

  it('returns zeros on empty input', () => {
    const r = computeObstinacy([], []);
    expect(r.total_stale_episodes).toBe(0);
    expect(r.avg_calls_before_orient).toBe('—');
  });

  it('counts tool calls between stale and orient_reset', () => {
    const lease: LeaseEvent[] = [staleEvent(1, 0), orientResetEvent(50_000)];
    const mcp: McpEvent[] = [
      toolCall('search_code',   10_000),
      toolCall('get_subgraph',  20_000),
      toolCall('orient',        50_000), // orient itself, counts as orient kind
    ];
    const r = computeObstinacy(mcp, lease);
    expect(r.total_stale_episodes).toBe(1);
    // 2 non-orient tool calls before orient_reset
    expect(r.episodes[0].calls_before_orient).toBe(2);
  });

  it('tracks max depth within episode', () => {
    const lease: LeaseEvent[] = [
      staleEvent(1, 0),
      staleEvent(2, 10_000),  // depth escalation mid-episode
      orientResetEvent(60_000),
    ];
    const mcp: McpEvent[] = [];
    const r = computeObstinacy(mcp, lease);
    expect(r.total_stale_episodes).toBe(1);
    expect(r.episodes[0].depth).toBe(2);
  });

  it('counts open episode (no orient at end) as last segment', () => {
    const lease: LeaseEvent[] = [staleEvent(1, 0)];
    const mcp: McpEvent[] = [
      toolCall('search_code', 10_000),
      toolCall('get_subgraph', 20_000),
    ];
    const r = computeObstinacy(mcp, lease);
    expect(r.total_stale_episodes).toBe(1);
    expect(r.episodes[0].calls_before_orient).toBe(2);
  });

  it('handles multiple separate stale episodes', () => {
    const lease: LeaseEvent[] = [
      staleEvent(1, 0),
      orientResetEvent(30_000),
      staleEvent(2, 60_000),
      orientResetEvent(90_000),
    ];
    const mcp: McpEvent[] = [
      toolCall('search_code', 10_000),
      toolCall('search_code', 70_000),
      toolCall('search_code', 80_000),
    ];
    const r = computeObstinacy(mcp, lease);
    expect(r.total_stale_episodes).toBe(2);
    expect(r.episodes[0].calls_before_orient).toBe(1);
    expect(r.episodes[1].calls_before_orient).toBe(2);
  });
});
