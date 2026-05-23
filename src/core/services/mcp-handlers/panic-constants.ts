/**
 * Panic Response Layer — centralized constants.
 *
 * Single source of truth for all numeric thresholds, weights, cooldowns, and
 * timing values used across the panic subsystem (panic-response.ts,
 * epistemic-lease.ts). Exported so tests can reference these values directly
 * rather than hard-coding snapshots that silently diverge.
 */

import type { PanicLevel } from './panic-response.js';
import type { PanicCheckOutput } from './panic-response.js';

// ============================================================================
// HYSTERESIS THRESHOLDS
// ============================================================================

/** Score required to transition upward from level N to N+1. */
export const PANIC_UP_THRESHOLD: Record<number, number> = {
  0: 30,
  1: 50,
  2: 70,
  3: 90,
};

/** Score below which level N drops to N−1. Separate from UP to prevent thrashing. */
export const PANIC_DOWN_THRESHOLD: Record<number, number> = {
  1: 20,
  2: 40,
  3: 60,
  4: 80,
};

// ============================================================================
// SIGNAL WEIGHTS
// ============================================================================

/** Trajectory burst signal: density ≥ threshold fires this delta. */
export const PANIC_TRAJECTORY_DENSITY  = 0.60;
export const PANIC_TRAJECTORY_DELTA    = 15;

/** Oscillation spike signal: oscillation ≥ threshold fires this delta. */
export const PANIC_OSCILLATION_THRESHOLD = 0.50;
export const PANIC_OSCILLATION_DELTA     = 10;

/** Stale-depth-3 persistence signal (gated by localityConfidence < threshold). */
export const PANIC_STALE_D3_LOCALITY_GATE = 0.5;
export const PANIC_STALE_D3_DELTA         = 25;

/** Locality recovery: per-call score reduction when agent is stable. */
export const PANIC_LOCALITY_RECOVERY = 3;

/** Passive wall-clock decay: score reduction per elapsed minute. */
export const PANIC_DECAY_PER_MIN = 5;

/** Hard ceiling on panic score. */
export const PANIC_SCORE_MAX = 100;

// ============================================================================
// TIMING
// ============================================================================

/** Post-orient() refractory window — upward signals suppressed for this long. */
export const PANIC_REFRACTORY_MS = 45_000;

/** Session expiry — panic state older than this is discarded on read. */
export const PANIC_SESSION_EXPIRY_MS = 30 * 60 * 1000;

// ============================================================================
// HOOK COOLDOWNS
// ============================================================================

/**
 * Minimum ms between hook interventions per panic level.
 * Prevents context saturation and habituation from repeated injection.
 * L4 = 0: every tool call warned at critical level.
 */
export const HOOK_COOLDOWN_MS: Record<PanicLevel, number> = {
  0: 0,
  1: 120_000,
  2: 60_000,
  3: 30_000,
  4: 0,
};

// ============================================================================
// GRYPH SIGNAL WEIGHTS
// ============================================================================

/** Repetitive retry burst (low entropy + failing commands). */
export const GRYPH_RETRY_BURST_DELTA = 15;

/** Large patch while stale, low command entropy (non-deliberate). */
export const GRYPH_LARGE_PATCH_LOW_ENTROPY_DELTA = 30;

/** Large patch while stale, high command entropy (deliberate refactor — attenuated). */
export const GRYPH_LARGE_PATCH_HIGH_ENTROPY_DELTA = 10;

/** LOC threshold for "large patch" classification. */
export const GRYPH_LARGE_PATCH_LOC_THRESHOLD = 500;

/** Command entropy below this = low-diversity / retry loop. */
export const GRYPH_ENTROPY_LOW_THRESHOLD = 0.30;

/** Command entropy above this = deliberate exploratory work (attenuation gate). */
export const GRYPH_ENTROPY_HIGH_THRESHOLD = 0.60;

/** Failure rate above this triggers burst signal regardless of entropy (mixed-window robustness). */
export const GRYPH_FAILING_RATE_THRESHOLD = 0.30;

// ============================================================================
// GRYPH POLLING
// ============================================================================

/** Default poll interval for background Gryph behavioral ingestion. */
export const GRYPH_POLL_INTERVAL_MS = 15_000;

/** Minimum allowed poll interval (env override floor). */
export const GRYPH_POLL_INTERVAL_MIN_MS = 5_000;

// ============================================================================
// SEVERITY MAP
// ============================================================================

export const SEVERITY_MAP: Record<PanicLevel, PanicCheckOutput['severity']> = {
  0: undefined,
  1: 'elevated',
  2: 'panic',
  3: 'scope',
  4: 'critical',
};
