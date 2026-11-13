# Implementation tasks

> Design-only proposal. Every implementation task remains open; this checklist is not a claim of
> shipped behavior. See `verification.md` for the requirement-to-fixture matrix.

## 1. Review contracts and compatibility

- [ ] 1.1 Confirm proposed package/API/command names and opt-in MCP projection; keep default tool surfaces unchanged.
- [ ] 1.2 Confirm file-policy precedence against standalone includes, restricted includes, protected exclusions, global layers and explicit config paths.
- [ ] 1.3 Define typed report/plan/receipt versions and stable outcome/disclosure codes.
- [ ] 1.4 Confirm bounded survey defaults, runtime-state retention and host lifecycle/canary interfaces.

## 2. Build bounded repository inspection

- [ ] 2.1 Add a provider-free configuration core and dependency-light public export that work without config, index or daemon.
- [ ] 2.2 Inspect manifests, workspace boundaries, declared outputs, Git tracking/ignore rules and existing policy within streamed entry/content/depth/time budgets.
- [ ] 2.3 Prune ignored/dependency/output subtrees before descending; reuse one ignore dialect with nested negations, directory-only rules and path-confinement guards.
- [ ] 2.4 Return source-attributed facts, hypotheses, representative paths, partial-coverage disclosures and revision-bound continuations.
- [ ] 2.5 Compose runtime/config observations from existing health, ownership and descriptor contracts without starting services or scanning the whole corpus.
- [ ] 2.6 Exclude credentials and untrusted execution instructions from diagnostic evidence.

## 3. Implement independent selection policies

- [ ] 3.1 Add typed/schema-versioned optional lane policies with exact legacy behavior when absent.
- [ ] 3.2 Resolve index/watch/embed decisions through one shared evaluator and expose conflicts with existing operator choices.
- [ ] 3.3 Enforce protected scopes and index-subset embedding; explicit index exceptions must not implicitly open watches.
- [ ] 3.4 Persist accepted reasons/evidence references without treating repo metadata as authorization.
- [ ] 3.5 Bind index fingerprints, watcher policy revision, source counts and embedding selection to the applicable policy revision.
- [ ] 3.6 Disclose staleness for changed non-watched inputs rather than continuing to claim freshness.

## 4. Preview, apply and revert

- [ ] 4.1 Produce a concrete normalized diff, impact evidence, conflicts, proposed verification and required host permissions.
- [ ] 4.2 Validate plans from untrusted adapters and bind authorization to exact worktree, targets, operations and revisions.
- [ ] 4.3 Under per-target locking/recovery, reread raw layers and relevant evidence; reject stale plans without writing.
- [ ] 4.4 Publish one confined project config atomically while preserving unknown fields, inherited opt-outs and user edits.
- [ ] 4.5 Journal operation identity and per-phase outcomes so retries cannot duplicate runtime effects.
- [ ] 4.6 Implement revision-checked patch rollback; refuse overlapping later edits and report unreversed runtime effects.

## 5. Verify realized behavior and recover runtime

- [ ] 5.1 Implement observational verification for effective selection, analysis generation, watcher subscriptions and configured embedding state.
- [ ] 5.2 Represent pending/unavailable observations separately from verified effects.
- [ ] 5.3 Add an optional authorized canary with bounded delivery wait and verified source/index cleanup.
- [ ] 5.4 Recover an extension-managed incompatible daemon through the installed package and authenticated lifecycle path.
- [ ] 5.5 Respect spawn opt-outs and route externally supervised recovery through the host callback; disclose impact to shared sessions.
- [ ] 5.6 Preserve config publication and verification outcomes separately when a restart, rebuild or provider is unavailable.

## 6. Integrate the host surfaces

- [ ] 6.1 Add a host-agent workflow skill that uses evidence, explains alternatives and preserves user intent without an internal LLM loop.
- [ ] 6.2 Extend Pi's configure command/tool without breaking the existing wizard; support RPC structured results without a mandatory terminal.
- [ ] 6.3 Add the optional MCP management projection, per-action authorization, conservative annotations, conclusion/disclosure registration and default-surface guards.
- [ ] 6.4 Add the optional CLI/API adapters over the same core; validate parity across success, stale, partial and refused operations.
- [ ] 6.5 Cover packaged extension-only installs, absent/incompatible daemons, missing UI and unknown host capabilities.

## 7. Track repository evolution

- [ ] 7.1 Keep bounded, private per-worktree evidence baselines and accepted-rule associations.
- [ ] 7.2 Coalesce relevant manifest/ignore/config/topology/resource signals; never run an agent or full scan per edit.
- [ ] 7.3 Target reassessment to affected rules/subtrees, retain user choices, and surface hypotheses needing a decision.
- [ ] 7.4 Revalidate after missed events, branch changes and host restarts; deduplicate notifications by evidence revision.
- [ ] 7.5 Implement manual review by default and opt-in notifications without automatic policy application.
- [ ] 7.6 Separate candidate signals from the notification gate: require material evidence, an uncovered discrepancy and an available scoped action; stay silent on uncertainty.
- [ ] 7.7 Add transient suppression, persistence and hysteresis for resource signals; measure thresholds and delivery budgets before shipping.
- [ ] 7.8 Deduplicate by unresolved semantic condition across harmless evidence revisions and host sessions; preserve dismissals and recheck snoozed conditions before delivery.
- [ ] 7.9 Deliver one passive, grouped notice at a host-appropriate idle/status point; avoid modals, repeated toasts and duplicate runtime-error reporting.
- [ ] 7.10 Validate precision and notification burden on positive fixtures and a larger quiet-control corpus; do not broaden notification rollout if the agreed targets are missed.

## 8. Release verification and documentation

- [ ] 8.1 Implement every acceptance fixture in `verification.md` on supported Linux, Windows and Node versions.
- [ ] 8.2 Measure bounded discovery and actual watch subscriptions on large generated trees; do not infer exact handles or speedups from samples.
- [ ] 8.3 Prove new policy omission leaves existing selection/fingerprints/config behavior unchanged.
- [ ] 8.4 Check config schema/version fixtures, API consumer/import graph, tool annotations/counts/payload budgets, completeness disclosures and Pi/MCP parity.
- [ ] 8.5 Run strict OpenSpec validation, lint, typecheck, relevant unit and deterministic integration suites.
- [ ] 8.6 Document the host workflow, exception precedence, partial verification, rollback, provider/network opt-ins and notification controls.
