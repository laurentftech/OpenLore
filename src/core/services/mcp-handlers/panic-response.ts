/**
 * Panic Response Layer — behavioral destabilization detection.
 *
 * Separate from EpistemicLease (freshness = epistemic authority decay).
 * Panic = observable behavioral instability: oscillation, trajectory bursts,
 * repeated stale-depth-3 persistence.
 *
 * State file: .openlore/panic-state.json (atomic writes, fail-open reads).
 * Hook consumer: `openlore panic-check` reads this file before every agent tool call.
 */

import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../../constants.js';
import {
  PANIC_UP_THRESHOLD,
  PANIC_DOWN_THRESHOLD,
  HOOK_COOLDOWN_MS,
  SEVERITY_MAP,
  PANIC_SESSION_EXPIRY_MS,
} from './panic-constants.js';

// ============================================================================
// TYPES
// ============================================================================

export type PanicLevel = 0 | 1 | 2 | 3 | 4;

export interface PanicState {
  schemaVersion: 1;
  panicScore: number;
  panicLevel: PanicLevel;
  updatedAt: string;
  lastOrientAt: string;
  lastHookInterventionAt?: string;
  recentOrientCount: number;
  localityConfidence: number;
  interventionCountSinceStable: number;
  triggers: string[];
  /** ISO — upward signals suppressed until this timestamp after an orient() recovery. */
  panicRecoverySuppressionUntil?: string;
  agentId?: string;
  sessionId?: string;
}

export interface PanicCheckOutput {
  decision: 'allow' | 'warn';
  severity?: 'elevated' | 'panic' | 'scope' | 'critical';
  message?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PANIC_STATE_FILE = 'panic-state.json';

// ============================================================================
// HYSTERESIS
// ============================================================================

export function applyPanicHysteresis(current: PanicLevel, score: number, staleDepth: number): PanicLevel {
  let level = current;

  // Attempt upward transition
  if (level < 4) {
    if (level === 3) {
      // L3→L4 requires both score threshold AND staleDepth ≥ 3
      if (score >= PANIC_UP_THRESHOLD[3] && staleDepth >= 3) level = 4;
    } else {
      if (score >= PANIC_UP_THRESHOLD[level]) level = (level + 1) as PanicLevel;
    }
  }

  // Attempt downward transition (only if we did not just go up)
  if (level === current && level > 0) {
    if (score < PANIC_DOWN_THRESHOLD[level]) level = (level - 1) as PanicLevel;
  }

  // Panic ceiling: stale depth floors minimum level
  const minLevel: PanicLevel = staleDepth >= 3 ? 2 : staleDepth >= 2 ? 1 : 0;
  return Math.max(level, minLevel) as PanicLevel;
}

// ============================================================================
// STATE I/O
// ============================================================================

export function defaultPanicState(): PanicState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    panicScore: 0,
    panicLevel: 0,
    updatedAt: now,
    lastOrientAt: now,
    recentOrientCount: 0,
    localityConfidence: 0,
    interventionCountSinceStable: 0,
    triggers: [],
  };
}

/**
 * Reads panic state. Fails open on all error paths:
 * missing file, parse error, wrong schema version, expired session.
 */
export function readPanicState(directory: string): PanicState {
  try {
    const path = join(directory, OPENLORE_DIR, PANIC_STATE_FILE);
    if (!existsSync(path)) return defaultPanicState();

    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PanicState>;

    if (parsed.schemaVersion !== 1) return defaultPanicState();

    // Session hard reset: zombie state from a previous session must not leak
    if (parsed.updatedAt) {
      const age = Date.now() - new Date(parsed.updatedAt).getTime();
      if (age > PANIC_SESSION_EXPIRY_MS) return defaultPanicState();
    }

    return { ...defaultPanicState(), ...parsed, schemaVersion: 1 };
  } catch {
    return defaultPanicState();
  }
}

/**
 * Atomically writes panic state. POSIX rename(2) is atomic on same filesystem.
 * Never throws — must not crash the hot path.
 */
export function writePanicState(directory: string, state: PanicState): void {
  try {
    const path = join(directory, OPENLORE_DIR, PANIC_STATE_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch {
    // never crash the hot path
  }
}

// ============================================================================
// PANIC CHECK OUTPUT (hook response builder)
// ============================================================================

const ADVISORY_MESSAGES: Record<PanicLevel, string> = {
  0: '',
  1: '[PANIC:ELEVATED] Recent navigation suggests increasing architectural uncertainty.\nConsider: summarize current assumptions, identify uncertain dependencies, call orient().',
  2: '[PANIC:PLANNING] Before cross-module modification, state:\n1. Intended architectural impact  2. Modules affected  3. Rollback strategy\nThen proceed.',
  3: '[PANIC:SCOPE] Cross-module writes discouraged until orient().\nPrefer local changes. orient() expands operational scope.',
  4: '[PANIC:CRITICAL] Critical epistemic instability. Call orient() before further modifications.',
};

const DIRECTIVE_MESSAGES: Record<PanicLevel, string> = {
  0: '',
  1: '[PANIC:ELEVATED:DIRECTIVE] Previous checkpoint ignored. Stop and call orient() now.',
  2: '[PANIC:PLANNING:DIRECTIVE] Previous checkpoint ignored. Stop. Run orient() now before proceeding.',
  3: '[PANIC:SCOPE:DIRECTIVE] Scope reduction warning ignored. Stop all cross-module writes. Call orient() immediately.',
  4: '[PANIC:CRITICAL] Critical epistemic instability. Call orient() before further modifications.',
};

/**
 * Builds the structured output for the panic-check CLI hook consumer.
 * Always exits 0 — severity encoded in payload, not exit code.
 * Applies per-level cooldown: no-ops if intervention fired recently.
 */
export function buildPanicCheckOutput(state: PanicState): PanicCheckOutput {
  if (state.panicLevel === 0) return { decision: 'allow' };

  // Apply cooldown (L4 is exempt — always fires)
  if (state.panicLevel < 4 && state.lastHookInterventionAt) {
    const elapsed = Date.now() - new Date(state.lastHookInterventionAt).getTime();
    if (elapsed < HOOK_COOLDOWN_MS[state.panicLevel]) return { decision: 'allow' };
  }

  const isDirective = state.interventionCountSinceStable >= 3;
  const messages = isDirective ? DIRECTIVE_MESSAGES : ADVISORY_MESSAGES;
  const message = messages[state.panicLevel];

  return {
    decision: 'warn',
    severity: SEVERITY_MAP[state.panicLevel],
    message,
  };
}

/**
 * Returns panic signal text for MCP tool response injection.
 * Appended after result (not prepended) to preserve JSON structure.
 */
export function getPanicSignalText(state: PanicState): string | null {
  if (state.panicLevel === 0) return null;
  const isDirective = state.interventionCountSinceStable >= 3;
  const messages = isDirective ? DIRECTIVE_MESSAGES : ADVISORY_MESSAGES;
  return messages[state.panicLevel] ?? null;
}
