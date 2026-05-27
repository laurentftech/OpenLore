# OpenLore Spec 06 — BM25-Only Search Index Without Embeddings

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Context for you (the agent)

OpenLore's headline tools — `orient`, `search_code`, `suggest_insertion_points` — depend on a search index built by `openlore analyze`. The index is a hybrid retriever: dense ANN (vector embeddings) **fused with** sparse BM25 keyword scoring via Reciprocal Rank Fusion. The dense half needs an embedding endpoint; the sparse half does not.

The product promises that embeddings are **optional**:

- README → "Known Limitations": *"Embedding is optional: without an embedding endpoint, `orient` and `search_code` fall back to BM25 keyword search (still useful, less accurate for semantic queries)."*
- `orient`'s own error hint ([src/core/services/mcp-handlers/orient.ts:163](../../src/core/services/mcp-handlers/orient.ts#L163)): *"With BM25 fallback, `openlore analyze` alone (no `--embed`) is also sufficient."*

**That promise is currently broken.** A QA pass before v2.0.3 found that a user without an embedding endpoint gets `{"error":"No analysis found. Run \"openlore analyze --embed\" first."}` from `orient` and `search_code`, because the index is never built at all.

### Root cause (verified)

The retriever is *designed* to degrade to BM25 — `VectorIndex.search` takes `embedSvc: EmbeddingService | null` and routes to `_bm25Only(...)` when there is no embedder ([src/core/analyzer/vector-index.ts:434](../../src/core/analyzer/vector-index.ts#L434)), and `_bm25Only` reads only `text`/`id`/`name`/`fanIn` (never the `vector` column; see `rowToRecord` at [vector-index.ts:65](../../src/core/analyzer/vector-index.ts#L65)). The bug is on the **build** side:

- The analyze pipeline resolves an `EmbeddingService` and **throws** when none is configured, aborting the entire index build before `VectorIndex.build` is ever called: [src/cli/commands/analyze.ts:756-815](../../src/cli/commands/analyze.ts#L756-L815) (`EmbeddingService.fromEnv()` throws → config fallback throws "No embedding config found" → caught → prints `✗ Vector index failed`).
- `VectorIndex.build` itself requires a non-null `embedSvc` and calls `embedSvc.embed(...)` unconditionally ([vector-index.ts:244](../../src/core/analyzer/vector-index.ts#L244), [:362](../../src/core/analyzer/vector-index.ts#L362)).

Net effect: with no embedding endpoint, **no `vector-index/` table is created**, so `VectorIndex.exists()` is false, so every retrieval path returns "No analysis found." The BM25-only code is unreachable in practice.

### Why it matters

The majority of new users have no embedding endpoint configured on first run. For them, the single most valuable capability of OpenLore — `orient` — does not work out of the box, contradicting the documentation. This was masked because the MCP end-to-end tests are excluded from CI (`vitest run` excludes `*.integration.test.ts`); 4 of those tests fail today purely because of this bug.

## Scope contract — do not break these things

This PR must NOT:

- Change the wire/JSON shape of `orient`, `search_code`, `search_specs`, or any MCP tool **result**. Consumers must not need to know whether the index has embeddings.
- Regress the embeddings-present path. When an embedding endpoint **is** configured, behaviour (hybrid dense+BM25 via RRF) must be byte-for-byte unchanged.
- Add a new runtime dependency. BM25 already exists in-repo.
- Make embeddings *worse* to obtain. `openlore analyze --embed` (or `EMBED_*`/config present) must still build the full hybrid index exactly as today.
- Silently produce a dense index over fake vectors. A BM25-only index must never be searched with ANN (that would return garbage or crash on a dimension mismatch).

This PR must:

- Make `openlore analyze` build a usable **keyword (BM25) search index** whenever a call graph exists, **with or without** an embedding service.
- Make `VectorIndex.search` (and the MCP handlers) transparently serve BM25 results from a no-embedding index, and **force BM25** (never ANN) when the index was built without embeddings — even if an `embedSvc` is supplied at query time.
- Be deterministic: building twice on the same graph with no embeddings produces the same index, and BM25 ranking for a fixed query + corpus is stable.
- Tell the user clearly what happened ("Built keyword search index — set `EMBED_*` for semantic search") instead of `✗ Vector index failed`.

## The deliverable

### Behavioural change (function index — Phase 1, required)

1. **`analyze` no longer aborts without embeddings.** In [analyze.ts:756-815](../../src/cli/commands/analyze.ts#L756-L815), resolving the embedding service must become *best-effort*: if `EmbeddingService.fromEnv()`/`fromConfig()` yields nothing, set `embedSvc = null` and continue to `VectorIndex.build(..., embedSvc=null, ...)`. Replace the `✗ Vector index failed: No embedding config found` message with an informational `✓ Built keyword (BM25) search index (N functions) — set EMBED_BASE_URL/EMBED_MODEL or add "embedding" to .openlore/config.json for semantic search.` A genuine embedding *failure* (endpoint configured but unreachable) should still warn, and should also fall back to building the BM25-only index rather than producing nothing.

2. **`VectorIndex.build` accepts `embedSvc: EmbeddingService | null`.** When null:
   - Skip embedding entirely (no `embedSvc.embed` call, no incremental vector reuse).
   - Write the corpus records **without** a `vector` column (the column is unused by BM25; omitting it avoids implying ANN capability). `FunctionRecord`/`rowToRecord` already separate the vector; ensure the no-vector write path is type-clean.
   - Write a sidecar metadata file (see below) recording `hasEmbeddings: false`.

3. **Index metadata sidecar.** Write `<outputDir>/vector-index-meta.json` (sibling to the LanceDB `vector-index/` folder, so it never interferes with LanceDB internals) on every build:
   ```json
   { "hasEmbeddings": false, "dim": 0, "model": null, "builtAt": "<iso>", "schemaVersion": 1 }
   ```
   When embeddings are present, `hasEmbeddings: true`, `dim`/`model` populated. This file is the **single source of truth** for whether ANN is available.

4. **`VectorIndex.search` honours the sidecar.** Load the meta; if `hasEmbeddings === false`, route to `_bm25Only` **regardless** of whether an `embedSvc` was passed (do not attempt to embed the query or run ANN against a vector-less table). Keep the existing behaviour when `hasEmbeddings === true`. Preserve the existing "embedding endpoint unreachable → BM25" fallback ([vector-index.ts:443-444](../../src/core/analyzer/vector-index.ts#L443)).

5. **Incremental build path.** The incremental branch reads `row.vector` from the existing table ([vector-index.ts:322-341](../../src/core/analyzer/vector-index.ts#L322)). Guard it on `hasEmbeddings`: for a no-embedding index, skip vector reuse (there are none) and just rebuild the corpus rows. If a previously-embedded index is rebuilt with `embedSvc=null`, rebuild it as BM25-only (overwrite) and update the meta to `hasEmbeddings: false` — predictable and documented, not a silent half-state.

6. **Watch path.** `McpWatcher` calls `VectorIndex.build(..., embedSvc, ...)` ([src/core/services/mcp-watcher.ts:252](../../src/core/services/mcp-watcher.ts#L252)). It must pass `null` cleanly when no embedder is available and not crash.

7. **Handler error messages.** Audit the handlers that gate on the index — `orient` ([orient.ts:163](../../src/core/services/mcp-handlers/orient.ts#L163)) and `search_code`/semantic ([src/core/services/mcp-handlers/semantic.ts](../../src/core/services/mcp-handlers/semantic.ts)). After the fix, `VectorIndex.exists()` is true for a BM25-only index, so the "No analysis found" path should no longer fire spuriously. Where a "no index" error is still legitimately reachable (graph never analyzed at all), keep it but ensure the hint matches reality (plain `openlore analyze` now suffices).

### Spec index (Phase 2 — in scope if it stays clean; otherwise ship Phase 1 and leave a TODO)

`search_specs` uses `SpecVectorIndex` ([src/core/analyzer/spec-vector-index.ts](../../src/core/analyzer/spec-vector-index.ts)), which today has **no BM25 path at all** — both `build` and `search` require `embedSvc` and call `embedSvc.embed(...)`. Mirror the function-index design: add a `_bm25Only`-equivalent sparse scorer for specs, accept `embedSvc: null` in build/search, and write the same meta sidecar for the spec table. If adding a sparse scorer to the spec index meaningfully balloons the PR, ship Phase 1 and leave `TODO(spec-06-followup): BM25 fallback for spec index (search_specs)` plus a clear, non-crashing message from `search_specs` when no embeddings are configured. **Do not** let `search_specs` throw an unhandled error.

### Design decisions to pin (do not invent ad-hoc)

- **Source of truth for ANN availability** = the `vector-index-meta.json` sidecar, not the presence of a `vector` column or a try/catch. Search reads it once and caches per `dbPath` alongside the existing `_bm25Cache`/`_tableCache`.
- **No placeholder vectors.** Do not write zero/constant vectors to fake a dense index; omit the column. This keeps "is ANN possible" unambiguous and avoids dimension-mismatch foot-guns.
- **Downgrade is explicit.** Rebuilding an embedded index without an embedder converts it to BM25-only (overwrite + meta update), surfaced in the analyze output.
- **BM25 determinism.** Tokenization and scoring are already deterministic ([vector-index.ts:96-132](../../src/core/analyzer/vector-index.ts#L96)); ensure result ordering ties break deterministically (e.g. by `id`) so the same query+corpus yields identical ranked output across runs.

## Files you will create or modify (approximate)

```
src/core/analyzer/vector-index.ts        # build(embedSvc|null), meta sidecar, search() honours meta, incremental guard
src/core/analyzer/spec-vector-index.ts   # Phase 2: BM25 path + embedSvc|null (or scoped TODO)
src/cli/commands/analyze.ts              # don't abort without embeddings; build BM25-only; informational message
src/core/services/mcp-watcher.ts         # pass embedSvc=null cleanly on the watch rebuild path
src/core/services/mcp-handlers/orient.ts # error/hint only fires when truly no index
src/core/services/mcp-handlers/semantic.ts # search_code: same
README.md                                # "Known Limitations": BM25 now works out of the box (reword)
docs/…                                   # any analyze/search doc that claims --embed is required
src/core/analyzer/vector-index.test.ts   # unit tests for the no-embedding build + search
src/cli/commands/mcp.e2e.integration.test.ts  # the 4 currently-failing tests must pass without embeddings
```

## Acceptance criteria

1. On a repo with **no** `EMBED_*` env and no `embedding` config, `openlore analyze` creates `<outputDir>/vector-index/` and `<outputDir>/vector-index-meta.json` with `hasEmbeddings: false`, and prints a clear "keyword index built" message (no `✗ Vector index failed`).
2. With no embeddings, `orient` and `search_code` return **ranked results** (not `{"error":"No analysis found"}`) for a query that matches indexed functions. Assert against the OpenLore repo itself in an integration test.
3. The 4 currently-failing cases in [mcp.e2e.integration.test.ts](../../src/cli/commands/mcp.e2e.integration.test.ts) (orient task echo, `search_code` query echo, and the two result-content assertions) pass **without** an embedding endpoint. The full MCP e2e suite is green.
4. `VectorIndex.search` against a `hasEmbeddings: false` index never calls `embedSvc.embed` and never runs ANN, **even when an `embedSvc` is passed** — proven by a unit test with a throwing/spy embedder.
5. **No regression with embeddings:** with a (mocked) embedder, `build` + `search` produce the same hybrid RRF results as before this change; `vector-index-meta.json` records `hasEmbeddings: true` with the correct `dim`. A test locks this.
6. Determinism: building twice with no embeddings yields identical index contents, and a fixed BM25 query over a fixed corpus yields identical ranked ids across runs.
7. Upgrade path: a BM25-only index, re-analyzed with an embedder configured, becomes a full hybrid index (`hasEmbeddings: true`); and the reverse downgrades predictably with a surfaced message.
8. Watch mode (`openlore mcp --watch`) does not crash on a file change when no embedder is configured; the incremental rebuild keeps the BM25 index usable.
9. README "Known Limitations" (and any doc claiming `--embed` is required for `orient`) is updated to reflect that plain `openlore analyze` now yields a working keyword index.
10. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass. Run the MCP integration suite (`npm run test:integration`) and confirm the function-index tests pass.

## Test plan (be methodical)

- **Unit (`vector-index.test.ts`)** — hermetic, temp `outputDir`, synthetic nodes/signatures:
  - build with `embedSvc=null` → `exists()` true, meta `hasEmbeddings:false`, no `vector` column written.
  - search with `embedSvc=null` → BM25 results, correct fields, deterministic order.
  - search with a **spy** `embedSvc` against a `hasEmbeddings:false` index → spy.embed **not** called; BM25 results returned.
  - build with a mock embedder → meta `hasEmbeddings:true`, dense+BM25 RRF path exercised; results match the pre-change snapshot.
  - incremental rebuild on a no-embedding index → no crash, corpus refreshed.
  - downgrade (embedded → null rebuild) and upgrade (null → embedded rebuild) transitions.
- **Integration (`mcp.e2e.integration.test.ts`)** — the suite already auto-skips when the analysis cache is missing; ensure it runs against a BM25-only cache and the 4 previously-failing tests pass.
- **CI gap (note, optional within this PR):** integration tests are excluded from the CI `Unit Tests` job, which is why this bug shipped. Consider a minimal CI step that builds a BM25-only index for a tiny fixture and asserts `orient` returns results — so this can never silently regress. If out of scope here, leave `TODO(spec-06-followup): exercise BM25 search path in CI`.

## Git workflow — read carefully

1. Branch: `openlore-spec-06-bm25-index` off the default branch (after v2.0.3 is tagged, unless directed otherwise).
2. **Open exactly one PR** titled `spec-06: BM25-only search index without embeddings`. The body must show, against the OpenLore repo with `EMBED_*` unset: the `openlore analyze` output (the new "keyword index built" line), and an `orient` invocation returning real results.
3. All follow-up commits push to the same PR. Never open a second PR.
4. Treat `VectorIndex` as a high-fan-in hub: prefer additive, guarded changes; do not refactor the dense path while you are here. Record the architectural decision (the meta sidecar as the ANN-availability source of truth) before writing code, per the repo's decision-gate workflow.
5. Run `lint`, `typecheck`, `test:run`, `build` (and the integration suite) before every push.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.

---

## Completion log (2026-05-27)

Status: **Phase 1 and Phase 2 both complete.** Branch `openlore-spec-06-bm25-index`.

### Architectural decision (pinned)

**The `vector-index-meta.json` sidecar is the single source of truth for whether ANN
(dense) search is available** — not the presence of a `vector` column and not a try/catch.
- A keyword-only index is written **without** a `vector` column and a sidecar with
  `hasEmbeddings: false`. Search reads the sidecar (cached per `dbPath` alongside
  `_bm25Cache`/`_tableCache`) and **forces BM25** when `hasEmbeddings === false`, even if an
  `embedSvc` is supplied at query time — so the query is never embedded and ANN never runs
  against a vector-less table.
- A missing sidecar (legacy index built before this change) is treated as
  `hasEmbeddings: true`, preserving pre-change behaviour for those indexes.
- No placeholder/zero vectors are ever written. Downgrade (embedded → null rebuild) and
  upgrade (null → embedded rebuild) are explicit overwrites that update the sidecar, and the
  analyze output states which index was built.
- The spec index uses the **same design** with its own sidecar `spec-index-meta.json`
  (separate file so the function and spec tables can have independent embedding states).

### What changed

- `src/core/analyzer/embedding-service.ts` — added `get modelName()` (recorded in the sidecar).
- `src/core/analyzer/vector-index.ts` — `build(embedSvc: … | null)`; BM25-only build path
  (no `vector` column); meta sidecar read (cached) + write; `search()` honours the sidecar and
  forces BM25 when `hasEmbeddings:false`; incremental vector reuse guarded on the existing
  sidecar; deterministic BM25 tie-break by `id`; exported `tokenize`/`buildBm25Corpus`/`bm25Score`
  for spec-index reuse; `build` returns `{ embedded, reused, total, hasEmbeddings }`.
- `src/core/analyzer/spec-vector-index.ts` — Phase 2: `build`/`search` accept `embedSvc | null`;
  BM25-only build + `_bm25Only` search; `spec-index-meta.json` sidecar.
- `src/cli/commands/analyze.ts` — embedding resolution is best-effort (no abort); a configured-but-
  failing embedder warns and falls back to BM25; new "Built keyword (BM25) search index" message;
  spec indexing builds BM25-only when no embedder.
- `src/core/services/mcp-watcher.ts` — passes `null` cleanly; refreshes the BM25 corpus in watch mode.
- `src/core/services/mcp-handlers/orient.ts`, `semantic.ts` — "no index" hints now say plain
  `openlore analyze` suffices; `search_code`/`suggest_insertion_points`/`search_specs` fall back to
  BM25 (no error) when no embedder; `search_specs` reports `searchMode: bm25_fallback`.
- `README.md` — "Known Limitations" reworded: plain `analyze` yields a working keyword index.
- Tests: `vector-index.test.ts` (no-embedding build/search, spy-embedder-not-called, determinism,
  dim, incremental, downgrade/upgrade); updated handler/watcher tests to the new fallback contract;
  fixed a pre-existing stale assertion in `mcp.e2e.integration.test.ts` (`analyze_impact` now returns
  `{ matches }` for FTS multi-match — unrelated to embeddings, failing on `main` too).

### Verification

`lint`, `typecheck`, `test:run` (2821 passed), `build`, and `test:integration` (110 passed, incl. the
4 previously-failing orient/search_code cases) all green. `openlore analyze` with `EMBED_*` unset
prints `✓ Built keyword (BM25) search index (N functions)` and writes
`vector-index-meta.json` / `spec-index-meta.json` with `hasEmbeddings:false`.

### Follow-ups (left as TODOs, out of scope here)

- `TODO(spec-06-followup): exercise BM25 search path in CI` — integration tests are still excluded
  from the CI Unit Tests job, which is how this bug originally shipped.
- The `analyze_impact` FTS multi-match shape (`{ matches }`) vs. flat result is a separate
  handler/test contract question worth revisiting.
