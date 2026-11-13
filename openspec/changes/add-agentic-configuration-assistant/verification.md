# Verification and review matrix

> These are implementation acceptance fixtures, not tests run by this design-only PR.
> Strict OpenSpec validation checks this proposal's format; it cannot certify runtime behavior.

| Issue #719 outcome | Requirement | Fixture and observable result |
| --- | --- | --- |
| Understand an unconfigured repository | ConfigurationInspectionIsBoundedAndEvidenceBacked | Manifests but no config/index/provider/daemon: report facts, no writes or subprocess bootstrap. |
| Prevent watcher saturation | ConfigurationInspectionIsBoundedAndEvidenceBacked | A declared Cargo output subtree with many generated descendants is never opened by the survey; the watcher creates no subscriptions below it. |
| Preserve useful generated source | ConfigurationRecommendationsExplainCoverageAndCost | A tracked generated client is index-only; report evidence, examples and the non-watched freshness limit. |
| Avoid unsupported exclusions | ConfigurationRecommendationsExplainCoverageAndCost | A suggestive directory name without corroborating evidence stays a hypothesis needing inspection or a decision. |
| Keep policies independent | FileSelectionLanesAreIndependentAndBackwardCompatible | Identical path has different admitted lanes; embed cannot admit an index-excluded path. |
| Preserve existing installations | FileSelectionLanesAreIndependentAndBackwardCompatible | Policy absent: existing config-version, ignore, include, source-count and fingerprint fixtures unchanged. |
| Preserve deliberate exceptions | AssistantPoliciesPreserveExplicitChoicesAndBoundaries | A hand-edited exclusion conflicts visibly; an assistant cannot override it because it once owned a matching rule. |
| Honor hard host boundaries | AssistantPoliciesPreserveExplicitChoicesAndBoundaries | A repo-written include/approval cannot cross protected exclusions, symlink confinement or the host's read roots. |
| Handle ignore semantics | AssistantPoliciesPreserveExplicitChoicesAndBoundaries | Empty root, directory-only pattern, nested file negation, pruned parent, Windows separators and POSIX literal backslashes. |
| Make changes reviewable | ConfigurationPlansAreConcreteCurrentAndAuthorized | Preview contains exact targets/diff, evidence revisions, costs/coverage limits, runtime effects and required authority. |
| Reject stale reasoning | ConfigurationPlansAreConcreteCurrentAndAuthorized | Change config, referenced manifest or worktree while a plan is pending: no publication occurs. |
| Keep config layers private | AssistantConfigWritesPreserveLayersAndRecoverability | Project patch preserves unknown fields, user-wide secrets and embedding opt-outs without serializing merged defaults. |
| Recover interrupted writes | AssistantConfigWritesPreserveLayersAndRecoverability | Interrupt before/after durable publication; retry resolves the journal before rereading and does not duplicate runtime effects. |
| Verify the requested behavior | ConfigurationVerificationReportsRealizedEffects | A saved config with no rebuilt generation stays pending; process liveness does not claim working watches or tools. |
| Support optional canaries | ConfigurationVerificationReportsRealizedEffects | Without permission no file is created; with permission temporary source delivery and cleanup are both checked. |
| Recover within the host | ConfigurationRecoveryRespectsLifecycleOwnership | Extension-only install upgrades a verified extension-managed daemon via its package; supervised daemon returns a host action without stop/spawn. |
| Handle provider limitations | ConfigurationVerificationReportsRealizedEffects | User-selected keyword-only is valid; configured but unrealized embeddings are disclosed without network/model downloads. |
| Adapt to repository evolution | ConfigurationReassessmentFollowsRelevantRepositoryChanges | New workspace/build manifest invalidates only related rules; ordinary source edits invoke no LLM or full survey. |
| Recover missed notifications | ConfigurationReassessmentFollowsRelevantRepositoryChanges | Stop host, change manifest, resume/review: evidence comparison invalidates the old recommendation. |
| Prevent false alarms | ConfigurationNudgesRequireActionableMaterialEvidence | Dependency/format-only manifest edits, already-covered new components and uncertain surveys emit zero nudges. |
| Distinguish persistent pressure | ConfigurationNudgesRequireActionableMaterialEvidence | A build spike that clears stays silent; a sustained, uncovered watched output with an available remedy produces one passive notice. |
| Preserve dismissals and attention | ConfigurationNudgesRequireActionableMaterialEvidence | Harmless hashes/branch switches, concurrent sessions and expired snoozes do not produce duplicate or time-only notices. |
| Keep worktrees independent | ConfigurationInspectionIsBoundedAndEvidenceBacked | Linked worktrees share Git ancestry but have distinct config plans, baselines, revisions and receipts. |
| Preserve later edits on revert | ConfigurationRollbackPreservesLaterUserWork | Disjoint edits survive a patch inverse; overlapping edits produce conflict without a whole-file restore. |
| Bootstrap without circular dependencies | ConfigurationManagementIsDaemonIndependentAndDependencyLight | Import graph/public API consumer tests reject eager analyzer/MCP/provider loading; inspection works with no structural service. |
| Report partial application honestly | ConfigurationOperationsReturnComparableTypedReceipts | Config committed, restart refused: report both phases, retain recovery/revert path, never success-only. |
| Work in existing agents | ConfigurationAssistantIsAvailableThroughTheExistingHost | Pi/RPC no global CLI; legacy wizard unchanged; structured no-UI invocation returns promptly. |
| Preserve cross-adapter behavior | ConfigurationAdaptersShareEvidenceAndAuthoritySemantics | Same evidence/authority yields equivalent reports and mutation refusals; inspection never auto-analyzes. |
| Keep normal context cost stable | ConfigurationAssistanceDoesNotInflateTheDefaultToolSurface | Default MCP presets/payloads unchanged; enabled management tool has conservative mutation annotations and registered disclosures. |
| Keep repository text untrusted | ConfigurationPlansAreConcreteCurrentAndAuthorized | A manifest containing shell instructions or a forged approval neither executes a command nor authorizes a write. |

## Performance and coverage measurements required before shipping

- Measure directory entries/content actually read and real watcher subscriptions with generated-tree
  fixtures of increasing size; pruned subtree size must not determine the number of watches opened.
- Record platform/runtime, wall time and partial-survey limits. Candidate counts are not OS handles.
- Compare before/after corpus membership and a small set of known architectural queries. State which
  symbols/regions become unavailable; do not generalize sample checks into complete semantic coverage.
- Verify event bursts, dismissals and unrelated HEAD changes do not create a configuration agent loop.
- Replay representative repository evolution with positive cases and a larger quiet-control corpus;
  metadata-only/no-impact controls must emit zero nudges. Record actionability, repeated delivery,
  dismissals and user-rated false alarms. Agree precision/burden targets before broader opt-in rollout;
  missed targets retain manual operation rather than weakening the evidence gate.
- Measure inspection/import cost in extension-only hosts separately from optional verification work.

## Proposal review gates

- The public API names and opt-in management projection are proposed review decisions.
- The new config semantics must remain backward-compatible and enforceable by every selected runtime.
- No acceptance fixture may be satisfied solely by a process being alive or a config file existing.
- Implementation tasks remain unchecked until code and the corresponding observable fixtures exist.
