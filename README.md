# openlore

> [!NOTE]
> **`spec-gen` has been renamed to `OpenLore`.** The npm package is now [`openlore`](https://www.npmjs.com/package/openlore) and the CLI command is `openlore`. Existing projects: rename your `.spec-gen/` directory to `.openlore/` and reinstall (`npm i -g openlore`). See [docs/RENAME-TO-OPENLORE.md](docs/RENAME-TO-OPENLORE.md) for the full migration checklist.

**Persistent architectural memory and structural cognition for AI coding agents.**

openlore turns any evolving codebase into a navigable knowledge graph backed by [OpenSpec](https://github.com/Fission-AI/OpenSpec) living specifications. It maintains persistent architectural context across agent sessions: graph structure, specs, decisions, drift state, and semantic retrieval — so agents start each task already oriented instead of re-discovering the system from file reads.

---

## Why It Exists

AI agents are powerful but amnesiac. On every new task:

- They re-read the same source files to understand structure
- They forget architectural decisions made two sessions ago
- They have no link between specs and code — drift is invisible
- File-by-file navigation often burns **15,000–50,000 tokens** per orientation pass, before a single line of useful code is written
- In long sessions, they drift from authoritative retrieval toward internally cached reasoning — producing subtly wrong architectural assumptions that compound silently until a refactor breaks

openlore closes this loop. Run a full analysis once, then keep the graph incrementally updated as the codebase evolves. Even greenfield projects become cognitively "brownfield" after only a few agent sessions — architectural context fragments, decisions disappear, and agents repeatedly reconstruct the same understanding from scratch.

openlore persists that context continuously: structure, specs, decisions, drift state, and graph relationships remain queryable across sessions.

---

## How It Works

Three layers, each usable independently:

| Layer | What it does | API key? |
|-------|-------------|----------|
| **1. Static Analysis** | Call graph, clusters, McCabe CC, external deps → `CODEBASE.md` digest | No |
| **2. Spec Layer** | LLM-generated living specs, ADRs, drift detection, decision gates | For generation |
| **3. Agent Runtime** | 45 MCP tools — `orient()`, semantic search, graph expansion | No |

You can use layer 1 alone to give agents structural context. Add layer 2 for semantic intent and architectural governance through OpenSpec-compatible living specifications. Layer 3 keeps that context continuously accessible through graph-native MCP tools once `openlore mcp` is running.

---

## openlore vs. Alternatives

| | Cursor / Claude Code | Sourcegraph | openlore |
|---|---|---|---|
| Graph-aware MCP context | ❌ file-based reads | Partial | ✓ call graph + clusters |
| Spec drift detection | ❌ | ❌ | ✓ milliseconds, no API |
| Architectural decision gates | ❌ | ❌ | ✓ pre-commit hook |
| Offline structural analysis | ❌ | ❌ | ✓ |
| Token-efficient orient() | ❌ | ❌ | ✓ ~1–3k vs 15–50k tokens |
| Living spec generation | ❌ | ❌ | ✓ |
| Persistent cross-session architectural memory | ❌ | Partial | ✓ |
| Long-session confidence decay (Epistemic Lease) | ❌ | ❌ | ✓ |

Traditional coding agents reconstruct architecture from repeated file reads every session. openlore persists it as a queryable graph.

---

## 5-Minute Quickstart

> **Minimum to see value — no API key needed:**

```bash
npm install -g openlore
cd /path/to/your-project

openlore analyze          # build call graph, clusters, CODEBASE.md
openlore mcp              # start MCP server
```

Then ask your agent: **`orient("add a new payment method")`**

That single call returns the relevant functions, their call neighbours, matching spec sections, and insertion-point candidates — preserving architectural continuity across sessions instead of forcing the agent to repeatedly reconstruct context from raw file reads. In practice, this often reduces orientation cost from ~30,000 exploratory tokens to ~1,000 targeted tokens.

**Full pipeline** (specs + decisions — optional and additive):

```bash
openlore generate         # generate living specs (requires API key)
openlore drift            # detect spec/code drift
openlore decisions        # manage architectural decisions
```

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/clay-good/openlore
cd openlore
npm install && npm run build && npm link
```

</details>

<details>
<summary>Nix / NixOS</summary>

```bash
nix run github:clay-good/openlore -- analyze
nix shell github:clay-good/openlore
```

System flake:
```nix
environment.systemPackages = [ openlore.packages.x86_64-linux.default ];
```

</details>

---

## See It In Action

<details>
<summary>Example: orient("add a payment method")</summary>

```json
{
  "functions": [
    {
      "name": "processPayment",
      "file": "src/payments/processor.ts",
      "risk": "medium",
      "fanIn": 4,
      "callers": ["handleCheckout", "retryFailedCharge"],
      "callType": "direct"
    },
    {
      "name": "validateCard",
      "file": "src/payments/validator.ts",
      "risk": "low",
      "fanIn": 1,
      "testedBy": [{ "name": "validateCard.test.ts", "confidence": "called" }]
    }
  ],
  "specDomains": ["payments — §CardValidation, §PaymentFlow"],
  "insertionPoints": [
    "src/payments/processor.ts:87 — after existing charge logic"
  ],
  "callPath": "POST /charge → handleCheckout → processPayment → validateCard → stripeClient.charge"
}
```

One graph query replaces most exploratory file reads. The agent knows exactly where to look and what risks to consider.

</details>

---

## Use OpenLore as a Claude Code Skill

OpenLore ships a canonical [Claude Code Skill](https://docs.claude.com/en/docs/claude-code/skills) at [`skills/openlore-orient/`](skills/openlore-orient/). Install it once and Claude Code will automatically call `orient()` at the start of every task — no `CLAUDE.md` editing required.

```sh
# From the OpenLore repo root:
npm run skill:install-local           # → ~/.claude/skills/openlore-orient/

# Or copy into a single project's .claude/skills/:
cp -R skills/openlore-orient /path/to/your-project/.claude/skills/
```

The skill bundle ships a `SKILL.md` manifest, POSIX + PowerShell wrappers, a worked example, and a redacted real `orient()` JSON output so the model knows the response shape. See [`skills/openlore-orient/README.md`](skills/openlore-orient/README.md) for details.

---

## Core Features

**Analyze** (no API key)

Continuously maintains a structural representation of your codebase using pure static analysis. Builds a full call graph persisted to SQLite, runs label-propagation community detection to cluster tightly coupled functions, computes McCabe cyclomatic complexity for every function, and extracts DB schemas, HTTP routes, UI components, middleware chains, and environment variables. Outputs `.openlore/analysis/CODEBASE.md` — a ~600-token structural digest that compresses the equivalent of tens of thousands of exploratory tokens into a small, queryable summary.

With `--watch-auto`, the call graph updates incrementally on every file save: changed file and its direct callers are re-parsed and the graph is atomically swapped. Orient and BFS queries remain live between full analyze runs.

**Generate** (API key required)

Sends the analysis to an LLM in 6 structured stages: project survey → entity extraction → service analysis → API extraction → architecture synthesis → ADR enrichment. Produces `openspec/specs/` living specifications in RFC 2119 format with Given/When/Then scenarios.

**Drift** (no API key)

Compares git changes against spec mappings in milliseconds. Detects: Gap (code changed, spec not updated), Uncovered (new file, no spec), Stale (spec references deleted files), ADR gap (code changed in an ADR-referenced domain). Installs as a pre-commit hook.

**MCP** (no API key)

45 graph-native tools exposed over stdio. Together they act as a persistent architectural runtime for coding agents: orientation, graph traversal, semantic retrieval, drift awareness, decision context, and structural risk analysis.
`orient()` is the main entry point — one call replaces 10+ file reads. `detect_changes` risk-scores changed functions using call graph centrality × change type multiplier. See [docs/mcp-tools.md](docs/mcp-tools.md).

`orient()` runs in **~430µs p50** against a 15k-node codebase (TypeScript compiler, ~79k edges). Full benchmark results: [scripts/BENCHMARKS.md](scripts/BENCHMARKS.md).

**Epistemic Lease** (no API key)

> **Core principle**: EpistemicLease models architectural drift as a behavioral navigation phenomenon rather than a semantic understanding problem. Context decay is driven by where the agent goes (cross-module trajectory), not what it knows.

As a session grows longer, agents naturally shift from authoritative graph retrieval toward internally cached reasoning. This is useful for fluency but dangerous for architectural correctness — cross-module assumptions go stale, dependency hallucinations accumulate, and delegation prompts embed incorrect repository understanding that cannot easily be corrected downstream.

The Epistemic Lease models this decay explicitly. Every MCP tool response carries a freshness signal when the agent's architectural context has degraded or expired. Decay is triggered by any of: time elapsed since `orient()`, git hash divergence from the orient baseline, weighted cognitive load accumulation (heavier tools count more), or cross-module file access breadth.

The signal escalates through three levels to resist [warning blindness](https://en.wikipedia.org/wiki/Alarm_fatigue):

| Level | Trigger | Signal style |
|---|---|---|
| Degraded | load ≥ 30, age ≥ 15min, or cross-module density ≥ 0.15 | Advisory signal appended |
| Stale | load ≥ 60, age ≥ 30min, git hash divergence, or density ≥ 0.30 | Procedural block prepended: what NOT to do |
| Stale [Elevated] | load ≥ 85 or age ≥ 45min | Risk-framing: names downstream consequences |
| Stale [Critical] | load ≥ 110 or age ≥ 60min | Imperative: `STOP. Call orient().` — minimal, hardest to skim |

Cross-module density is computed as a sliding-window trajectory model: `switches_in_last_15_calls / 15`. The fixed denominator prevents false positives during session warmup. Each module switch adds +5 cognitive debt; a high-density window adds +15; a burst (density ≥ 0.60) adds +20. A 5s dampening window prevents back-and-forth from double-counting.

An oscillation coefficient (`repeated_bigram_transitions / total_transitions`) separately distinguishes confusion loops (A→B→A→B scores 1.0) from genuine exploration (A→B→C→D scores 0.0). When already stale, a heavy architectural tool (weight ≥ 8) or density burst (≥ 0.60) triggers immediate escalation to Stale [Critical].

When fresh, injection is zero-overhead. Calling `orient()` resets the tracker. Unlike governance systems, the lease never blocks — it modulates the agent's confidence in its own cached reasoning rather than constraining its actions.

**Decisions** (API key for consolidation)

Agents call `record_decision` before writing code. Consolidation runs immediately in the background. At commit time, a pre-commit hook gates the commit until all verified decisions are reviewed and written back as requirements in `spec.md` files. Decisions are classified by scope (`local / component / cross-domain / system`); only `cross-domain` and `system` decisions produce ADR files, keeping the decision log signal-dense.

**Telemetry** (opt-in, no API key)

Cognitive telemetry for empirical measurement of EpistemicLease behavior. Gated by `OPENLORE_TELEMETRY=1` — disabled by default. Writes append-only JSONL to `.openlore/telemetry/` per domain. Agent identity is captured from the MCP `initialize` handshake, enabling per-agent behavioral comparison.

```
.openlore/telemetry/
  mcp.jsonl              # every tool call: latency, errors, agent name
  orient.jsonl           # orient quality: function/file/insertion_point counts
  cache.jsonl            # readCachedContext hit/miss
  epistemic-lease.jsonl  # state transitions: degraded, stale, depth escalation
```

Analyze with `openlore telemetry`:

```
openlore telemetry [directory]   # summary: latency, cache hit rate, obstinacy index
openlore telemetry --live        # stream events in real time as they occur
```

Key metrics: **obstinacy index** (tool calls after stale before orient — measures whether agents act on warnings), **recovery efficiency** (stale→orient latency), **trajectory dynamics** (avg cross-module density, burst frequency). These turn EpistemicLease from a tuning-by-intuition system into an empirically measurable one.

---

## Architecture

OpenSpec provides semantic intent and workflow structure. openlore maintains the evolving implementation as a continuously queryable architectural graph for agents.

```
Codebase
   │
   ▼
openlore analyze ──► SQLite graph store (.openlore/analysis/call-graph.db)
                          │                      │
                          │              MCP tools (orient, BFS, search…)
                          │                      │
                     Artifact Generator        Agent
                          │
                    ┌─────┴──────┐
                    ▼            ▼
              CODEBASE.md   (optional)
                         openlore generate ──► openspec/specs/*.md
                         openlore drift   ──► drift report
                         openlore decisions ► ADR gates
```

The graph and the OpenSpec spec layer are co-equal: the graph makes orientation fast, the specs make it semantically grounded. Drift detection and decision gates connect both. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full pipeline diagram.

---

## Documentation

| Topic | Doc |
|-------|-----|
| MCP tools reference (45 tools + parameters) | [docs/mcp-tools.md](docs/mcp-tools.md) |
| Agent setup (Claude Code, Cline, OpenCode, Vibe…) | [docs/agent-setup.md](docs/agent-setup.md) |
| LLM providers + embedding config | [docs/providers.md](docs/providers.md) |
| Drift detection in depth | [docs/drift-detection.md](docs/drift-detection.md) |
| Spec-driven tests + spec digest | [docs/spec-tests.md](docs/spec-tests.md) |
| CI/CD integration | [docs/ci-cd.md](docs/ci-cd.md) |
| CLI command reference | [docs/cli-reference.md](docs/cli-reference.md) |
| Interactive graph viewer | [docs/viewer.md](docs/viewer.md) |
| Analysis output files | [docs/output.md](docs/output.md) |
| Configuration reference | [docs/configuration.md](docs/configuration.md) |
| Programmatic API | [docs/api.md](docs/api.md) |
| Pipeline architecture | [docs/pipeline.md](docs/pipeline.md) |
| Internal design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Algorithms | [docs/ALGORITHMS.md](docs/ALGORITHMS.md) |
| Agentic workflows (BMAD, Vibe, GSD, spec-kit) | [docs/agentic-workflows.md](docs/agentic-workflows.md) |
| Troubleshooting | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| Philosophy | [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) |
| Telemetry & cognitive metrics | [docs/telemetry.md](docs/telemetry.md) |

---

## Known Limitations

- **Incremental call graph updates are depth-1 only**: `--watch-auto` re-indexes signatures and edges on save for the changed file and its direct callers. Transitive callers (A→B→C, C changes, A stays stale) are only refreshed by the next `analyze --force`. For hub files with 100+ callerFiles, re-parse may take several seconds.
- **Static analysis only**: dynamic dispatch, runtime metaprogramming, and `eval`-based patterns are not captured in the call graph.
- **LLM spec quality varies**: generated specs reflect the model's understanding. Review sections covering complex business logic before treating them as authoritative.
- **Embedding is optional**: without an embedding endpoint, `orient` and `search_code` fall back to BM25 keyword search (still useful, less accurate for semantic queries).
- **Large monorepos**: `openlore analyze` on large codebases may take several minutes. Graph storage itself has no practical limit — the pipeline (AST parsing, symbol extraction) is the bottleneck.
- **`node:sqlite` experimental warning on Node 22**: Node.js 22 prints `ExperimentalWarning: SQLite is an experimental feature` to stderr. The warning is gone on Node 24+. Suppress on Node 22 with `NODE_NO_WARNINGS=1 openlore analyze`.

---

## Requirements

- Node.js 22.5+
- API key for `generate`, `verify`, and `drift --use-llm`:
  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...    # default provider
  export OPENAI_API_KEY=sk-...           # OpenAI
  export GEMINI_API_KEY=...              # Google Gemini
  ```
  Or use a CLI-based provider (`claude-code`, `gemini-cli`, `mistral-vibe`, `cursor-agent`) — no API key, just the CLI on your PATH.
- `analyze`, `drift`, `mcp`, and `init` require no API key

**Languages supported**: TypeScript · JavaScript · Python · Go · Rust · Ruby · Java · C++ · Swift

---

## Development

```bash
npm install
npm run build
npm test          # 2660+ unit tests
npm run typecheck
```

---

## Links

- [OpenSpec](https://github.com/Fission-AI/OpenSpec) — spec-driven development framework
- [AGENTS.md](AGENTS.md) — system prompt for direct LLM prompting
- [Examples](examples/) — BMAD, Vibe, GSD, drift-demo, spec-kit integrations
