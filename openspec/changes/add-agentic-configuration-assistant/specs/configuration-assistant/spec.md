# Configuration assistant specification delta

## ADDED Requirements

### Requirement: ConfigurationInspectionIsBoundedAndEvidenceBacked

Inspection SHALL work without config, index, daemon, generation provider or global CLI. It SHALL
bound entries, depth, bytes, time and examples; prune excluded subtrees before descent; attribute
facts to evidence revisions; label hypotheses; and disclose partial, unreadable or unsupported
evidence. It SHALL NOT execute repository code or download models to classify files.

#### Scenario: An unconfigured repository can be inspected
- **GIVEN** an authorized repository with manifests but no OpenLore config, index or daemon
- **WHEN** the host requests inspection
- **THEN** a bounded report describes the available evidence and missing runtime state
- **AND** no service, analysis, provider request or configuration write starts

#### Scenario: A large build tree is pruned before exploration
- **GIVEN** a declaratively excluded build directory containing many generated files
- **WHEN** the survey reaches that directory
- **THEN** it records the exclusion without traversing descendants or allocating their watches
- **AND** it does not claim to have counted every descendant

#### Scenario: A survey reaches its budget
- **GIVEN** a repository larger than the inspection budget
- **WHEN** an entry, depth, byte or time limit is reached
- **THEN** the report names its incomplete scope and offers a revision-bound continuation
- **AND** unvisited paths are not presented as absent or fully classified

### Requirement: ConfigurationRecommendationsExplainCoverageAndCost

Each recommendation SHALL identify its evidence, selected paths and lanes, representative matches,
reason, uncertainty, conflicts with existing choices, and expected resource and coverage tradeoffs.
Git ignore rules SHALL be treated as evidence and an applicable boundary, not proof that every
ignored file is architecturally irrelevant. Estimated file counts SHALL NOT be described as exact
OS watch-handle counts, measured performance gains or guaranteed semantic coverage.

#### Scenario: A generated client is useful architectural evidence
- **GIVEN** a tracked generated client and a declared generator whose output contains API bindings
- **WHEN** the agent recommends a policy
- **THEN** it can propose retaining structural indexing while excluding live watching and embeddings
- **AND** it explains the evidence, coverage benefit and freshness tradeoff

#### Scenario: A directory name is insufficient evidence
- **GIVEN** a directory whose name suggests generated output but whose purpose is unconfirmed
- **WHEN** the assistant proposes an exclusion
- **THEN** it presents a hypothesis and a decision or inspection needed to resolve it
- **AND** it does not treat that name alone as authorization to remove coverage

### Requirement: ConfigurationPlansAreConcreteCurrentAndAuthorized

Preview SHALL expose the exact diff, targets, revisions, required authority, runtime effects and
verification criteria. Apply SHALL validate the plan and host authorization, recheck preconditions
under coordination and refuse stale or unsupported plans without writes. Repository approval
fields SHALL NOT grant authority. Existing authorization covering the exact operation SHALL
remain usable without an additional approval requirement.

#### Scenario: A concurrent config edit invalidates a preview
- **GIVEN** a preview bound to configuration revision A
- **WHEN** another session writes revision B before application
- **THEN** apply returns a stale-plan outcome and leaves revision B unchanged

#### Scenario: A build manifest changes after preview
- **GIVEN** a recommendation bound to a manifest declaring an output directory
- **WHEN** that manifest changes before the recommendation is applied
- **THEN** apply requires a refreshed plan rather than applying the stale output rule

#### Scenario: A repository forges an approval field
- **GIVEN** a serialized plan with an approval claim but no trusted authorization context
- **WHEN** a mutating action is requested
- **THEN** the action is refused and neither configuration nor runtime state is changed

### Requirement: ConfigurationVerificationReportsRealizedEffects

The assistant SHALL distinguish configuration publication, runtime activation and functional
verification. It SHALL verify each claimed effect using corresponding runtime or artifact
evidence and report unavailable observations as pending or not assessed. A live process or
valid config SHALL NOT alone prove a working watcher, compatible tool surface, rebuilt corpus
or realized embedding selection. Keyword-only operation SHALL remain valid when selected.

#### Scenario: Configuration is saved but a rebuild is pending
- **GIVEN** an accepted index-selection change has been published
- **WHEN** no analysis generation under that policy has completed
- **THEN** the receipt reports applied-pending-verification rather than verified indexing

#### Scenario: Live delivery cannot be observed without a canary
- **GIVEN** the current authorization permits observation but not temporary source creation
- **WHEN** the assistant verifies change detection without an observed qualifying source event
- **THEN** it reports that effect pending or not assessed and does not create a test file

#### Scenario: An authorized canary is cleaned up
- **GIVEN** authorization covering a unique temporary source file and its cleanup
- **WHEN** the canary exercises watcher-to-index delivery
- **THEN** verification reports the bounded result and removes the file and its derived entries
- **AND** cleanup failure remains explicit rather than being reported as a clean success

### Requirement: ConfigurationRecoveryRespectsLifecycleOwnership

Runtime recovery SHALL use authenticated daemon identity and the host's lifecycle authority,
respect spawn opt-outs, and disclose effects on other clients. It SHALL NOT signal a PID solely
because a repository descriptor names it. An incompatible daemon SHALL NOT force extension-only
users to find a global CLI; the host SHALL receive an actionable recovery request or a bounded
blocked outcome.

#### Scenario: A host supervises the incompatible daemon
- **GIVEN** a supervising host and disabled extension spawning
- **WHEN** inspection detects an incompatible daemon
- **THEN** recovery is routed to the host and the extension stops or starts no daemon itself

#### Scenario: An extension-managed daemon needs replacement
- **GIVEN** authenticated identity and trusted authorization to replace the shared daemon
- **WHEN** recovery is applied
- **THEN** it uses the installed package's graceful lifecycle path and reports compatibility afterwards
- **AND** other-client interruption is disclosed in the plan

### Requirement: ConfigurationReassessmentFollowsRelevantRepositoryChanges

The assistant SHALL retain bounded per-worktree evidence baselines and accepted-rule reasons,
support explicit reassessment, and optionally notify on meaningful changes. Signals SHALL be
coalesced and reassessment scoped to affected rules or subtrees. Missed events SHALL be detectable
by revalidating relevant evidence on later review. No file event SHALL automatically launch an
LLM, full repository survey or configuration application.

#### Scenario: A workspace gains a new build system
- **GIVEN** a previously accepted policy and a new subproject manifest declaring different outputs
- **WHEN** a relevant signal or explicit review notices the change
- **THEN** the assistant proposes a scoped reassessment and preserves unrelated user choices

#### Scenario: Ordinary source edits do not launch configuration work
- **GIVEN** unchanged configuration evidence and routine edits to existing source
- **WHEN** watcher events arrive
- **THEN** they do not trigger agent reasoning, a full survey or policy changes

#### Scenario: A host misses a change notification
- **GIVEN** a manifest changed while the host was stopped
- **WHEN** the assistant next reviews a plan or baseline using that manifest
- **THEN** its evidence revision is rechecked and the affected recommendation is marked for reassessment

### Requirement: ConfigurationRollbackPreservesLaterUserWork

The assistant SHALL provide a revision-checked inverse of its accepted configuration patch.
Rollback SHALL preserve disjoint later edits and refuse overlapping ones until a new plan is
authorized. Configuration reversal and runtime reversal SHALL be reported separately; rollback
SHALL NOT delete user indexes or resurrect processes as an assumed inverse.

#### Scenario: A later user edit is disjoint
- **GIVEN** an applied watch rule followed by a user change to an unrelated setting
- **WHEN** the assistant reverts its watch-rule change
- **THEN** the unrelated setting remains and runtime re-verification is reported separately

#### Scenario: A later user edits the same rule
- **GIVEN** an assistant-applied rule that a user subsequently modifies
- **WHEN** rollback is requested against the earlier revision
- **THEN** the overlap is disclosed and no stale rule or whole-file snapshot overwrites the user edit
