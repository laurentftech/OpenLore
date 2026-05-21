/**
 * Epistemic Lease — session-level architectural confidence decay for MCP agents.
 *
 * Models repository understanding as a temporary, degradable representation rather
 * than permanent truth. Injects freshness signals into every MCP tool response so
 * that agents drifting toward internally cached reasoning ("repo fiction") see
 * confidence decay even when they have stopped calling orient/graph tools.
 *
 * Decay triggers (any one sufficient):
 *   - Time: >15min → degraded, >30min → stale
 *   - Git hash divergence from orient baseline → immediate stale
 *   - Weighted cognitive load: >30 → degraded, >60 → stale
 *   - Cross-module trajectory density: ≥0.15 → degraded, ≥0.30 → stale
 *     Density = module switches in last 15 calls / window size.
 *     Each switch also adds +5 debt; high-density window +15; burst +20.
 *
 * Stale escalates through 3 depths to prevent warning blindness:
 *   - Depth 1 (load≥60, age≥30min): procedural — explains what NOT to do
 *   - Depth 2 (load≥85, age≥45min): risk-framing — names downstream consequences
 *   - Depth 3 (load≥110, age≥60min): imperative — minimal text, hardest to skim
 *
 * Injection:
 *   - fresh    → no injection (zero overhead)
 *   - degraded → 3-line signal appended (low friction)
 *   - stale    → depth-varying capability-invalidation block prepended
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_CALL_GRAPH_DB,
} from '../../../constants.js';
import { emit } from '../telemetry.js';
import { applyPanicHysteresis } from './panic-response.js';
import type { PanicLevel, PanicState } from './panic-response.js';

// ============================================================================
// TYPES
// ============================================================================

export type FreshnessState = 'fresh' | 'degraded' | 'stale';
export type StaleDepth = 1 | 2 | 3;

export interface EpistemicTracker {
  lastOrientAt: Date;
  graphVersionAtOrient: string;
  cognitiveLoad: number;
  modulesVisited: Set<string>;
  freshnessState: FreshnessState;
  /** Escalating severity within stale state. 0 when not stale. */
  staleDepth: 0 | StaleDepth;
  lastGitCheckAt: number;
  /** Top-level source directories derived from the actual project layout. */
  sourceRoots: string[];
  /** V3.1: last resolved module for switch detection. */
  lastModule: string | null;
  /** V3.1: sliding window of last N module accesses (null = no filePath on that call). */
  moduleAccessWindow: (string | null)[];
  /** V3.1: epoch ms of last density-bonus application (cooldown). */
  lastDensityPenaltyAt: number;
  /** V3.1: epoch ms of last module switch (dampening). */
  lastSwitchAt: number;
  /** V3.2: oscillation score — repeated bigram transitions / total transitions [0,1]. */
  oscillation: number;
  /** V3.2: last computed cross-module density [0,1] — stored so callers can read after updateTracker(). */
  density: number;
  // Panic fields — behavioral destabilization tracking (separate from freshness)
  panicScore: number;
  panicLevel: PanicLevel;
  localityConfidence: number;
  recentOrientCount: number;
  lastOrientResetAt: number;
  interventionCountSinceStable: number;
  /** Epoch ms of last panic score update — for passive decay calculation. */
  lastPanicUpdateAt: number;
  /** Accumulated signal trigger labels for the current panic episode. */
  panicTriggers: string[];
  /** Epoch ms — upward panic signals suppressed until this time after orient() recovery. */
  panicRecoverySuppressionUntil: number;
}

// ============================================================================
// TOOL COGNITIVE WEIGHTS
// Three tiers: lightweight ops (1-2), structural ops (3-5), architectural ops (8).
// ============================================================================

const TOOL_WEIGHTS: Record<string, number> = {
  // Resets tracker — not counted
  orient: 0,
  analyze_codebase: 0,

  // Lightweight: search / read operations
  search_code: 1,
  search_specs: 1,
  search_unified: 1,
  list_spec_domains: 1,
  list_decisions: 1,
  record_decision: 1,
  get_env_vars: 1,
  get_external_packages: 1,

  // Structural: function/file-level reads
  get_spec: 2,
  get_signatures: 2,
  get_function_body: 2,
  get_function_skeleton: 2,
  get_mapping: 2,
  get_test_coverage: 2,
  get_route_inventory: 2,
  get_schema_inventory: 2,
  get_ui_components: 2,
  get_middleware_inventory: 2,

  // Structural-heavy: graph and architecture reads
  get_architecture_overview: 3,
  get_call_graph: 3,
  get_file_dependencies: 3,
  get_critical_hubs: 3,
  get_god_functions: 3,
  get_leaf_functions: 3,
  get_refactor_report: 3,
  get_duplicate_report: 3,
  check_spec_drift: 3,
  detect_changes: 3,
  audit_spec_coverage: 3,
  get_decisions: 3,
  get_minimal_context: 3,

  // Graph traversal / cross-module
  get_subgraph: 5,
  analyze_impact: 5,
  get_cluster: 4,
  generate_change_proposal: 5,
  annotate_story: 5,
  generate_tests: 4,
  get_low_risk_refactor_candidates: 4,

  // Deep architectural tracing
  trace_execution_path: 8,
};

// ============================================================================
// THRESHOLDS
// ============================================================================

const DEGRADE_LOAD_THRESHOLD  = 30;
const STALE_LOAD_THRESHOLD    = 60;
const STALE_D2_LOAD_THRESHOLD = 85;
const STALE_D3_LOAD_THRESHOLD = 110;

const DEGRADE_AGE_MS  = 15 * 60 * 1000;
const STALE_AGE_MS    = 30 * 60 * 1000;
const STALE_D2_AGE_MS = 45 * 60 * 1000;
const STALE_D3_AGE_MS = 60 * 60 * 1000;

const GIT_CHECK_INTERVAL_MS    = 30_000;

// V3.1 cross-module trajectory model
const CROSS_MODULE_WINDOW_SIZE      = 15;
const CROSS_MODULE_DEGRADE_DENSITY  = 0.15;
const CROSS_MODULE_STALE_DENSITY    = 0.30;
const MODULE_SWITCH_BASE_WEIGHT     = 5;
const HIGH_DENSITY_DEBT_BONUS       = 15;
const BURST_DEBT_SPIKE              = 20;
const DENSITY_BONUS_COOLDOWN_MS     = 60_000;
const SWITCH_DAMPENING_MS           = 5_000;

// V3.2 oscillation model — detects back-and-forth (A→B→A→B) vs exploration
const BURST_DENSITY_THRESHOLD       = 0.60;  // density for post-stale burst escalation
const BURST_TOOL_WEIGHT_THRESHOLD   = 8;     // tool weight for post-stale burst escalation

// Panic constants
const RAPID_ORIENT_INTERVAL_MS      = 2 * 60 * 1000;  // orients within 2min are "rapid"
const PANIC_SCORE_MAX               = 100;
// Spec-correct panic signal thresholds
const PANIC_TRAJECTORY_DENSITY      = 0.60;  // trajectory burst → +15
const PANIC_OSCILLATION_THRESHOLD   = 0.50;  // oscillation spike → +10
const PANIC_DECAY_PER_MIN           = 5;     // passive wall-clock decay
const PANIC_LOCALITY_RECOVERY       = 3;     // per-call recovery when stable
const PANIC_REFRACTORY_MS           = 45_000; // post-orient suppression window (45s)

// ============================================================================
// PANIC UPDATE
// Called on every tool call with current density/oscillation signals.
// Score delta: positive from instability signals, negative from orient resets.
// ============================================================================

interface PanicProvenanceItem {
  name: string;
  delta: number;
  evidence: Record<string, number | string | boolean>;
}

export function updatePanic(
  tracker: EpistemicTracker,
  opts: { density: number; oscillation: number; weight: number; staleDepth: number; directory?: string; tool?: string },
): void {
  const { density, oscillation, staleDepth, directory = '', tool = '' } = opts;
  const now = Date.now();
  const inRefractory = tracker.panicRecoverySuppressionUntil > now;

  // Passive wall-clock decay: -5 per minute elapsed since last update
  const elapsedMin = tracker.lastPanicUpdateAt > 0
    ? Math.max(0, (now - tracker.lastPanicUpdateAt) / 60_000)
    : 0;
  const decayDelta = -Math.floor(elapsedMin * PANIC_DECAY_PER_MIN);

  let delta = decayDelta;
  const provenance: PanicProvenanceItem[] = [];
  if (decayDelta < 0) {
    provenance.push({ name: 'passive_decay', delta: decayDelta, evidence: { elapsed_min: Math.round(elapsedMin * 100) / 100 } });
  }

  // localityConfidence is computed in updateTracker() and stored in tracker.
  // Read it here so signal gating uses the current value.
  const localityConfidence = tracker.localityConfidence;

  // Upward signals — suppressed during refractory period after orient() recovery
  if (!inRefractory) {
    if (density >= PANIC_TRAJECTORY_DENSITY) {
      const d = 15;
      delta += d;
      provenance.push({ name: 'trajectory_burst', delta: d, evidence: { density } });
    }
    if (oscillation >= PANIC_OSCILLATION_THRESHOLD) {
      const d = 10;
      delta += d;
      provenance.push({ name: 'oscillation_spike', delta: d, evidence: { oscillation } });
    }
    // stale_depth_3 signal gated by localityConfidence: a stale agent doing focused local
    // work (high confidence) is much less risky than a stale agent in behavioral drift.
    if (staleDepth >= 3 && localityConfidence < 0.5) {
      const d = 25;
      delta += d;
      provenance.push({ name: 'stale_depth_3', delta: d, evidence: { stale_depth: staleDepth, locality_confidence: localityConfidence } });
    }
  }

  // Locality recovery — always applies, not gated by refractory
  if (density < 0.10 && oscillation < 0.10 && staleDepth === 0) {
    const d = -PANIC_LOCALITY_RECOVERY;
    delta += d;
    provenance.push({ name: 'locality_recovery', delta: d, evidence: { density, oscillation } });
  }

  const scoreBefore = tracker.panicScore;
  tracker.lastPanicUpdateAt = now;
  tracker.panicScore = Math.min(PANIC_SCORE_MAX, Math.max(0, tracker.panicScore + delta));

  // Accumulate trigger names for the current episode (upward signals only)
  const upwardTriggers = provenance.filter(p => p.delta > 0).map(p => p.name);
  for (const t of upwardTriggers) {
    if (!tracker.panicTriggers.includes(t)) tracker.panicTriggers.push(t);
  }

  const prevLevel = tracker.panicLevel;
  tracker.panicLevel = applyPanicHysteresis(tracker.panicLevel, tracker.panicScore, staleDepth);

  // Emit provenance trace whenever score changes with active signals
  if (tracker.panicScore !== scoreBefore && provenance.length > 0) {
    emit(directory, 'panic', {
      event: 'panic_score_delta',
      tool,
      score_before: scoreBefore,
      score_after: tracker.panicScore,
      delta,
      in_refractory: inRefractory,
      stale_depth: staleDepth,
      density,
      oscillation,
      triggers: provenance,
    });
  }

  if (tracker.panicLevel !== prevLevel) {
    const levelTrigger = staleDepth >= 2 && tracker.panicLevel > prevLevel ? 'ceiling' : 'score';
    emit(directory, 'panic', {
      event: 'panic_level_change',
      tool,
      from_level: prevLevel,
      to_level: tracker.panicLevel,
      score_before: scoreBefore,
      panic_score: tracker.panicScore,
      density,
      oscillation,
      stale_depth: staleDepth,
      in_refractory: inRefractory,
      trigger: levelTrigger,
      provenance,
    });
  }

  if (tracker.panicLevel === 0 && prevLevel > 0) {
    tracker.interventionCountSinceStable = 0;
    tracker.panicTriggers = [];
  }
}

// ============================================================================
// GIT HASH
// ============================================================================

function getGitHash(directory: string): string {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: directory,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return result.stdout?.trim() ?? '';
  } catch {
    return '';
  }
}

// ============================================================================
// MODULE EXTRACTION
// Extract top-level module segment from a file path, using the source root
// directories derived from the call-graph db (files actually analyzed, already
// filtered by config include/exclude patterns).
//
//   src/core/services/mcp.ts → root "src" → module "core"
//   packages/auth/src/jwt.ts → root "packages" → module "auth"
//
// Returns [] when no analysis exists yet — module tracking stays silent rather
// than tracking arbitrary filesystem dirs as if they were analyzed modules.
// ============================================================================

export function getSourceRoots(directory: string): string[] {
  try {
    const dbPath = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_CALL_GRAPH_DB);
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT DISTINCT file_path FROM nodes WHERE is_external = 0').all() as Array<{ file_path: string }>;
    db.close();
    const roots = new Set<string>();
    for (const { file_path } of rows) {
      const first = file_path.split(/[/\\]/)[0];
      if (first) roots.add(first);
    }
    return [...roots];
  } catch {
    return [];
  }
}

function moduleFromPath(filePath: string, sourceRoots: string[]): string | null {
  const parts = filePath.split(/[/\\]/);
  for (const root of sourceRoots) {
    const idx = parts.indexOf(root);
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }
  return null;
}

// ============================================================================
// CROSS-MODULE DENSITY
// Counts module transitions in the sliding window, skipping null entries.
// Denominator is total window length so non-file calls dilute density.
// ============================================================================

function computeCrossModuleDensity(window: (string | null)[]): number {
  if (window.length < 2) return 0;
  let switches = 0;
  let prev: string | null = null;
  for (const mod of window) {
    if (mod !== null) {
      if (prev !== null && mod !== prev) switches++;
      prev = mod;
    }
  }
  // Fixed denominator = window capacity so early-session (small window) doesn't
  // produce inflated density — density only reaches threshold after real accumulation.
  return switches / CROSS_MODULE_WINDOW_SIZE;
}

// ============================================================================
// OSCILLATION SCORE
// Bigram repetition ratio: how often the module 2 calls ago reappears.
// A→B→A→B→A scores 1.0 (pure confusion loop); A→B→C→D→E scores 0.0.
// Fixed denominator = window entries ≥ 3 so early-session doesn't spike.
// ============================================================================

function computeOscillationScore(window: (string | null)[]): number {
  const modules = window.filter((m): m is string => m !== null);
  if (modules.length < 3) return 0;
  // Compute over transition sequence (entries where module actually changed).
  // A→A→A→A → 0 transitions → oscillation = 0 (focused local work, not confusion).
  // A→B→A→B → transitions [A,B,A,B] → oscillation = 1.0 (pure confusion loop).
  const transitions: string[] = [modules[0]!];
  for (let i = 1; i < modules.length; i++) {
    if (modules[i] !== modules[i - 1]) transitions.push(modules[i]!);
  }
  if (transitions.length < 3) return 0;
  let repeated = 0;
  for (let i = 2; i < transitions.length; i++) {
    if (transitions[i] === transitions[i - 2]) repeated++;
  }
  return repeated / (transitions.length - 2);
}

// ============================================================================
// STALE DEPTH
// Monotonic — depth can only increase, never decrease until orient() reset.
// ============================================================================

function computeStaleDepth(load: number, ageMs: number): StaleDepth {
  if (load >= STALE_D3_LOAD_THRESHOLD || ageMs >= STALE_D3_AGE_MS) return 3;
  if (load >= STALE_D2_LOAD_THRESHOLD || ageMs >= STALE_D2_AGE_MS) return 2;
  return 1;
}

// ============================================================================
// TRACKER LIFECYCLE
// ============================================================================

export function createTracker(directory: string): EpistemicTracker {
  return {
    lastOrientAt: new Date(),
    graphVersionAtOrient: getGitHash(directory),
    cognitiveLoad: 0,
    modulesVisited: new Set(),
    freshnessState: 'fresh',
    staleDepth: 0,
    lastGitCheckAt: Date.now(),
    sourceRoots: getSourceRoots(directory),
    lastModule: null,
    moduleAccessWindow: [],
    lastDensityPenaltyAt: 0,
    lastSwitchAt: 0,
    oscillation: 0,
    density: 0,
    panicScore: 0,
    panicLevel: 0,
    localityConfidence: 1,
    recentOrientCount: 0,
    lastOrientResetAt: 0,
    interventionCountSinceStable: 0,
    lastPanicUpdateAt: 0,
    panicTriggers: [],
    panicRecoverySuppressionUntil: 0,
  };
}

function resetTracker(tracker: EpistemicTracker, directory: string): void {
  const now = Date.now();

  // Panic: orient spam protection — diminishing recovery bonus on rapid reuse
  const timeSinceLastOrient = now - tracker.lastOrientResetAt;
  if (timeSinceLastOrient >= RAPID_ORIENT_INTERVAL_MS) {
    tracker.recentOrientCount = 0; // non-rapid: reset spam counter
  }
  tracker.recentOrientCount++;
  tracker.lastOrientResetAt = now;

  let panicDelta: number;
  let orientKind: 'normal' | 'rapid' | 'spam';
  if (tracker.recentOrientCount >= 3) {
    panicDelta = 0;   orientKind = 'spam';
  } else if (timeSinceLastOrient < RAPID_ORIENT_INTERVAL_MS) {
    panicDelta = -15; orientKind = 'rapid';
  } else {
    panicDelta = -40; orientKind = 'normal';
  }

  const prevScore = tracker.panicScore;
  const prevLevel = tracker.panicLevel;
  tracker.panicScore = Math.min(PANIC_SCORE_MAX, Math.max(0, tracker.panicScore + panicDelta));
  tracker.localityConfidence = 1;
  tracker.panicLevel = applyPanicHysteresis(tracker.panicLevel, tracker.panicScore, 0);
  if (tracker.panicLevel === 0) {
    tracker.interventionCountSinceStable = 0;
    tracker.panicTriggers = [];
  }
  // Set refractory window when orient() achieves actual score reduction.
  // Suppresses upward signals for 45s to let recovery land before re-escalating.
  if (panicDelta < 0) {
    tracker.panicRecoverySuppressionUntil = now + PANIC_REFRACTORY_MS;
  }

  emit(directory, 'panic', {
    event: 'panic_orient_reset',
    orient_kind: orientKind,
    delta: panicDelta,
    from_score: prevScore,
    to_score: tracker.panicScore,
    from_level: prevLevel,
    to_level: tracker.panicLevel,
    recent_orient_count: tracker.recentOrientCount,
    time_since_last_ms: tracker.lastOrientResetAt === now ? timeSinceLastOrient : 0,
  });

  tracker.lastOrientAt = new Date();
  tracker.graphVersionAtOrient = getGitHash(directory);
  tracker.cognitiveLoad = 0;
  tracker.modulesVisited = new Set();
  tracker.freshnessState = 'fresh';
  tracker.staleDepth = 0;
  tracker.lastGitCheckAt = now;
  tracker.lastModule = null;
  tracker.moduleAccessWindow = [];
  tracker.lastDensityPenaltyAt = 0;
  tracker.lastSwitchAt = 0;
  tracker.oscillation = 0;
  // sourceRoots not reset — project layout doesn't change during a session
}

function transitionToStale(tracker: EpistemicTracker, load: number, ageMs: number): void {
  tracker.freshnessState = 'stale';
  tracker.staleDepth = computeStaleDepth(load, ageMs);
}

export function updateTracker(
  tracker: EpistemicTracker,
  toolName: string,
  directory: string,
  filePath?: string,
): void {
  if (toolName === 'orient') {
    if (tracker.freshnessState !== 'fresh') {
      emit(directory, 'epistemic-lease', {
        event: 'orient_reset',
        from_state: tracker.freshnessState,
        prior_load: tracker.cognitiveLoad,
        prior_depth: tracker.staleDepth,
        tool: 'orient', module: null, cognitive_load: tracker.cognitiveLoad, density: 0,
        oscillation: tracker.oscillation, age_min: Math.floor((Date.now() - tracker.lastOrientAt.getTime()) / 60_000),
      });
    }
    resetTracker(tracker, directory);
    return;
  }

  const now = Date.now();
  const ageMs = now - tracker.lastOrientAt.getTime();
  const weight = TOOL_WEIGHTS[toolName] ?? 1;

  // Update trajectory window on EVERY call (including when stale) so burst
  // detection and oscillation scoring reflect the actual navigation path.
  const mod = filePath ? moduleFromPath(filePath, tracker.sourceRoots) : null;
  tracker.moduleAccessWindow.push(mod);
  if (tracker.moduleAccessWindow.length > CROSS_MODULE_WINDOW_SIZE) {
    tracker.moduleAccessWindow.shift();
  }

  const density = computeCrossModuleDensity(tracker.moduleAccessWindow);
  const oscillation = computeOscillationScore(tracker.moduleAccessWindow);
  tracker.oscillation = oscillation;
  tracker.density = density;
  // localityConfidence is a navigation coherence metric — computed here so it's
  // always current regardless of whether panic scoring is enabled.
  tracker.localityConfidence = Math.max(0, (1 - Math.min(1, density * 2)) * (1 - Math.min(1, oscillation)));

  // Already stale — time-based depth escalation only, plus V3.2 burst sensitivity.
  // Load stops accumulating here; burst detection uses tool weight and density instead.
  if (tracker.freshnessState === 'stale') {
    // Post-stale burst: heavy architectural tool or trajectory burst → immediate depth 3.
    // Gated by localityConfidence: a stale agent doing focused local work is not bursting.
    // High confidence (≥0.5) suppresses burst escalation — only clear behavioral drift triggers it.
    const isBurst = weight >= BURST_TOOL_WEIGHT_THRESHOLD || density >= BURST_DENSITY_THRESHOLD;
    if (tracker.staleDepth < 3 && isBurst && tracker.localityConfidence < 0.5) {
      emit(directory, 'epistemic-lease', {
        event: 'depth_escalate', from_depth: tracker.staleDepth, to_depth: 3,
        tool: toolName, module: mod, cognitive_load: tracker.cognitiveLoad,
        density, oscillation, age_min: Math.floor(ageMs / 60_000), trigger: 'burst',
        locality_confidence: tracker.localityConfidence,
      });
      tracker.staleDepth = 3;
      return;
    }
    const newDepth = computeStaleDepth(tracker.cognitiveLoad, ageMs);
    if (newDepth > tracker.staleDepth) {
      emit(directory, 'epistemic-lease', {
        event: 'depth_escalate', from_depth: tracker.staleDepth, to_depth: newDepth,
        tool: toolName, module: mod, cognitive_load: tracker.cognitiveLoad,
        density, oscillation, age_min: Math.floor(ageMs / 60_000),
      });
      tracker.staleDepth = newDepth as StaleDepth;
    }
    return;
  }

  // Accumulate cognitive load from tool weight
  tracker.cognitiveLoad += weight;

  if (mod !== null) {
    tracker.modulesVisited.add(mod);
    const isSwitch = tracker.lastModule !== null && mod !== tracker.lastModule;
    // Dampen rapid back-and-forth (same switch pair within SWITCH_DAMPENING_MS)
    if (isSwitch && now - tracker.lastSwitchAt > SWITCH_DAMPENING_MS) {
      tracker.cognitiveLoad += MODULE_SWITCH_BASE_WEIGHT;
      tracker.lastSwitchAt = now;
    }
    tracker.lastModule = mod;
  }

  // Density-based debt bonus (with cooldown to prevent double-counting)
  if (density >= CROSS_MODULE_STALE_DENSITY && now - tracker.lastDensityPenaltyAt > DENSITY_BONUS_COOLDOWN_MS) {
    const isBurst = density >= BURST_DENSITY_THRESHOLD;
    tracker.cognitiveLoad += isBurst ? BURST_DEBT_SPIKE : HIGH_DENSITY_DEBT_BONUS;
    tracker.lastDensityPenaltyAt = now;
  }

  const ageMin = Math.floor(ageMs / 60_000);
  const telCtx = { tool: toolName, module: mod, cognitive_load: tracker.cognitiveLoad, density, oscillation, age_min: ageMin };

  // Rate-limited git hash check (~every 30s) — structural invalidation
  if (now - tracker.lastGitCheckAt > GIT_CHECK_INTERVAL_MS) {
    tracker.lastGitCheckAt = now;
    const currentHash = getGitHash(directory);
    if (currentHash && tracker.graphVersionAtOrient && currentHash !== tracker.graphVersionAtOrient) {
      transitionToStale(tracker, tracker.cognitiveLoad, ageMs);
      emit(directory, 'epistemic-lease', { event: 'stale', trigger: 'git', depth: tracker.staleDepth as StaleDepth, ...telCtx });
      return;
    }
  }

  // State transitions: stale > degraded > fresh (never reverses)
  if (ageMs >= STALE_AGE_MS || tracker.cognitiveLoad >= STALE_LOAD_THRESHOLD || density >= CROSS_MODULE_STALE_DENSITY) {
    const trigger = density >= CROSS_MODULE_STALE_DENSITY ? 'density' : tracker.cognitiveLoad >= STALE_LOAD_THRESHOLD ? 'load' : 'time';
    transitionToStale(tracker, tracker.cognitiveLoad, ageMs);
    emit(directory, 'epistemic-lease', { event: 'stale', trigger, depth: tracker.staleDepth as StaleDepth, ...telCtx });
  } else if (
    tracker.freshnessState === 'fresh' && (
      ageMs >= DEGRADE_AGE_MS ||
      tracker.cognitiveLoad >= DEGRADE_LOAD_THRESHOLD ||
      density >= CROSS_MODULE_DEGRADE_DENSITY
    )
  ) {
    const trigger = density >= CROSS_MODULE_DEGRADE_DENSITY ? 'density' : tracker.cognitiveLoad >= DEGRADE_LOAD_THRESHOLD ? 'load' : 'time';
    tracker.freshnessState = 'degraded';
    emit(directory, 'epistemic-lease', { event: 'degraded', trigger, ...telCtx });
  }
}

// ============================================================================
// FRESHNESS SIGNALS
//
// Stale depth variants use different rhetorical strategies to resist blindness:
//   Depth 1 — procedural: enumerates what NOT to do, offers orient()
//   Depth 2 — consequential: names downstream risks of ignoring the signal
//   Depth 3 — imperative: minimal text, command form, hardest to skim past
//
// Degraded: appended (low friction, visible but not blocking).
// Stale:    prepended (agent sees it before reading any result).
// ============================================================================

function staleBlock(ageMin: number, load: number, depth: StaleDepth): string {
  const header =
    `\n╔══════════════════════════════════════════════════════════╗\n` +
    (depth === 1
      ? `║  EPISTEMIC LEASE: STALE                                  ║\n`
      : depth === 2
      ? `║  EPISTEMIC LEASE: STALE [ELEVATED]                       ║\n`
      : `║  EPISTEMIC LEASE: STALE [CRITICAL]                       ║\n`) +
    `╚══════════════════════════════════════════════════════════╝\n` +
    `Context age: ${ageMin}min | Cognitive load score: ${load}\n\n`;

  const body =
    depth === 1
      ? (
        `Cached architectural reasoning reliability: LOW\n` +
        `Cross-module dependency assumptions: UNRELIABLE\n` +
        `Internal repository model: NOT AUTHORITATIVE\n\n` +
        `Before continuing:\n` +
        `  - Do NOT rely on previous dependency assumptions\n` +
        `  - Do NOT infer cross-module relationships from memory\n` +
        `  - Do NOT compile delegation prompts from cached architectural model\n` +
        `  - Do NOT continue architectural reasoning from internal state\n\n` +
        `Call orient() to restore architectural authority.\n`
      )
      : depth === 2
      ? (
        `Dependency assumptions: NO LONGER AUTHORITATIVE\n` +
        `Architectural inference from memory: HIGH HALLUCINATION RISK\n` +
        `Delegation prompt compilation: UNSAFE — context unreliable\n\n` +
        `Continuing without orient() risks embedding stale architectural\n` +
        `assumptions into refactor plans, cross-module reasoning, and\n` +
        `delegation context that cannot easily be corrected downstream.\n\n` +
        `orient() required before architectural decisions.\n`
      )
      : (
        `Cross-module reasoning reliability: CRITICALLY LOW\n` +
        `Repository model: EXPIRED — do not use for architectural decisions\n\n` +
        `STOP. Call orient() before any architectural reasoning.\n`
      );

  return header + body + `─────────────────────────────────────────────────────────────\n\n`;
}

function degradedSignal(ageMin: number, modules: number): string {
  return (
    `\n─────────────────────────────────────────────────────────────\n` +
    `[EPISTEMIC LEASE: DEGRADED | age: ${ageMin}min | modules visited: ${modules}]\n` +
    `Cross-module dependency assumptions: reduced confidence.\n` +
    `Call orient() before architectural decisions or delegation prompt compilation.\n`
  );
}

/**
 * Returns the freshness signal for the current tracker state, or null if fresh.
 * prepend=true → signal should appear before the tool result (stale).
 * prepend=false → signal should appear after the tool result (degraded).
 *
 * Callers that build MCP content arrays should add this as a separate TextContent
 * item rather than string-concatenating into the result body.
 */
export function getFreshnessSignal(
  tracker: EpistemicTracker,
): { text: string; prepend: boolean } | null {
  if (tracker.freshnessState === 'fresh') return null;

  const ageMin = Math.floor((Date.now() - tracker.lastOrientAt.getTime()) / 60_000);

  if (tracker.freshnessState === 'stale') {
    // staleDepth is always ≥1 when freshnessState === 'stale' — invariant enforced by transitionToStale.
    return {
      text: staleBlock(ageMin, tracker.cognitiveLoad, tracker.staleDepth as StaleDepth),
      prepend: true,
    };
  }

  return {
    text: degradedSignal(ageMin, tracker.modulesVisited.size),
    prepend: false,
  };
}

export function injectFreshness(text: string, tracker: EpistemicTracker): string {
  const signal = getFreshnessSignal(tracker);
  if (!signal) return text;
  return signal.prepend ? signal.text + text : text + signal.text;
}

export function trackerToPanicState(tracker: EpistemicTracker, agentId?: string, sessionId?: string): PanicState {
  return {
    schemaVersion: 1,
    panicScore: tracker.panicScore,
    panicLevel: tracker.panicLevel,
    updatedAt: new Date().toISOString(),
    lastOrientAt: tracker.lastOrientAt.toISOString(),
    recentOrientCount: tracker.recentOrientCount,
    localityConfidence: tracker.localityConfidence,
    interventionCountSinceStable: tracker.interventionCountSinceStable,
    triggers: [...tracker.panicTriggers],
    panicRecoverySuppressionUntil: tracker.panicRecoverySuppressionUntil > Date.now()
      ? new Date(tracker.panicRecoverySuppressionUntil).toISOString()
      : undefined,
    agentId,
    sessionId,
  };
}
