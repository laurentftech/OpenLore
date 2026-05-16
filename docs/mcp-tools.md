## MCP Server

`openlore mcp` starts openlore as a [Model Context Protocol](https://modelcontextprotocol.io/) server over stdio, exposing static analysis as tools that any MCP-compatible AI agent (Cline, Roo Code, Kilocode, Claude Code, Cursor...) can call directly -- no API key required.

### Setup

**Claude Code** -- add a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "openlore": {
      "command": "openlore",
      "args": ["mcp"]
    }
  }
}
```

or for local development:

```json
{
  "mcpServers": {
    "openlore": {
      "command": "node",
      "args": ["/absolute/path/to/openlore/dist/cli/index.js", "mcp"]
    }
  }
}
```

**Cline / Roo Code / Kilocode** -- add the same block under `mcpServers` in the MCP settings JSON of your editor.

### Watch mode (keep search_code and orient fresh)

By default the MCP server reads `llm-context.json` from the last `analyze` run. With `--watch-auto`, it also watches source files for changes and incrementally re-indexes signatures so `search_code` and `orient` reflect your latest edits without waiting for the next commit.

Add `--watch-auto` to your MCP config args:

```json
{
  "mcpServers": {
    "openlore": {
      "command": "openlore",
      "args": ["mcp", "--watch-auto"]
    }
  }
}
```

The watcher starts automatically on the first tool call — no hardcoded path needed. It re-extracts signatures for any changed source file and patches `llm-context.json` within ~500 ms of a save. If an embedding server is reachable, it also re-embeds changed functions into the vector index automatically. The call graph is not rebuilt on every change; it stays current via the [post-commit hook](#cicd-integration) (`openlore analyze --force`).

| Option | Default | Description |
|---|---|---|
| `--watch-auto` | off | Auto-detect project root from first tool call |
| `--watch <dir>` | — | Watch a fixed directory (alternative to `--watch-auto`) |
| `--watch-debounce <ms>` | 400 | Delay before re-indexing after a file change |

### Cline / Roo Code / Kilocode

For editors with MCP support, after adding the `mcpServers` block to your settings, download the slash command workflows:

```bash
mkdir -p .clinerules/workflows
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-analyze-codebase.md -o .clinerules/workflows/openlore-analyze-codebase.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-check-spec-drift.md -o .clinerules/workflows/openlore-check-spec-drift.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-plan-refactor.md -o .clinerules/workflows/openlore-plan-refactor.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-execute-refactor.md -o .clinerules/workflows/openlore-execute-refactor.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-implement-feature.md -o .clinerules/workflows/openlore-implement-feature.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/examples/cline-workflows/openlore-refactor-codebase.md -o .clinerules/workflows/openlore-refactor-codebase.md
```

Available commands:

| Command | What it does |
|---------|-------------|
| `/openlore-analyze-codebase` | Runs `analyze_codebase`, summarises the results (project type, file count, top 3 refactor issues, detected domains), shows the call graph highlights, and suggests next steps. |
| `/openlore-check-spec-drift` | Runs `check_spec_drift`, presents issues by severity (gap / stale / uncovered / orphaned-spec), shows per-kind remediation commands, and optionally drills into affected file signatures. |
| `/openlore-plan-refactor` | Runs static analysis, picks the highest-priority target with coverage gate, assesses impact and call graph, then writes a detailed plan to `.openlore/refactor-plan.md`. No code changes. |
| `/openlore-execute-refactor` | Reads `.openlore/refactor-plan.md`, establishes a green baseline, and applies each planned change one at a time -- with diff verification and test run after every step. Optional final step covers dead-code detection and naming alignment (requires `openlore generate`). |
| `/openlore-implement-feature` | Plans and implements a new feature with full architectural context: architecture overview, OpenSpec requirements, insertion points, implementation, and drift check. |
| `/openlore-refactor-codebase` | Convenience redirect that runs `/openlore-plan-refactor` followed by `/openlore-execute-refactor`. |

All six commands ask which directory to use, call the MCP tools directly, and guide you through the results without leaving the editor. They work in any editor that supports the `.clinerules/workflows/` convention.

### Claude Skills

For Claude Code, copy the skill files to `.claude/skills/` in your project:

```bash
mkdir -p .claude/skills
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/skills/claude-openlore.md -o .claude/skills/claude-openlore.md
curl -sL https://raw.githubusercontent.com/clay-good/openlore/main/skills/openspec-skill.md -o .claude/skills/openspec-skill.md
```

**OpenLore Skill** (`claude-openlore.md`) — Code archaeology skill that guides Claude through:
- Project type detection and domain identification
- Entity extraction, service analysis, API extraction
- Architecture synthesis and OpenSpec spec generation

**OpenSpec Skill** (`openspec-skill.md`) — Skill for working with OpenSpec specifications:
- Semantic spec search with `search_specs`
- List domains with `list_spec_domains`
- Navigate requirements and scenarios

### Tools

Most tools run on **pure static analysis** — no LLM quota consumed. Exceptions: `record_decision` consolidation (LLM optional, falls back to diff extraction) and `sync_decisions` (writes to files).

**Run analysis**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `analyze_codebase` | Run full static analysis: repo structure, dependency graph, call graph (hub functions, entry points, layer violations), and top refactoring priorities. Results cached for 1 hour (`force: true` to bypass). | No |
| `get_call_graph` | Hub functions (high fan-in), entry points (no internal callers), and architectural layer violations. Supports TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C++, Swift. | Yes |
| `get_signatures` | Compact function/class signatures per file. Filter by path substring with `filePattern`. Useful for understanding a module's public API without reading full source. | Yes |
| `get_duplicate_report` | Detect duplicate code: Type 1 (exact clones), Type 2 (structural -- renamed variables), Type 3 (near-clones with Jaccard similarity >= 0.7). Groups sorted by impact. | Yes |

**Explore & Navigate**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `orient` | **Single entry point for any new task.** Given a natural-language task description, returns in one call: relevant functions, source files, spec domains, call neighbourhoods, insertion-point candidates, matching spec sections, and `suggestedTools` — a ranked list of next tools to call derived from task context (hub presence, spec domains, keywords). Start here. | Yes (+ embedding) |
| `search_code` | Natural-language semantic search over indexed functions. Returns the closest matches by meaning with similarity score, call-graph neighbourhood enrichment, and spec-linked peer functions. Falls back to BM25 keyword search when no embedding server is configured. | Yes (+ embedding) |
| `suggest_insertion_points` | Semantic search over the vector index to find the best existing functions to extend or hook into when implementing a new feature. Returns ranked candidates with role and strategy. Falls back to BM25 keyword search when no embedding server is configured. | Yes (+ embedding) |
| `get_subgraph` | Depth-limited subgraph centred on a function. Direction: `downstream` (what it calls), `upstream` (who calls it), or `both`. Output as JSON or Mermaid diagram. | Yes |
| `trace_execution_path` | Find all call-graph paths between two functions (DFS, configurable depth/max-paths). Use this when debugging: "how does request X reach function Y?" Returns shortest path, all paths sorted by hops, and a step-by-step chain per path. | Yes |
| `get_function_body` | Return the exact source code of a named function in a file. | No |
| `get_function_skeleton` | Noise-stripped view of a source file: logs, inline comments, and non-JSDoc block comments removed. Signatures, control flow, return/throw, and call expressions preserved. Returns reduction %. | No |
| `get_file_dependencies` | Return the file-level import dependencies for a given source file (imports, imported-by, or both). | Yes |
| `get_architecture_overview` | High-level cluster map: roles (entry layer, orchestrator, core utilities, API layer, internal), inter-cluster dependencies, global entry points, and critical hubs. No LLM required. | Yes |

**Stack inventory**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_route_inventory` | All detected HTTP routes with method, path, handler, and framework. Supports Express, NestJS, Next.js, FastAPI, Flask, and more. | Yes |
| `get_schema_inventory` | ORM schema tables with field names and types. Supports Prisma, TypeORM, Drizzle, and SQLAlchemy. | Yes |
| `get_ui_components` | Detected UI components with framework, props, and source file. Supports React, Vue, Svelte, and Angular. | Yes |
| `get_env_vars` | Env vars referenced in source code with `required` (no fallback) and `hasDefault` flags. Supports JS/TS, Python, Go, and Ruby. | Yes |
| `get_middleware_inventory` | Detected middleware with type (auth/cors/rate-limit/validation/logging/error-handler) and framework. | Yes |

**Code quality**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_refactor_report` | Prioritized list of functions with structural issues: unreachable code, hub overload (high fan-in), god functions (high fan-out), SRP violations, cyclic dependencies. | Yes |
| `get_critical_hubs` | Highest-impact hub functions ranked by criticality. Each hub gets a stability score (0-100) and a recommended approach: extract, split, facade, or delegate. | Yes |
| `get_god_functions` | Detect god functions (high fan-out, likely orchestrators) in the project or in a specific file, and return their call-graph neighborhood. Use this to identify which functions need to be refactored and understand what logical blocks to extract. | Yes |
| `analyze_impact` | Deep impact analysis for a specific function: fan-in/fan-out, upstream call chain, downstream critical path, risk score (0-100), blast radius, and recommended strategy. | Yes |
| `get_low_risk_refactor_candidates` | Safest functions to refactor first: low fan-in, low fan-out, not a hub, no cyclic involvement. Best starting point for incremental, low-risk sessions. | Yes |
| `get_leaf_functions` | Functions that make no internal calls (leaves of the call graph). Zero downstream blast radius. Sorted by fan-in by default -- most-called leaves have the best unit-test ROI. | Yes |

**Specs**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `get_spec` | Read the full content of an OpenSpec domain spec by domain name. | Yes (generate) |
| `get_mapping` | Requirement->function mapping produced by `openlore generate`. Shows which functions implement which spec requirements, confidence level, and orphan functions with no spec coverage. | Yes (generate) |
| `get_decisions` | List or search Architecture Decision Records (ADRs) stored in `openspec/decisions/`. Optional keyword query. | Yes (generate) |
| `check_spec_drift` | Detect code changes not reflected in OpenSpec specs. Compares git-changed files against spec coverage maps. Issues: gap / stale / uncovered / orphaned-spec / adr-gap. | Yes (generate) |
| `search_specs` | Semantic search over OpenSpec specifications to find requirements, design notes, and architecture decisions by meaning. Also searches ADR files (`openspec/decisions/adr-*.md`) indexed under domain `decisions`. Returns linked source files for graph highlighting. Use this when asked "which spec covers X?" or "where should we implement Z?" or "what decisions were made about Y?". Requires a spec index built with `openlore analyze` or `--reindex-specs`. | Yes (generate) |
| `list_spec_domains` | List all OpenSpec domains available in this project. Use this to discover what domains exist before doing a targeted `search_specs` call. | Yes (generate) |
| `audit_spec_coverage` | Parity audit: uncovered functions (in call graph, no spec), hub gaps (high fan-in + no spec), orphan requirements (spec with no implementation found), and stale domains (source changed after spec). Run before starting a feature to understand coverage health. No LLM required. | Yes (analyze) |

**Decisions**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `record_decision` | Record an architectural decision before writing code. Triggers background consolidation immediately — by commit time, decisions are already verified and the gate adds no LLM latency. | No |
| `list_decisions` | List decisions in the store, optionally filtered by status (`draft`, `consolidated`, `verified`, `approved`, `synced`, `phantom`). | No |
| `approve_decision` | Approve one or more decisions by ID, marking them ready to sync into specs and ADRs. | No |
| `reject_decision` | Reject a decision by ID with a reason. Rejected decisions are excluded from sync. | No |
| `sync_decisions` | Write approved decisions into OpenSpec spec.md files (as requirements) and create ADR files in `openspec/decisions/`. Append-only — never rewrites existing content. After sync, inactive decisions (synced/rejected/phantom) are purged from the store — their content lives in ADRs and git. Pass `dryRun: true` to preview. | No |

**Story Management**

| Tool | Description | Requires prior analysis |
|------|-------------|:---:|
| `generate_change_proposal` | Generate a structured change proposal for a feature: affected functions, risk score, insertion points, spec impact, and a ready-to-use story file. Use during sprint planning or before implementing a non-trivial change. | Yes |
| `annotate_story` | Annotate an existing story file with structural context: risk score, affected functions, recommended insertion point, and spec domain links. Prepares a story for the dev agent so it can skip the orientation step. | Yes |

### Parameters

**`orient`**
```
directory  string   Absolute path to the project directory
task       string   Natural-language description of the task, e.g. "add rate limiting to the API"
limit      number   Max relevant functions to return (default: 5, max: 20)
```

Response includes `suggestedTools: string[]` — a ranked list of spec-gen tool names relevant to the task, derived from hub presence, spec domains, and task keywords. No extra I/O. Use this on clients without Tool Search (Cline, Cursor, OpenCode) to know which tools to call next without enumerating all 45.

**`analyze_codebase`**
```
directory  string   Absolute path to the project directory
force      boolean  Force re-analysis even if cache is fresh (default: false)
```

**`get_refactor_report`**, **`get_call_graph`**
```
directory  string   Absolute path to the project directory
```

**`get_signatures`**
```
directory    string   Absolute path to the project directory
filePattern  string   Optional path substring filter (e.g. "services", ".py")
```

**`get_subgraph`**
```
directory     string   Absolute path to the project directory
functionName  string   Function name to centre on (case-insensitive partial match)
direction     string   "downstream" | "upstream" | "both"  (default: "downstream")
maxDepth      number   BFS traversal depth limit  (default: 3)
format        string   "json" | "mermaid"  (default: "json")
```

*Note: If no exact name match is found, `get_subgraph` falls back to semantic search (when a vector index is available) to find the most similar function.*

**`get_mapping`**
```
directory    string    Absolute path to the project directory
domain       string    Optional domain filter (e.g. "auth", "crawler")
orphansOnly  boolean   Return only orphan functions (default: false)
```

**`get_duplicate_report`**
```
directory  string   Absolute path to the project directory
```

**`check_spec_drift`**
```
directory  string    Absolute path to the project directory
base       string    Git ref to compare against (default: auto-detect main/master)
files      string[]  Specific files to check (default: all changed files)
domains    string[]  Only check these spec domains (default: all)
failOn     string    Minimum severity to report: "error" | "warning" | "info" (default: "warning")
maxFiles   number    Max changed files to analyze (default: 100)
```

**`list_spec_domains`**
```
directory  string   Absolute path to the project directory
```

**`analyze_impact`**
```
directory  string   Absolute path to the project directory
symbol     string   Function or method name (exact or partial match)
depth      number   Traversal depth for upstream/downstream chains (default: 2)
```

*Note: If no exact name match is found, `analyze_impact` falls back to semantic search (when a vector index is available) to find the most similar function.*

**`get_low_risk_refactor_candidates`**
```
directory    string   Absolute path to the project directory
limit        number   Max candidates to return (default: 5)
filePattern  string   Optional path substring filter (e.g. "services", ".py")
```

**`get_leaf_functions`**
```
directory    string   Absolute path to the project directory
limit        number   Max results to return (default: 20)
filePattern  string   Optional path substring filter
sortBy       string   "fanIn" (default) | "name" | "file"
```

**`get_critical_hubs`**
```
directory  string   Absolute path to the project directory
limit      number   Max hubs to return (default: 10)
minFanIn   number   Minimum fan-in threshold to be considered a hub (default: 3)
```

**`get_architecture_overview`**
```
directory  string   Absolute path to the project directory
```

**`get_function_skeleton`**
```
directory  string   Absolute path to the project directory
filePath   string   Path to the file, relative to the project directory
```

**`get_function_body`**
```
directory     string   Absolute path to the project directory
filePath      string   Path to the file, relative to the project directory
functionName  string   Name of the function to extract
```

**`get_file_dependencies`**
```
directory  string   Absolute path to the project directory
filePath   string   Path to the file, relative to the project directory
direction  string   "imports" | "importedBy" | "both"  (default: "both")
```

**`trace_execution_path`**
```
directory       string   Absolute path to the project directory
entryFunction   string   Name of the starting function (case-insensitive partial match)
targetFunction  string   Name of the target function (case-insensitive partial match)
maxDepth        number   Maximum path length in hops (default: 6)
maxPaths        number   Maximum number of paths to return (default: 10, max: 50)
```

**`get_decisions`**
```
directory  string   Absolute path to the project directory
query      string   Optional keyword to filter ADRs by title or content
```

**`get_spec`**
```
directory  string   Absolute path to the project directory
domain     string   Domain name (e.g. "auth", "user", "api")
```

**`get_god_functions`**
```
directory        string   Absolute path to the project directory
filePath         string   Optional: restrict search to this file (relative path)
fanOutThreshold  number   Minimum fan-out to be considered a god function (default: 8)
```

**`suggest_insertion_points`**
```
directory    string   Absolute path to the project directory
description  string   Natural-language description of the feature to implement
limit        number   Max candidates to return (default: 5)
language     string   Filter by language: "TypeScript" | "Python" | "Go" | ...
```

**`search_code`**
```
directory  string   Absolute path to the project directory
query      string   Natural-language query, e.g. "authenticate user with JWT"
limit      number   Max results (default: 10)
language   string   Filter by language: "TypeScript" | "Python" | "Go" | ...
minFanIn   number   Only return functions with at least this many callers
```

**`search_specs`**
```
directory  string   Absolute path to the project directory
query      string   Natural language query, e.g. "email validation workflow"
limit      number   Maximum number of results to return (default: 10)
domain     string   Filter by domain name (e.g. "auth", "analyzer")
section    string   Filter by section type: "requirements" | "purpose" | "design" | "architecture" | "entities"
```

**`generate_change_proposal`**
```
directory     string   Absolute path to the project directory
description   string   Natural-language description of the change (story, intent, or spec delta)
slug          string   URL-safe identifier for the proposal (e.g. "add-payment-retry")
storyContent  string   Optional full story markdown to embed in the proposal
```

**`annotate_story`**
```
directory      string   Absolute path to the project directory
storyFilePath  string   Path to the story file (relative to project root or absolute)
description    string   Natural-language summary of the story for structural analysis
```

**`record_decision`**
```
directory             string    Absolute path to the project directory
title                 string    Short decision title (e.g. "Use Redis for session cache")
rationale             string    Why this approach was chosen
consequences          string    Trade-offs and impacts of this decision
affectedFiles         string[]  Source files involved (relative paths)
proposedRequirement   string    Optional: "The system SHALL …" requirement to add to specs
supersedes            string    Optional: ID of a prior decision this replaces
```

**`list_decisions`**
```
directory  string   Absolute path to the project directory
status     string   Optional filter: draft | consolidated | verified | approved | synced | phantom
```

**`approve_decision`**
```
directory  string    Absolute path to the project directory
ids        string[]  Decision IDs to approve
```

**`reject_decision`**
```
directory  string   Absolute path to the project directory
id         string   Decision ID to reject
reason     string   Reason for rejection
```

**`sync_decisions`**
```
directory  string    Absolute path to the project directory
dryRun     boolean   Preview changes without writing files (default: false)
```

### Typical workflow

**Scenario A -- Initial exploration**
```
1. analyze_codebase({ directory })                    # repo structure + call graph + top issues
2. get_call_graph({ directory })                      # hub functions + layer violations
3. get_duplicate_report({ directory })                # clone groups to consolidate
4. get_refactor_report({ directory })                 # prioritized refactoring candidates
```

**Scenario B -- Targeted refactoring**
```
1. analyze_impact({ directory, symbol: "myFunction" })       # risk score + blast radius + strategy
2. get_subgraph({ directory, functionName: "myFunction",     # Mermaid call neighbourhood
                  direction: "both", format: "mermaid" })
3. get_low_risk_refactor_candidates({ directory,             # safe entry points to extract first
                                      filePattern: "myFile" })
4. get_leaf_functions({ directory, filePattern: "myFile" })  # zero-risk extraction targets
```

**Scenario C -- Spec maintenance**
```
1. check_spec_drift({ directory })                    # code changes not reflected in specs
2. get_mapping({ directory, orphansOnly: true })      # functions with no spec coverage
```

**Scenario D -- Starting a new task (fastest orientation)**
```
1. orient({ directory, task: "add rate limiting to the API" })
   # Returns in one call:
   #   - relevant functions (semantic search or BM25 fallback)
   #   - source files and spec domains that cover them
   #   - call-graph neighbourhood for each top function
   #   - best insertion-point candidates
   #   - spec-linked peer functions (cross-graph traversal)
   #   - matching spec sections AND matching ADRs (domain "decisions")
   #   - active decisions touching the task's domains (pendingDecisions)
   #   - approved decisions always surfaced — must sync before committing
   #   - suggestedTools: ranked list of next tools to call based on task context
   #     (hub presence, spec domains, task keywords) — portable discovery for
   #     clients without Tool Search (Cline, Cursor, OpenCode)
2. get_spec({ directory, domain: "..." })             # read full spec before writing code
3. check_spec_drift({ directory })                    # verify after implementation
```

**Scenario E -- Coverage audit before implementing**
```
1. audit_spec_coverage({ directory })
   # Before writing code: surfaces stale domains, uncovered hub functions,
   # orphan requirements. 0 LLM calls, ~200ms.
2. If staleDomains includes your target: openlore generate --domains $DOMAIN
3. If hubGaps includes a function you'll touch: flag it in your risk check
```

**Scenario F -- Decisions workflow**
```
1. record_decision({ directory, title, rationale, consequences, affectedFiles })
   # Call this before writing code — captures the design choice
2. [implement the feature / refactor]
3. git commit  # decisions hook consolidates drafts, cross-checks against diff,
               # blocks commit if unreviewed decisions remain
   # If blocked, check "reason":
   #   "verified"              → present decisions to user, approve/reject, then sync
   #   "approved_not_synced"   → run sync_decisions, then retry commit
   #   "drafts_pending_consolidation" → run openlore decisions --consolidate --gate
   #   "no_decisions_recorded" → run openlore decisions --consolidate --gate
4. list_decisions({ directory, status: "verified" })
   # Review the consolidated + verified decisions
5. approve_decision({ directory, ids: ["<id>"] })
6. sync_decisions({ directory, dryRun: true })   # preview
7. sync_decisions({ directory })                  # write to specs and ADRs
```

---


## Semantic Search & GraphRAG

`openlore analyze` builds a vector index over all functions in the call graph, enabling natural-language search via the `search_code`, `orient`, and `suggest_insertion_points` MCP tools, and the search bar in the viewer.

### GraphRAG retrieval expansion

Semantic search is only the starting point. openlore combines three retrieval layers into every search result — this is what makes it genuinely useful for AI agents navigating unfamiliar codebases:

1. **Semantic seed** — dense vector search (or BM25 keyword fallback) finds the top-N functions closest in meaning to the query.
2. **Call-graph expansion** — BFS up to depth 2 follows callee edges from every seed function, pulling in the files those functions depend on. During `generate`, this ensures the LLM sees the full call neighbourhood, not just the most obvious files.
3. **Spec-linked peer functions** — each seed function's spec domain is looked up in the requirement→function mapping. Functions from the same spec domain that live in *different files* are surfaced as `specLinkedFunctions`. This crosses the call-graph boundary: implementations that share a spec requirement but are not directly connected by calls are retrieved automatically.

The result: a single `orient` or `search_code` call returns not just "functions that mention this concept" but the interconnected cluster of code and specs that collectively implement it. Agents spend less time chasing cross-file references manually and more time making changes with confidence.

### Embedding configuration

Provide an OpenAI-compatible embedding endpoint (Ollama, OpenAI, Mistral, etc.) via environment variables or `.openlore/config.json`:

**Environment variables:**
```bash
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=sk-...         # optional for local servers

# Then run (embedding is automatic when configured):
openlore analyze
```

**Config file (`.openlore/config.json`):**
```json
{
  "embedding": {
    "baseUrl": "http://localhost:11434/v1",
    "model": "nomic-embed-text",
    "batchSize": 64
  }
}
```

- `batchSize`: Number of texts to embed per API call (default: 64)

The index is stored in `.openlore/analysis/vector-index/` and is automatically used by the viewer's search bar and the `search_code` / `suggest_insertion_points` MCP tools.

