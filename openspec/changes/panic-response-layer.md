# Panic Response Layer

## Summary

Introduces a behavioral destabilization detection and intervention system for EpistemicLease.
Complements staleness tracking (freshness state) with a separate panic score that measures
observable navigation instability. Intervenes via two channels: MCP tool response injection
(existing) and a new PreToolUse hook that fires before every agent tool call — closing the
tunneling blind spot where a destabilized agent stops calling openlore entirely.

Gryph integration (optional) enriches the panic score with shell/filesystem signals openlore
cannot observe directly.

---

## Design Principles

**Behavioral only.** Operates exclusively on observable runtime signals: navigation patterns,
trajectory density, oscillation coefficient, stale depth, write volume. No psychological
modeling, no intent inference, no chain-of-thought inspection.

**Pacing over policing.** Interventions slow destabilizing execution and encourage re-anchoring.
They do not attempt to fix reasoning.

**Soft-first escalation.** L1→L4 progressive; L4 advisory-only in initial version.

**Recovery-first.** No permanent punishment states. `orient()` success applies strong score
reduction. All levels self-resolve on behavioral stabilization.

**Dual-channel.** MCP injection (reaches agents using openlore) + hook injection (reaches all
agents regardless of openlore usage).

**Fail-open.** Hook absence, read errors, and internal failures MUST NOT break MCP flow or
block agent operation. System correctness MUST NOT depend on hook execution.

---

## Behavioral Space

Five independent dimensions describe agent state. They can be opposed:

| Situation | Interpretation |
|-----------|---------------|
| low density + low entropy | focused local work (coherent, no intervention needed) |
| high density + high entropy | productive exploration (risky but coherent) |
| high density + low entropy | panic probable (drift, retry loop) |
| low density + high oscillation | local contradiction (A↔B without progress) |
| stale + low panic | deep stale dive (known risk, focused) |
| fresh + high panic | recent orient(), still confused |
| stale + high locality confidence | locally coherent stale work (low risk) |
| stale + low locality confidence + drift | architectural isolation risk |

**Absence of openlore calls is not a failure signal.** An agent doing focused local work with
high locality confidence has low need for orient() or graph traversal. The working set fits
in active context. Tool utilization is a proxy — the target is *appropriate* tool utilization,
not maximum utilization.

The dangerous case is not "0 openlore calls" but:
```
many files + large patches + oscillation + retry loops + cross-module + failure traces
AND no openlore calls
```
That is architectural isolation risk. Focused single-file work with no orient() is rational.

## Freshness vs Panic — Explicit Separation

These are independent dimensions of epistemic state:

```ts
interface EpistemicState {
  freshness: FreshnessState;   // architectural authority decay
  panic: PanicState;           // behavioral destabilization
}
```

```
Freshness models epistemic authority decay.
Panic models behavioral destabilization.
Neither implies the other.

An agent can be:
- stale but behaviorally calm (linear deep dive into stale context)
- fresh but panicking (rapid confused navigation after recent orient())
```

**Coupling constraint:** Stale depth floors panic level (see Panic Ceiling section).
No other coupling exists. Freshness transitions and panic transitions are computed
independently. Metrics, thresholds, and tuning are kept separate.

---

## Runtime Safety Invariants

The following properties MUST hold regardless of the internal state of the panic system,
the state file, or Gryph availability:

```
- panic-check MUST fail open: exits 0, outputs {"decision":"allow"} on any internal error
- Gryph absence MUST have zero behavioral impact: null returned, no error, no log noise
- Telemetry failure MUST NOT affect tool execution: emit() never throws
- panic-state.json corruption MUST resolve to stable state (panicLevel 0, panicScore 0)
- Hook execution failure MUST NOT block MCP flow
- panic-check and openlore telemetry are excluded from panic computation: these CLI
  commands read state but never call updateTracker — no recursive feedback loop
```

## Formal Invariants

```
- panicScore ∈ [0, 100] (always clamped, never drifts)
- staleDepth monotonically increases until orient()
- panicLevel transitions are hysteretic (no thrashing)
- panic-check exits 0 on all code paths including internal failures
- hook absence never breaks MCP flow
- panic-state.json writes are atomic (temp + rename)
- orient() recovery bonus diminishes with rapid repeat usage
- interventionCountSinceStable resets on: stable recovery (panicLevel→0), orient() reset,
  30min session expiry (state treated as expired, all fields zeroed)
```

---

## Architecture

```
openlore MCP server
  └── computes panic score on every tool call
  └── writes .openlore/panic-state.json atomically (temp + rename)
  └── injects panic signals into MCP tool responses (existing channel)

openlore panic-check CLI
  └── reads .openlore/panic-state.json
  └── fails open on parse errors / missing file
  └── outputs structured response, always exits 0

PreToolUse hook (per agent, thin adapter, best-effort)
  └── invokes: openlore panic-check --format <agent>
  └── fires before EVERY tool call — not just openlore calls
  └── closes tunneling blind spot

Gryph (optional, gracefully absent)
  └── detected via PATH at runtime
  └── queried by panic-check when available
  └── absence = zero-impact, not error
```

---

## Shared State File

`.openlore/panic-state.json` — written by MCP server, read by hook without MCP round-trip.

```json
{
  "schemaVersion": 1,
  "panicScore": 42,
  "panicLevel": 2,
  "updatedAt": "2026-05-19T10:30:00Z",
  "lastOrientAt": "2026-05-19T10:25:00Z",
  "lastHookInterventionAt": "2026-05-19T10:29:00Z",
  "recentOrientCount": 1,
  "localityConfidence": 0.7,
  "triggers": ["trajectory_burst", "oscillation_spike"],
  "agentId": "claude-code",
  "sessionId": "abc123",
  "interventionCountSinceStable": 0
}
```

**Writes MUST be atomic:**

```ts
writeFileSync(`${path}.tmp`, json, 'utf-8');
renameSync(`${path}.tmp`, path);
```

POSIX `rename(2)` is atomic on the same filesystem. Prevents partial reads and race
conditions between MCP server writes and hook reads.

**Corruption handling:** `panic-check` MUST fail open. Invalid JSON, missing file, or
unreadable state is treated as stable state (panicLevel 0). Hook flow is never interrupted
by state file issues.

**Session hard reset:** If `updatedAt` is more than 30 minutes in the past, `panic-check`
treats the state as expired: panicScore = 0, panicLevel = 0. Prevents zombie state from
polluting a new session.

**Schema migration:** Consumers check `schemaVersion` before reading. Unknown versions are
treated as stable state (fail open).

---

## Panic Score

`panicScore ∈ [0, 100]` — clamped after every operation.

### MCP-derived signals

| Signal | Weight |
|--------|--------|
| Trajectory burst (density ≥ 0.60) | +15 |
| Oscillation spike (osc ≥ 0.50) | +10 |
| Stale depth 3 persistence (each call) | +25 |

### Locality Confidence Modulation

`localityConfidence ∈ [0,1]` is computed from both density and oscillation:

```
localityConfidence = (1 - min(1, density × 2)) × (1 - min(1, oscillation))
```

High localityConfidence = sustained coherent local work. It modulates the panic system:

| Signal | Gating |
|--------|--------|
| `stale_depth_3` (+25/call) | only fires when `localityConfidence < 0.5` |
| burst escalation (depth → 3) | only fires when `localityConfidence < 0.5` |
| locality recovery (−3/call) | fires when `density < 0.10 && oscillation < 0.10 && staleDepth = 0` |

**Rationale:** a stale agent doing focused local work (`staleDepth = 3` but `localityConfidence = 0.9`)
is not in the same risk category as a stale agent drifting cross-module. Suppressing the
`stale_depth_3` signal in that case prevents the panic system from treating coherent deep
work as a destabilization event.

This also means the system does NOT maximize orient() calls. It maximizes appropriate
recontextualization — only when the behavioral signals indicate it is actually needed.

**Trajectory tracking continues while stale.** Module access window and oscillation score
accumulate during stale state so that post-stale burst and trajectory patterns remain
observable. The stale state does not freeze the behavioral model.

**Depth-3 persistence intentionally saturates rapidly.** An agent at staleDepth 3 with 4+
tool calls reaches score 100 within a single burst. This models runaway destabilization —
an agent deep in stale state continuing to make cross-module calls is exhibiting the exact
failure mode the panic layer exists to interrupt. Rapid saturation is a design choice, not
an accidental artifact.

### Gryph-derived signals (optional)

| Signal | Weight | Notes |
|--------|--------|-------|
| Large patch while stale (> 500 LOC) | +30 | Write event size — attenuated when commandEntropy is high (see below) |
| Contradiction persistence | +20 | See definition below |
| Repetitive shell retry burst | +15 | See definition below |

**Raw tool frequency MUST NOT be used directly as a panic signal.**
Only low-entropy repetition patterns are destabilizing. Legitimate activity (builds, tests,
grep, git operations, batch AST traversal) routinely produces high tool frequency. The
signal of interest is behavioral collapse, not throughput.

`commandEntropy` is normalized Shannon entropy over recent shell command signatures:

```
H(commands) = -Σ p(cmd) · log₂(p(cmd))   normalized to [0,1] over max possible entropy
Low entropy  = repetitive retry loops (same command repeated, low diversity)
High entropy = exploratory activity (diverse commands, productive burst)
```

Low entropy + high frequency = retry burst (panic signal).
High entropy + high frequency = productive exploration (not a panic signal).

**Contradiction persistence** triggers when:
- Same failure signature (stack trace / test name) repeats N ≥ 3 times
- AND touched module set overlap ≥ 80% between retries (no meaningful trajectory change)
- AND no new module introduced between retries
- NOT triggered by `fail → edit → fail` alone (normal TDD)

**Repetitive shell retry burst** triggers when:
- High-frequency repeated identical commands OR repeated failing commands
- Low `commandEntropy` over recent window
- NOT triggered by raw command volume

**Large patch attenuation:** If large patch (> 500 LOC) is accompanied by high `commandEntropy`
(diverse command sequence consistent with deliberate refactoring), weight is reduced from +30
to +10. High entropy + large patch = likely legitimate boilerplate generation. Low entropy +
large patch = likely panicked patching.

**Meaningful file trajectory change** is defined as:
- Touched module set overlap < 80% with previous attempt, OR
- At least one new module introduced, OR
- Edit distance of touched file set > 2

### Decay

- **Passive:** `-5 / minute` based on wall-clock elapsed since `updatedAt`
- **orient() success:** recovery bonus (see orient spam protection below)
- **Locality recovery:** `-3 / call` when `density < 0.10 && oscillation < 0.10 && staleDepth = 0`

  Behavioral stabilization is inferred from sustained local navigation with low oscillation
  and low trajectory density. The system does not observe intent — it observes the spatial
  coherence of tool usage. Concentrated, low-oscillation navigation is treated as evidence
  of anchored, productive work.

Score clamped to `[0, 100]` after every operation.

### Refractory Period

After orient() achieves a score reduction (`panicDelta < 0`), upward signals are suppressed
for `PANIC_REFRACTORY_MS` (45 seconds). Locality recovery and passive decay still apply.

```
panicRecoverySuppressionUntil = now + 45s   (set by orient() on any score-reducing call)
```

During the refractory window:
- `trajectory_burst`, `oscillation_spike`, `stale_depth_3` → skipped
- `passive_decay`, `locality_recovery` → still applied

This prevents panic from immediately re-escalating after recovery. Without it, a single burst
trajectory immediately after orient() would undo the recovery bonus before the agent has had
a chance to re-anchor. The 45s window matches orient() → first few tool calls latency.

`panicRecoverySuppressionUntil` is stored in the state file (as ISO string, omitted when
not active) so the hook can apply the same guard without re-querying the MCP server.

### orient() Spam Protection

`orient()` recovery is diminishing to prevent gaming the reset mechanism:

| Condition | Recovery bonus |
|-----------|---------------|
| Normal usage | -40 |
| < 2 min since previous orient() | -15 |
| ≥ 3 rapid resets in current session | 0 |

`recentOrientCount` and `lastOrientAt` tracked in panic state.

---

## Panic Levels

### Hysteresis Table

Up and down transitions use different thresholds to prevent thrashing at boundary values:

| Transition | Condition |
|-----------|-----------|
| L0 → L1 | score ≥ 30 |
| L1 → L0 | score < 20 |
| L1 → L2 | score ≥ 50 |
| L2 → L1 | score < 40 |
| L2 → L3 | score ≥ 70 |
| L3 → L2 | score < 60 |
| L3 → L4 | score ≥ 90 AND stale_depth ≥ 3 |
| L4 → L3 | score < 80 |

### Panic Ceiling (stale depth floors)

```
While staleDepth ≥ 2: minimum panicLevel = 1
While staleDepth = 3: minimum panicLevel = 2
```

A critically stale agent cannot report Stable behavior. Floors are applied after hysteresis.

### Summary Table

| Level | Up threshold | Down threshold | Name | Channel |
|-------|-------------|----------------|------|---------|
| 0 | — | — | Stable | — |
| 1 | ≥ 30 | < 20 | Elevated | MCP + hook |
| 2 | ≥ 50 | < 40 | Panic | MCP + hook |
| 3 | ≥ 70 | < 60 | Scope Reduction | MCP + hook |
| 4 | ≥ 90 + stale3 | < 80 | Critical | hook advisory |

### Hook Injection Cooldowns

To prevent context saturation and habituation, hook interventions are rate-limited per level:

| Level | Cooldown |
|-------|----------|
| L1 | 120s |
| L2 | 60s |
| L3 | 30s |
| L4 | 0s (always fires) |

`lastHookInterventionAt` in panic state. Cooldown tracked per level.

**Anti-wallpaper (stateful):** `interventionCountSinceStable` tracked in panic state.
When the same level fires ≥ 3 times since last Stable without score improvement, the
intervention mode escalates from advisory to directive:

```
// Advisory (first interventions)
[PANIC:PLANNING] Before cross-module modification, state: ...

// Directive (≥3 repeated, no recovery)
[PANIC:PLANNING:DIRECTIVE] Previous checkpoint ignored. Stop. Run orient() now before proceeding.
```

Directive mode resets to advisory on any score reduction. This is V1 implementable — requires
only `interventionCountSinceStable: number` in the state file.

### Intervention Messages

**Level 1 — Reflective Checkpoint**
```
[PANIC:ELEVATED] Recent navigation suggests increasing architectural uncertainty.
Consider: summarize current assumptions, identify uncertain dependencies, call orient().
```

**Level 2 — Planning Enforcement**
```
[PANIC:PLANNING] Before cross-module modification, state:
1. Intended architectural impact  2. Modules affected  3. Rollback strategy
Then proceed.
```

**Level 3 — Scope Reduction**
```
[PANIC:SCOPE] Cross-module writes discouraged until orient().
Prefer local changes. orient() expands operational scope.
```

**Level 4 — Circuit Breaker (advisory)**
```
[PANIC:CRITICAL] Critical epistemic instability. Call orient() before further modifications.
```

---

## New Files

- `src/core/services/mcp-handlers/panic-response.ts` — panic score computation, state
  management, signal detection, atomic state writes. Reads from `EpistemicTracker` (reuses
  existing `oscillation`, `density`, `staleDepth` fields). Exports `PanicState`,
  `computePanicScore`, `writePanicState`, `applyHysteresis`.

- `src/cli/commands/panic-check.ts` — `openlore panic-check` CLI command. Reads
  `.openlore/panic-state.json` with fail-open semantics. Outputs structured response,
  always exits 0. Supports `--format claude|kilo|codex`. Optionally queries Gryph.

- `openspec/specs/panic-response/spec.md` — domain spec (generated after implementation).

---

## Modified Files

- `src/core/services/mcp-handlers/epistemic-lease.ts` — extend `EpistemicTracker` with
  `panicScore: number`, `panicLevel: 0|1|2|3|4`, `localityConfidence: number`,
  `recentOrientCount: number`. Panic computed alongside freshness on every `updateTracker()`
  call. Reuses `oscillation`, `density`, `staleDepth` already computed. Explicit separation:
  panic computation does not modify freshness fields and vice versa.

- `src/core/services/mcp-handlers/utils.ts` — add `writePanicState(directory, state)` with
  atomic temp+rename semantics. Called from `updateTracker()` after panic recomputation.

- `src/cli/commands/mcp.ts` — ensure `writePanicState` fires on every tool dispatch.

- `src/cli/index.ts` — register `panic-check` command.

- `src/cli/commands/telemetry.ts` — add panic section: episodes, avg recovery latency,
  hook intercepts, failed recovery rate. Telemetry reads `panic-response.jsonl`.

---

## Hook Integration

### Agent Capability Model

```ts
interface AgentCapabilities {
  supportsHooks: boolean;
  supportsStructuredIntervention: boolean;
  supportsBlockSemantics: boolean;
}
```

Capabilities declared per format. `panic-check --format <agent>` uses the capability
profile for that agent to shape output. Unknown format = fall back to plain text warn.

### openlore panic-check

```
openlore panic-check [--directory <path>] [--format claude|kilo|codex]
```

**Always exits 0.** Non-zero exit would be misinterpreted as tool crash / hook failure.
Intervention semantics are expressed exclusively through structured output.

Structured output:

```json
// L0 — stable
{"decision": "allow"}

// L1-L3 — warning
{"decision": "warn", "severity": "elevated|panic|scope", "message": "..."}

// L4 — advisory block
{"decision": "warn", "severity": "critical", "message": "[PANIC:CRITICAL] ..."}
```

**L4 uses `warn` + `severity: critical`, not `decision: block`.** Keeps semantics
consistent. Agent adapter MAY escalate `critical` to a block; it MAY NOT be forced to.
This is advisory architecture, not enforcement.

**L4 enforcement model:**
```
L4 is advisory by default.
Hook adapters MAY choose stronger semantics (pause/block) depending on runtime capabilities.
OpenLore itself never hard-blocks execution — not in V1, not in V2.
Execution interruption is a runtime policy decision, not a framework decision.
```

OpenLore emits signals. Runtimes decide what to do with them. This boundary is intentional:
OpenLore cannot verify that a block is safe or appropriate in context. Enforcement belongs
to the agent runtime that understands its execution model.

Agent adapters translate `decision` + `severity` to agent-native semantics.

**Hooks are best-effort runtime augmentations, not trusted enforcement boundaries.**
System correctness MUST NOT depend on hook execution. A hook that never fires must leave
the MCP flow fully functional.

### Claude Code

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{"type": "command", "command": "openlore panic-check --format claude"}]
    }]
  }
}
```

Installed automatically by `openlore setup --hooks claude`.

### kilocode

Plugin with `tool.execute.before`. Reads panic state directly from file to avoid CLI
spawn overhead. Interprets `severity: critical` as a throw (advisory block).
Distributed as built-in plugin or separate npm package.

### Codex

Identical hook format to Claude Code. Installed by `openlore setup --hooks codex`.

### Performance

Process spawn + Node startup + fs read + JSON parse per tool call adds 30–100ms depending
on machine. Acceptable in V1 for sequential tool calls; may cause noticeable stutter if
agent executes 10+ tools in rapid parallel bursts.

**Critical V1 constraint:** The `panic-check` entry point in `src/cli/index.ts` MUST
short-circuit heavy dependency loading when the invoked command is `panic-check`. DB
drivers, analysis modules, and graph loaders MUST NOT be imported on this path. Only
`panic-state.json` read + JSON parse + output should execute.

**Hook timeout:** Agent-side hook configuration MUST set a strict execution timeout
(recommended: 200ms). `panic-check` failing to respond within timeout MUST fail open —
tool execution proceeds as if no hook fired. A blocked `panic-check` process MUST NOT
freeze the agent runtime.

**V2 optimization (not implemented):** `openlore-panicd` — persistent daemon, unix socket,
cached state, sub-millisecond reads. Implement only if V1 latency proves measurable in
practice. Likely to become a priority under daily use.

---

## Gryph Integration (Optional)

```
Gryph integration MUST degrade gracefully to zero-impact absence semantics.
```

When `gryph` binary is absent or query fails: no signals added, no error, no log noise.

**Configuration:**

| Env var | Default | Purpose |
|---------|---------|---------|
| `OPENLORE_GRYPH_TIMEOUT_MS` | `150` | Per-query budget (ms). Both exec and write queries share this budget. Set higher on slow machines, lower if hook latency is a concern. Clamped to minimum 50ms. |

Total Gryph latency budget ≤ `2 × OPENLORE_GRYPH_TIMEOUT_MS`. Add to the agent hook timeout calculation when Gryph is present.

When present, `panic-check` queries:

```bash
gryph query --format json --action exec --since <lastCheckAt>
gryph query --format json --action write --since <lastCheckAt>
```

Session scoped: matches Gryph session ID from `panic-state.json`.

Signals consumed: repetitive shell retry bursts (via `commandEntropy`), contradiction
persistence (same failing test + no file trajectory change), large write events while stale.

---

## Telemetry

Domain: `panic-response.jsonl`

**Rotation:** rotate at 50MB, keep last 5 files. Prevents unbounded growth from
high-frequency hook activity.

**Sampling:** High-frequency hook telemetry MAY be sampled. Hook intercept events at L1
with short cooldowns can be sampled at 10% without losing behavioral signal.

| Event | Fields |
|-------|--------|
| `panic_elevated` | score, triggers[], agent |
| `reflective_checkpoint` | score, tool_name, channel, panicDelta, source |
| `planning_enforcement` | score, tool_name, channel, panicDelta, source |
| `scope_reduction` | score, tool_name, channel, panicDelta, source |
| `circuit_breaker` | score, stale_depth, channel, panicDelta, source |
| `panic_recovery` | score_before, score_after, via, latency_ms |
| `orient_spam_detected` | recentOrientCount, bonusApplied |

**Panic provenance trace.** Every `panic_score_delta` event includes full per-trigger
attribution with measured evidence, enabling calibration and faux positif analysis:

```json
{
  "event": "panic_score_delta",
  "tool": "trace_execution_path",
  "score_before": 42,
  "score_after": 57,
  "delta": 15,
  "in_refractory": false,
  "stale_depth": 3,
  "density": 0.67,
  "oscillation": 0.54,
  "triggers": [
    { "name": "trajectory_burst", "delta": 15, "evidence": { "density": 0.67 } },
    { "name": "passive_decay",    "delta": -5, "evidence": { "elapsed_min": 1.0 } }
  ]
}
```

Separating "trigger" (the signal that fired) from "evidence" (the measured value that
activated it) is required for calibration. Without evidence, the log answers "what fired"
but not "why" — which makes threshold tuning impossible.

`in_refractory: true` on events where upward signals were suppressed is critical for
detecting over-refractory situations (panic rising despite suppression is evidence that
the threshold is wrong or the window is too short).

`channel` field: `mcp` or `hook`.

`openlore telemetry` additions:

| Metric | Meaning |
|--------|---------|
| panic_episodes | distinct destabilization events (score crossed L1 up-threshold) |
| avg_recovery_latency_ms | time from first L1 to score below L1 down-threshold |
| failed_recovery_rate | episodes where score re-escalated after reaching Stable |
| hook_intercepts | interventions fired via hook (agent not calling openlore) |
| orient_spam_events | orient() calls that received reduced recovery bonus |

---

## Known Limitations

**Oscillation fragility.** `oscillation` alone is not sufficient. Back-and-forth between
two modules is normal in several productive patterns:

```
backend ↔ frontend
interface ↔ implementation
test ↔ fix (TDD)
caller ↔ callee
```

The real signal is `oscillation + no convergence`. V1 lacks a convergence signal. This will
produce faux positifs on legitimate paired workflows. Mitigation: oscillation threshold set
conservatively (0.50), require +density burst for L3+ transitions. V2 should add
convergence tracking (see below).

**Productive chaos.** A large-scale refactor is behaviorally indistinguishable from a panic
episode:

- many modules touched
- large writes
- broken builds
- repeated commands
- oscillation between test/impl
- trajectory density spikes

`commandEntropy` mitigates this partially. High entropy + large patch = attenuated signal.
But monorepo traversal, rename cascades, and API sync are cases where `commandEntropy` stays
high AND trajectory density stays high — false panic guaranteed. V2 needs a "productive
refactor mode" signal (see below).

**Goal coherence absent.** Current model measures movement, oscillation, and repetition
but not progression. A→B→C→D→E looks identical whether the agent is systematically
working through a refactor or drifting with no coherent goal. Without some notion of
`currentTaskScope` or objective tracking, the model cannot distinguish these.

**Hook dependency.** The PreToolUse hook must NEVER become mandatory. If the hook is absent,
disabled, or times out, the MCP flow must proceed normally. System correctness must never
depend on hook execution. Runtimes may install the hook for observability; they must not
treat its absence as a failure condition.

## Non-Goals (initial version)

- Hard blocking at L4 (advisory only, forever)
- Goal coherence / task scope tracking (V2 — requires agent protocol changes)
- Convergence signals (V2 — needs "new module frontier" and "same error recurrence" tracking)
- Productive refactor mode detection (V2 — expanding module frontier + low contradiction persistence)
- Agents beyond Claude Code, kilocode, Codex
- Gryph as a required dependency
- Psychological modeling, intent classification, prompt inspection
- `openlore-panicd` daemon (V2)
- Adaptive hook reinjection with semantic variation (V2, contract established above)
- Persistent panic state across sessions (each session starts fresh)
