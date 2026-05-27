/**
 * MCP tool handlers for semantic search and feature insertion:
 * search_code, suggest_insertion_points, search_specs.
 */

import { join } from 'node:path';
import {
  INSERTION_SEMANTIC_WEIGHT,
  INSERTION_STRUCTURAL_WEIGHT,
  INSERTION_ROLE_BONUS_ENTRY_POINT,
  INSERTION_ROLE_BONUS_ORCHESTRATOR,
  INSERTION_ROLE_BONUS_HUB,
  INSERTION_ROLE_BONUS_INTERNAL,
  INSERTION_ROLE_BONUS_UTILITY,
  INSERTION_ORCHESTRATOR_FAN_OUT_THRESHOLD,
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
} from '../../../constants.js';
import { fileExists } from '../../../utils/command-helpers.js';
import { validateDirectory, loadMappingIndex, specsForFile, functionsForDomain } from './utils.js';
import { readOpenLoreConfig } from '../config-manager.js';

// ============================================================================
// INSERTION POINT HELPERS
// ============================================================================

export type InsertionRole = 'entry_point' | 'orchestrator' | 'hub' | 'utility' | 'internal';
export type InsertionStrategy =
  | 'extend_entry_point'
  | 'add_orchestration_step'
  | 'cross_cutting_hook'
  | 'extract_shared_logic'
  | 'call_alongside';

export interface InsertionCandidate {
  rank: number;
  score: number;
  semanticScore: number;
  name: string;
  filePath: string;
  className?: string;
  language: string;
  signature?: string;
  docstring?: string;
  role: InsertionRole;
  insertionStrategy: InsertionStrategy;
  reason: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
}

export function classifyRole(
  fanIn: number,
  fanOut: number,
  isHub: boolean,
  isEntryPoint: boolean
): InsertionRole {
  if (isEntryPoint) return 'entry_point';
  if (isHub) return 'hub';
  if (fanOut >= INSERTION_ORCHESTRATOR_FAN_OUT_THRESHOLD) return 'orchestrator';
  if (fanIn <= 1) return 'utility';
  return 'internal';
}

export function deriveStrategy(role: InsertionRole): InsertionStrategy {
  switch (role) {
    case 'entry_point':
      return 'extend_entry_point';
    case 'orchestrator':
      return 'add_orchestration_step';
    case 'hub':
      return 'cross_cutting_hook';
    case 'utility':
      return 'extract_shared_logic';
    default:
      return 'call_alongside';
  }
}

export function buildReason(
  name: string,
  role: InsertionRole,
  strategy: InsertionStrategy,
  fanIn: number,
  fanOut: number
): string {
  switch (strategy) {
    case 'extend_entry_point':
      return `${name} is an entry point (no internal callers). Add your feature here or create a sibling entry point that delegates to it.`;
    case 'add_orchestration_step':
      return `${name} orchestrates ${fanOut} downstream calls. Insert your feature as a new step in this pipeline.`;
    case 'cross_cutting_hook':
      return `${name} is called by ${fanIn} functions -- adding logic here affects the entire callsite surface.`;
    case 'extract_shared_logic':
      return `${name} is a low-traffic utility. Shared logic for your feature can live here or be extracted alongside it.`;
    default:
      return `${name} is semantically close to your feature and operates in the same domain. Extend or call alongside it.`;
  }
}

/**
 * Composite score = semanticRelevance * INSERTION_SEMANTIC_WEIGHT + structuralBonus * INSERTION_STRUCTURAL_WEIGHT.
 *
 * `semanticRelevance` must be in the 0-1 range (higher = more relevant).
 * Callers using VectorIndex.search (hybrid/RRF or BM25) should normalise scores
 * into [0, 1] before calling this function.
 */
export function compositeScore(semanticRelevance: number, role: InsertionRole): number {
  const semantic = Math.max(0, Math.min(1, semanticRelevance));
  const structuralBonus: Record<InsertionRole, number> = {
    entry_point: INSERTION_ROLE_BONUS_ENTRY_POINT,
    orchestrator: INSERTION_ROLE_BONUS_ORCHESTRATOR,
    hub: INSERTION_ROLE_BONUS_HUB,
    internal: INSERTION_ROLE_BONUS_INTERNAL,
    utility: INSERTION_ROLE_BONUS_UTILITY,
  };
  return semantic * INSERTION_SEMANTIC_WEIGHT + structuralBonus[role] * INSERTION_STRUCTURAL_WEIGHT;
}

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * MCP retrieval strategy: semantic search → graph neighborhood enrichment.
 *
 * Returns the top-k semantic results, each enriched with:
 * - callers / callees from the call graph (graph-first context)
 * - linkedSpecs from mapping.json (bidirectional code↔spec linking)
 */
export async function handleSearchCode(
  directory: string,
  query: string,
  limit = 10,
  language?: string,
  minFanIn?: number
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');

  if (!VectorIndex.exists(outputDir)) {
    return {
      error: 'No search index found. Run "openlore analyze" first.',
      hint: 'Plain "openlore analyze" builds a keyword (BM25) index; add EMBED_BASE_URL/EMBED_MODEL for semantic search.',
    };
  }

  // Resolve embedding service — fall back to BM25-only search if unavailable
  let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
  let searchMode = 'hybrid';
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readOpenLoreConfig(absDir);
    const svcFromConfig = cfg ? EmbeddingService.fromConfig(cfg) : null;
    if (svcFromConfig) {
      embedSvc = svcFromConfig;
    } else {
      searchMode = 'bm25_fallback';
    }
  }

  limit = Math.max(1, Math.min(limit, 100));
  const { readCachedContext } = await import('./utils.js');
  const [results, mappingIdx, llmCtx] = await Promise.all([
    VectorIndex.search(outputDir, query, embedSvc, { limit, language, minFanIn }),
    loadMappingIndex(absDir),
    readCachedContext(absDir),
  ]);

  type Neighbour = { name: string; filePath: string };

  // ── RIG-20: cross-graph spec traversal — seed → spec domains → peer functions ──
  // For each result that has linkedSpecs, traverse the spec domain to find
  // other functions in that domain not already in the semantic results.
  type SpecPeer = { name: string; filePath: string; domain: string; requirement: string };
  const specPeers: SpecPeer[] = [];
  if (mappingIdx) {
    const resultFileSet = new Set(results.map((r) => r.record.filePath));
    const seedDomains = new Set<string>();
    for (const r of results) {
      for (const spec of specsForFile(mappingIdx, r.record.filePath)) seedDomains.add(spec.domain);
    }
    const seen = new Set<string>();
    for (const domain of seedDomains) {
      for (const fn of functionsForDomain(mappingIdx, domain)) {
        const key = `${fn.name}::${fn.file}`;
        if (seen.has(key) || resultFileSet.has(fn.file)) continue;
        seen.add(key);
        specPeers.push({ name: fn.name, filePath: fn.file, domain, requirement: fn.requirement });
      }
    }
  }

  return {
    query,
    searchMode,
    ...(searchMode === 'bm25_fallback'
      ? {
          note: 'Embedding server unavailable — results based on keyword matching only. Configure EMBED_BASE_URL + EMBED_MODEL for semantic search.',
        }
      : {}),
    count: results.length,
    results: results.map((r) => ({
      score: r.score,
      name: r.record.name,
      filePath: r.record.filePath,
      className: r.record.className || undefined,
      language: r.record.language,
      signature: r.record.signature || undefined,
      docstring: r.record.docstring || undefined,
      fanIn: r.record.fanIn,
      fanOut: r.record.fanOut,
      isHub: r.record.isHub,
      isEntryPoint: r.record.isEntryPoint,
      linkedSpecs: mappingIdx ? specsForFile(mappingIdx, r.record.filePath) : undefined,
      callers: llmCtx?.edgeStore
        ? llmCtx.edgeStore.getCallers(r.record.id)
            .map(e => { const n = llmCtx!.edgeStore!.getNode(e.callerId); return n && !n.isExternal ? { name: n.name, filePath: n.filePath } : null; })
            .filter((x): x is Neighbour => x !== null)
        : undefined,
      callees: llmCtx?.edgeStore
        ? llmCtx.edgeStore.getCallees(r.record.id)
            .map(e => { const n = llmCtx!.edgeStore!.getNode(e.calleeId); return n && !n.isExternal ? { name: n.name, filePath: n.filePath } : null; })
            .filter((x): x is Neighbour => x !== null)
        : undefined,
    })),
    ...(specPeers.length > 0 ? { specLinkedFunctions: specPeers } : {}),
  };
}

/**
 * Find the best places in the codebase to implement a new feature.
 */
export async function handleSuggestInsertionPoints(
  directory: string,
  description: string,
  limit = 5,
  language?: string
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const { VectorIndex } = await import('../../analyzer/vector-index.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');

  if (!VectorIndex.exists(outputDir)) {
    return {
      error: 'No search index found. Run "openlore analyze" first.',
      hint: 'Plain "openlore analyze" builds a keyword (BM25) index; add EMBED_BASE_URL/EMBED_MODEL for semantic search.',
    };
  }

  // Resolve embedding service — null triggers BM25 fallback in VectorIndex.search().
  let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readOpenLoreConfig(absDir);
    embedSvc = cfg ? EmbeddingService.fromConfig(cfg) : null;
  }

  limit = Math.max(1, Math.min(limit, 20));
  const { readCachedContext } = await import('./utils.js');
  const [rawResults, llmCtx] = await Promise.all([
    VectorIndex.search(outputDir, description, embedSvc, { limit: limit * 4, language }),
    readCachedContext(absDir),
  ]);

  // Normalise search scores to [0, 1] for compositeScore (scores are RRF/BM25: higher = better)
  const maxScore = rawResults.length > 0 ? Math.max(...rawResults.map((r) => r.score)) : 1;
  const normalise = (s: number) => (maxScore > 0 ? s / maxScore : 0);

  const candidates: InsertionCandidate[] = rawResults.map((r) => {
    const role = classifyRole(
      r.record.fanIn,
      r.record.fanOut,
      r.record.isHub,
      r.record.isEntryPoint
    );
    const strategy = deriveStrategy(role);
    const score = compositeScore(normalise(r.score), role);
    return {
      rank: 0,
      score,
      semanticScore: r.score,
      name: r.record.name,
      filePath: r.record.filePath,
      className: r.record.className || undefined,
      language: r.record.language,
      signature: r.record.signature || undefined,
      docstring: r.record.docstring || undefined,
      role,
      insertionStrategy: strategy,
      reason: buildReason(r.record.name, role, strategy, r.record.fanIn, r.record.fanOut),
      fanIn: r.record.fanIn,
      fanOut: r.record.fanOut,
      isHub: r.record.isHub,
      isEntryPoint: r.record.isEntryPoint,
    };
  });

  // RIG-13 — Graph expansion: add depth-1 callers of semantic seed functions.
  if (llmCtx?.edgeStore) {
    const seedIds = new Set(rawResults.map((r) => r.record.id));
    const existingIds = new Set(candidates.map((c) => `${c.filePath}::${c.name}`));

    for (const seedResult of rawResults) {
      const callerIds = llmCtx.edgeStore.getCallers(seedResult.record.id).map(e => e.callerId);
      for (const callerId of callerIds) {
        const callerNode = llmCtx.edgeStore.getNode(callerId);
        if (!callerNode) continue;
        const key = `${callerNode.filePath}::${callerNode.name}`;
        if (existingIds.has(key) || seedIds.has(callerId)) continue;
        existingIds.add(key);

        const role = classifyRole(callerNode.fanIn, callerNode.fanOut, false, false);
        const strategy = deriveStrategy(role);
        // Graph-expanded candidates score slightly lower than the semantic seed
        const score = compositeScore(seedResult.score + 0.15, role) * 0.85;
        candidates.push({
          rank: 0,
          score,
          semanticScore: seedResult.score + 0.15,
          name: callerNode.name,
          filePath: callerNode.filePath,
          className: callerNode.className,
          language: callerNode.language,
          signature: undefined,
          docstring: undefined,
          role,
          insertionStrategy: strategy,
          reason: `${callerNode.name} calls ${seedResult.record.name} (semantically close to your feature). Adding logic here propagates to the domain.`,
          fanIn: callerNode.fanIn,
          fanOut: callerNode.fanOut,
          isHub: false,
          isEntryPoint: false,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    description,
    count: top.length,
    candidates: top,
    nextSteps:
      top.length > 0
        ? [
            `Run get_function_skeleton on "${top[0].filePath}" to see the internal structure of ${top[0].name}`,
            `Run get_subgraph on "${top[0].name}" to understand its call neighborhood`,
            `After implementing, run check_spec_drift to verify the code matches the spec`,
          ]
        : [
            'No candidates found. Try a broader description or run "openlore analyze --embed" to build the index.',
          ],
  };
}

/**
 * Return the full content of a spec domain's spec.md plus its mapping entries.
 */
export async function handleGetSpec(directory: string, domain: string): Promise<unknown> {
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');
  const absDir = await validateDirectory(directory);

  const specFile = pjoin(absDir, 'openspec', 'specs', domain, 'spec.md');
  if (!existsSync(specFile)) {
    return {
      error: `No spec found for domain "${domain}". Run list_spec_domains to see available domains.`,
    };
  }

  const [content, mappingIdx] = await Promise.all([
    readFile(specFile, 'utf-8'),
    loadMappingIndex(absDir),
  ]);
  const linkedFunctions = mappingIdx ? functionsForDomain(mappingIdx, domain) : undefined;

  return {
    domain,
    specFile: `openspec/specs/${domain}/spec.md`,
    content,
    linkedFunctions,
  };
}

/**
 * List all spec domains available in the project (reads openspec/specs/ directory).
 * Useful for the agent to discover what domains exist before doing a targeted search.
 */
export async function handleListSpecDomains(directory: string): Promise<unknown> {
  const { readdir } = await import('node:fs/promises');
  const { join: pjoin } = await import('node:path');
  const absDir = await validateDirectory(directory);

  const specsDir = pjoin(absDir, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);
  if (!(await fileExists(specsDir))) {
    return {
      domains: [],
      note: 'No openspec/specs/ directory found. Run "openlore generate" first.',
    };
  }

  let entries: string[];
  try {
    entries = await readdir(specsDir);
  } catch {
    return { domains: [] };
  }

  const domainChecks = await Promise.all(
    entries.map((e) => fileExists(pjoin(specsDir, e, 'spec.md')))
  );
  const domains = entries.filter((_, i) => domainChecks[i]);
  return { domains, count: domains.length };
}

/**
 * Semantic search over the spec index built by "openlore analyze --embed"
 * or "openlore analyze --reindex-specs".
 */
export async function handleSearchSpecs(
  directory: string,
  query: string,
  limit = 10,
  domain?: string,
  section?: string
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const { SpecVectorIndex } = await import('../../analyzer/spec-vector-index.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');

  if (!SpecVectorIndex.exists(outputDir)) {
    return {
      error: 'No spec index found. Run "openlore analyze" first.',
      hint: 'Plain "openlore analyze" builds a keyword (BM25) spec index; configure EMBED_* for semantic spec search.',
    };
  }

  // Resolve embedding service — null triggers BM25 fallback in SpecVectorIndex.search().
  let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
  let searchMode = 'hybrid';
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readOpenLoreConfig(absDir);
    const svcFromConfig = cfg ? EmbeddingService.fromConfig(cfg) : null;
    if (svcFromConfig) {
      embedSvc = svcFromConfig;
    } else {
      searchMode = 'bm25_fallback';
    }
  }

  limit = Math.max(1, Math.min(limit, 50));
  const [results, mappingIdx] = await Promise.all([
    SpecVectorIndex.search(outputDir, query, embedSvc, { limit, domain, section }),
    loadMappingIndex(absDir),
  ]);

  return {
    query,
    searchMode,
    ...(searchMode === 'bm25_fallback'
      ? {
          note: 'No embedding endpoint — spec results based on keyword matching only. Configure EMBED_BASE_URL + EMBED_MODEL for semantic spec search.',
        }
      : {}),
    count: results.length,
    results: results.map((r) => ({
      score: r.score,
      id: r.record.id,
      domain: r.record.domain,
      section: r.record.section,
      title: r.record.title,
      text: r.record.text,
      linkedFiles: r.record.linkedFiles,
      linkedFunctions: mappingIdx ? functionsForDomain(mappingIdx, r.record.domain) : undefined,
    })),
  };
}

/**
 * Unified search that combines code and spec indexes with cross-scoring
 */
export async function handleUnifiedSearch(
  directory: string,
  query: string,
  limit = 10,
  language?: string,
  domain?: string,
  section?: string
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const outputDir = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  const { UnifiedSearch, unifiedSearchAvailable } =
    await import('../../analyzer/unified-search.js');
  const { EmbeddingService } = await import('../../analyzer/embedding-service.js');

  if (!(await unifiedSearchAvailable(outputDir))) {
    return {
      error:
        'No unified search available. Run "openlore analyze --embed" first, ' +
        'then configure EMBED_BASE_URL and EMBED_MODEL.',
    };
  }

  // Resolve embedding service
  let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = await readOpenLoreConfig(absDir);
    const svcFromConfig = cfg ? EmbeddingService.fromConfig(cfg) : null;
    if (svcFromConfig) {
      embedSvc = svcFromConfig;
    }
  }

  limit = Math.max(1, Math.min(limit, 50));
  const results = await UnifiedSearch.unifiedSearch(outputDir, query, embedSvc, {
    limit,
    language,
    domain,
    section,
  });

  return {
    query,
    count: results.length,
    results,
  };
}

