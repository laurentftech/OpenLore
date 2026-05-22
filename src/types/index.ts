/**
 * Core type definitions for openlore
 */

// Project detection types
export type ProjectType = 'nodejs' | 'python' | 'rust' | 'go' | 'java' | 'ruby' | 'php' | 'unknown';

// Panic response impact level
// off: panic subsystem disabled. Freshness/epistemic tracking always runs regardless. (default)
// observe: panic scoring + state file, no intervention — observe the engine without acting
// advisory / experimental_blocking: full pipeline with response injection / block signal
export type PanicResponseMode = 'off' | 'observe' | 'advisory' | 'experimental_blocking';

// Configuration types
export interface OpenLoreConfig {
  version: string;
  projectType: ProjectType;
  openspecPath: string;
  analysis: AnalysisConfig;
  generation: GenerationConfig;
  llm?: LLMConfig;
  embedding?: EmbeddingConfig;
  panicResponse?: {
    /**
     * Controls panic scoring and intervention. Freshness/epistemic tracking always runs.
     * 'off': panic subsystem disabled entirely (default).
     * 'observe': panic scoring + state written, no intervention.
     * 'advisory' / 'experimental_blocking': full pipeline with response injection.
     */
    mode: PanicResponseMode;
  };
  createdAt: string;
  lastRun: string | null;
}

export interface EmbeddingConfig {
  /** Base URL of the OpenAI-compatible embeddings endpoint */
  baseUrl: string;
  /** Embedding model name */
  model: string;
  /** API key — optional for local servers */
  apiKey?: string;
  /** Maximum number of texts per embedding batch (default: 64) */
  batchSize?: number;
  /** Disable SSL certificate verification (e.g. self-signed certs on local servers) */
  skipSslVerify?: boolean;
}

export interface AnalysisConfig {
  maxFiles: number;
  includePatterns: string[];
  excludePatterns: string[];
}

export interface GenerationConfig {
  provider?: 'anthropic' | 'openai' | 'openai-compat' | 'copilot' | 'gemini' | 'claude-code' | 'mistral-vibe' | 'gemini-cli' | 'cursor-agent';
  model?: string;
  openaiCompatBaseUrl?: string;
  skipSslVerify?: boolean;
  /** Disable response_format field in requests (for endpoints that don't support structured output) */
  disableResponseFormat?: boolean;
  /** LLM request timeout in milliseconds. Default: 120000 (2 minutes) */
  timeout?: number;
  /** Max characters per file chunk sent to the LLM. Default: 8000. Increase for large-context models. */
  chunkMaxChars?: number;
  domains: string | string[];
}

export interface LLMConfig {
  /** Custom API base URL for OpenAI-compatible servers */
  apiBase?: string;
  /** Whether to verify SSL certificates (default: true) */
  sslVerify?: boolean;
}

// File metadata types
export interface FileMetadata {
  path: string;
  absolutePath: string;
  name: string;
  extension: string;
  size: number;
  lines: number;
  depth: number;
  directory: string;
  isEntryPoint: boolean;
  isConfig: boolean;
  isTest: boolean;
  isGenerated: boolean;
}

export interface ScoredFile extends FileMetadata {
  score: number;
  scoreBreakdown: {
    name: number;
    path: number;
    structure: number;
    connectivity: number;
  };
  tags: string[];
}

export interface FileWalkerResult {
  files: FileMetadata[];
  summary: {
    totalFiles: number;
    totalDirectories: number;
    byExtension: Record<string, number>;
    byDirectory: Record<string, number>;
    skippedCount: number;
    skippedReasons: Record<string, number>;
  };
  rootPath: string;
  timestamp: string;
}

// CLI option types
export interface GlobalOptions {
  quiet: boolean;
  verbose: boolean;
  noColor: boolean;
  config: string;
}

export interface InitOptions extends GlobalOptions {
  force: boolean;
  openspecPath: string;
}

export interface AnalyzeOptions extends GlobalOptions {
  output: string;
  maxFiles: number;
  include: string[];
  exclude: string[];
}

export interface GenerateOptions extends GlobalOptions {
  analysis: string;
  model: string;
  dryRun: boolean;
  domains: string[];
  adr: boolean;
  adrOnly: boolean;
  force?: boolean;
}

export interface VerifyOptions extends GlobalOptions {
  samples: number;
  threshold: number;
}

// Analysis result types
export interface AnalysisResult {
  repositoryMap: RepositoryMap;
  dependencyGraph: DependencyGraph;
  summary: AnalysisSummary;
  timestamp: string;
}

export interface RepositoryMap {
  root: string;
  files: ScoredFile[];
  directories: DirectoryInfo[];
  projectType: ProjectType;
}

export interface DirectoryInfo {
  path: string;
  fileCount: number;
  purpose: string;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface DependencyNode {
  id: string;
  path: string;
  type: 'file' | 'module' | 'package';
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'import' | 'export' | 'extends' | 'implements';
}

export interface AnalysisSummary {
  totalFiles: number;
  analyzedFiles: number;
  skippedFiles: number;
  detectedDomains: string[];
  entryPoints: string[];
  confidence: number;
}

// OpenSpec output types
export interface OpenSpecDomain {
  name: string;
  path: string;
  requirements: OpenSpecRequirement[];
  entities: OpenSpecEntity[];
  sourceFiles: string[];
  confidence: number;
}

export interface OpenSpecRequirement {
  name: string;
  description: string;
  keyword: 'SHALL' | 'MUST' | 'SHOULD' | 'MAY';
  scenarios: OpenSpecScenario[];
}

export interface OpenSpecScenario {
  name: string;
  given: string;
  when: string;
  then: string;
  and?: string[];
}

export interface OpenSpecEntity {
  name: string;
  properties: EntityProperty[];
  sourceFile: string;
}

export interface EntityProperty {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

// Drift detection types
export type DriftSeverity = 'error' | 'warning' | 'info';

export type DriftIssueKind =
  | 'gap' // Code changed, spec doesn't cover it
  | 'stale' // Spec describes behavior that code no longer implements
  | 'uncovered' // New file/function with no matching spec at all
  | 'orphaned-spec' // Spec references files that no longer exist
  | 'adr-gap' // Code changed in domain referenced by an ADR
  | 'adr-orphaned'; // ADR references domains that no longer exist in specs

export interface DriftOptions extends GlobalOptions {
  base: string;
  files: string[];
  domains: string[];
  useLlm: boolean;
  json: boolean;
  installHook: boolean;
  uninstallHook: boolean;
  failOn: DriftSeverity;
  maxFiles: number;
  suggestTests: boolean;
}

export interface DriftIssue {
  id: string;
  kind: DriftIssueKind;
  severity: DriftSeverity;
  message: string;
  filePath: string;
  domain: string | null;
  specPath: string | null;
  changedLines?: { added: number; removed: number };
  suggestion: string;
}

export interface DriftResult {
  timestamp: string;
  baseRef: string;
  totalChangedFiles: number;
  specRelevantFiles: number;
  issues: DriftIssue[];
  summary: {
    gaps: number;
    stale: number;
    uncovered: number;
    orphanedSpecs: number;
    adrGaps: number;
    adrOrphaned: number;
    total: number;
  };
  hasDrift: boolean;
  duration: number;
  mode: 'static' | 'llm-enhanced';
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number;
  deletions: number;
  isTest: boolean;
  isConfig: boolean;
  isGenerated: boolean;
  extension: string;
}

export interface SpecMapping {
  domain: string;
  specPath: string;
  declaredSourceFiles: string[];
  inferredSourceFiles: string[];
  allSourceFiles: string[];
  requirements: string[];
  entities: string[];
}

export interface SpecMap {
  byDomain: Map<string, SpecMapping>;
  byFile: Map<string, string[]>;
  domainCount: number;
  totalMappedFiles: number;
}

// ============================================================================
// SPEC SNAPSHOT
// ============================================================================

export interface SpecSnapshotDomain {
  name: string;
  specFile: string;
  sourceFiles: string[];
  requirementCount: number;
  mappedFunctionCount: number;
  coveragePct: number;
  specModifiedAt: string;
  sourcesModifiedAt: string;
}

export interface SpecSnapshotHub {
  name: string;
  file: string;
  fanIn: number;
  covered: boolean;
}

export interface SpecSnapshot {
  version: '1';
  generatedAt: string;
  git: { commit: string; branch: string; dirty: boolean };
  coverage: {
    totalFunctions: number;
    coveredFunctions: number;
    orphanFunctions: number;
    coveragePct: number;
  };
  domains: SpecSnapshotDomain[];
  hubs: SpecSnapshotHub[];
}

// ============================================================================
// AUDIT REPORT
// ============================================================================

export interface AuditUncoveredFunction {
  name: string;
  file: string;
  kind: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
}

export interface AuditOrphanRequirement {
  requirement: string;
  domain: string;
  specFile: string;
}

export interface AuditStaleDomain {
  name: string;
  specFile: string;
  specModifiedAt: string;
  sourcesModifiedAt: string;
  staleSince: string;
}

export interface AuditReport {
  generatedAt: string;
  summary: {
    totalFunctions: number;
    coveredFunctions: number;
    coveragePct: number;
    uncoveredCount: number;
    hubGapCount: number;
    orphanRequirementCount: number;
    staleDomainCount: number;
  };
  uncoveredFunctions: AuditUncoveredFunction[];
  hubGaps: AuditUncoveredFunction[];
  orphanRequirements: AuditOrphanRequirement[];
  staleDomains: AuditStaleDomain[];
}

// ============================================================================
// DECISIONS
// ============================================================================

export type DecisionScope =
  | 'local'        // single file, no cross-cutting concern
  | 'component'    // single component/service/module boundary
  | 'cross-domain' // touches multiple spec domains or service contracts
  | 'system';      // global constraint (auth, data model, infra, API protocol)

export type DecisionStatus =
  | 'draft'         // recorded by agent during dev session
  | 'consolidated'  // LLM has merged/resolved drafts
  | 'verified'      // cross-checked against diff — has code evidence
  | 'phantom'       // recorded but no matching code change found
  | 'approved'      // human/agent approved for sync
  | 'rejected'      // human/agent rejected
  | 'synced';       // written to spec files

/** A single architectural decision recorded during a dev session. */
export interface PendingDecision {
  /** Stable 8-char ID: sha1(sessionId:domain:title).slice(0,8) */
  id: string;
  status: DecisionStatus;

  // Content
  title: string;
  rationale: string;
  consequences: string;
  proposedRequirement: string | null;

  // Context
  affectedDomains: string[];
  affectedFiles: string[];

  /** ID of a prior decision this one supersedes (agent signals a reversal) */
  supersedes?: string;

  // Provenance
  sessionId: string;
  recordedAt: string;
  consolidatedAt?: string;
  verifiedAt?: string;

  // Scope — gates ADR creation: only cross-domain and system produce ADRs
  scope?: DecisionScope;

  // Verification output
  confidence: 'high' | 'medium' | 'low';
  evidenceFile?: string;

  // Review
  reviewedAt?: string;
  reviewNote?: string;

  // Sync tracking
  syncedAt?: string;
  syncedToSpecs: string[];
}

/** Persistent store written to .openlore/decisions/pending.json */
export interface DecisionStore {
  version: '1';
  /** Cleared when a new session starts (new commit cycle) */
  sessionId: string;
  updatedAt: string;
  /** Set after consolidation runs — gate uses this to skip no_decisions_recorded warning */
  lastConsolidatedAt?: string;
  decisions: PendingDecision[];
}
