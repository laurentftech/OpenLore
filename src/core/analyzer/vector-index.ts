/**
 * VectorIndex
 *
 * Builds and queries a LanceDB vector index over the call graph functions.
 * Each function is represented by a document combining its signature, docstring,
 * file path, language, and topological metadata (fanIn/fanOut, hub, entry point).
 *
 * Storage: <outputDir>/vector-index/  (LanceDB database folder)
 * Table name: "functions"
 *
 * Usage:
 *   // Build (after openlore analyze --embed)
 *   await VectorIndex.build(outputDir, nodes, signatures, hubIds, entryPointIds, embedSvc);
 *
 *   // Search
 *   const results = await VectorIndex.search(outputDir, "authenticate user with JWT", embedSvc);
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';
import type { EmbeddingService } from './embedding-service.js';
import { getSkeletonContent, isSkeletonWorthIncluding } from './code-shaper.js';

// ============================================================================
// TYPES
// ============================================================================

export interface FunctionRecord {
  id: string;
  name: string;
  filePath: string;
  className: string;
  language: string;
  signature: string;
  docstring: string;
  fanIn: number;
  fanOut: number;
  isHub: boolean;
  isEntryPoint: boolean;
  /** Concatenated text used for embedding */
  text: string;
  /** Embedding vector */
  vector: number[];
}

export interface SearchResult {
  record: Omit<FunctionRecord, 'vector'>;
  /**
   * Relevance score.  For hybrid search (default): RRF score, higher = more relevant.
   * For dense-only search: cosine distance from LanceDB, lower = more similar.
   */
  score: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const DB_FOLDER = 'vector-index';
const TABLE_NAME = 'functions';

/** Convert a raw LanceDB row to a FunctionRecord (without the vector field). */
function rowToRecord(row: Record<string, unknown>): Omit<FunctionRecord, 'vector'> {
  return {
    id:          row.id as string,
    name:        row.name as string,
    filePath:    row.filePath as string,
    className:   row.className as string,
    language:    row.language as string,
    signature:   row.signature as string,
    docstring:   row.docstring as string,
    fanIn:       row.fanIn as number,
    fanOut:      row.fanOut as number,
    isHub:       row.isHub as boolean,
    isEntryPoint: row.isEntryPoint as boolean,
    text:        row.text as string,
  };
}

// ============================================================================
// BM25 SPARSE RETRIEVAL (#7)
// ============================================================================

interface Bm25Corpus {
  docs: Array<{ id: string; tfMap: Map<string, number>; length: number }>;
  /** term → number of documents containing it */
  df: Map<string, number>;
  avgLength: number;
  N: number;
}

function tokenize(text: string): string[] {
  // Split on non-alphanumeric, keep tokens longer than 1 char
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
}

function buildBm25Corpus(records: Array<{ id: string; text: string }>): Bm25Corpus {
  const docs: Bm25Corpus['docs'] = [];
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const r of records) {
    const tokens = tokenize(r.text);
    const tfMap = new Map<string, number>();
    for (const t of tokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
    docs.push({ id: r.id, tfMap, length: tokens.length });
    totalLen += tokens.length;
    for (const t of tfMap.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }

  return { docs, df, avgLength: docs.length > 0 ? totalLen / docs.length : 1, N: docs.length };
}

const BM25_K1 = 1.2;
const BM25_B  = 0.75;

function bm25Score(corpus: Bm25Corpus, queryTokens: string[], docIdx: number): number {
  const doc = corpus.docs[docIdx];
  let score = 0;
  for (const q of queryTokens) {
    const df = corpus.df.get(q) ?? 0;
    if (df === 0) continue;
    const idf = Math.log((corpus.N - df + 0.5) / (df + 0.5) + 1);
    const tf = doc.tfMap.get(q) ?? 0;
    const tfNorm =
      (tf * (BM25_K1 + 1)) /
      (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / corpus.avgLength)));
    score += idf * tfNorm;
  }
  return score;
}

/**
 * Reciprocal Rank Fusion: merges two ranked lists into a single relevance score.
 * k=60 is the standard parameter (Cormack et al., 2009).
 */
function rrfScore(rankDense: number, rankSparse: number, k = 60): number {
  return 1 / (k + rankDense + 1) + 1 / (k + rankSparse + 1);
}

// Module-level BM25 corpus cache: avoids a full table scan on every search call.
// Keyed by dbPath; invalidated by build() when the index is rebuilt.
const _bm25Cache = new Map<string, { corpus: Bm25Corpus; rowCount: number; rows: Record<string, unknown>[] }>();

// Module-level LanceDB table cache: avoids connect() + openTable() on every search call.
// Invalidated by build() when the index is rebuilt.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _tableCache = new Map<string, { table: any }>();

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build the text to embed for a function.
 * Combines language, path, qualified name, signature, docstring, and skeleton body.
 */
function buildText(
  node: FunctionNode,
  signature: string,
  docstring: string,
  fileContents?: Map<string, string>
): string {
  const qualifiedName = node.className
    ? `${node.className}.${node.name}`
    : node.name;

  const parts = [`[${node.language}] ${node.filePath} ${qualifiedName}`];
  if (signature) parts.push(signature);
  if (docstring) parts.push(docstring);

  // Append skeleton body when file contents are available.
  // The skeleton strips noise (logs, comments) while preserving business-logic signals
  // (variable names, control flow, calls, return/throw). Only included when it provides
  // meaningful reduction over the raw body (≥20% smaller).
  if (fileContents && node.startIndex < node.endIndex) {
    const src = fileContents.get(node.filePath);
    if (src) {
      const body = src.slice(node.startIndex, node.endIndex);
      if (body.trim()) {
        const skeleton = getSkeletonContent(body, node.language);
        if (isSkeletonWorthIncluding(body, skeleton)) {
          parts.push(skeleton);
        }
      }
    }
  }

  return parts.join('\n');
}

/**
 * Build a lookup map: filePath → entries[] from FileSignatureMap[]
 */
function buildSignatureIndex(
  signatures: FileSignatureMap[]
): Map<string, FileSignatureMap['entries']> {
  const index = new Map<string, FileSignatureMap['entries']>();
  for (const fsm of signatures) {
    index.set(fsm.path, fsm.entries);
  }
  return index;
}

/**
 * Find the best matching signature entry for a FunctionNode.
 */
function findSignatureEntry(
  node: FunctionNode,
  sigIndex: Map<string, FileSignatureMap['entries']>
): { signature: string; docstring: string } {
  const entries = sigIndex.get(node.filePath) ?? [];
  const match = entries.find(e => e.name === node.name);
  if (!match) return { signature: '', docstring: '' };
  return {
    signature: match.signature ?? '',
    docstring: match.docstring ?? '',
  };
}

// ============================================================================
// VECTOR INDEX
// ============================================================================

export class VectorIndex {
  /**
   * Build (or rebuild) the vector index from call graph nodes + signatures.
   *
   * When `incremental` is true and an existing index is found, only functions
   * whose text has changed since the last build are re-embedded.  Unchanged
   * functions reuse their cached vectors.  Pass `incremental: false` (or omit
   * when no index exists) to do a full rebuild.
   *
   * Returns a summary of how many functions were embedded vs reused.
   */
  static async build(
    outputDir: string,
    nodes: FunctionNode[],
    signatures: FileSignatureMap[],
    hubIds: Set<string>,
    entryPointIds: Set<string>,
    embedSvc: EmbeddingService,
    /** Optional map of filePath → source content for skeleton-based body indexing */
    fileContents?: Map<string, string>,
    /** When true, reuse cached vectors for unchanged functions */
    incremental = false
  ): Promise<{ embedded: number; reused: number }> {
    const { connect } = await import('@lancedb/lancedb');

    if (nodes.length === 0) {
      throw new Error('No functions to index');
    }

    const sigIndex = buildSignatureIndex(signatures);

    // Build candidate records (without vectors)
    const nodeIds = new Set(nodes.map(n => n.id));
    const candidates: Omit<FunctionRecord, 'vector'>[] = nodes.map(node => {
      const cgDoc = node.docstring ?? '';
      const cgSig = node.signature ?? '';
      // Always check regex index as fallback — CG may miss docstrings when
      // startIndex points inside an export_statement (past the `export` keyword),
      // causing extractDocstringBefore to scan into the export keyword instead of
      // reaching the JSDoc block above it.
      const { signature: regexSig, docstring: regexDoc } = findSignatureEntry(node, sigIndex);
      const signature = cgSig || regexSig;
      const docstring = cgDoc || regexDoc;
      return {
        id: node.id,
        name: node.name,
        filePath: node.filePath,
        className: node.className ?? '',
        language: node.language,
        signature,
        docstring,
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        isHub: hubIds.has(node.id),
        isEntryPoint: entryPointIds.has(node.id),
        text: buildText(node, signature, docstring, fileContents),
      };
    });

    // Also index signature entries that have no call graph node (constants, type aliases, etc.)
    for (const fsm of signatures) {
      for (const entry of fsm.entries) {
        const syntheticId = `${fsm.path}::${entry.name}`;
        if (nodeIds.has(syntheticId)) continue; // already covered by call graph
        // Skip if any call graph node from this file matches the name
        if (nodes.some(n => n.filePath === fsm.path && n.name === entry.name)) continue;
        const sig = entry.signature ?? '';
        const doc = entry.docstring ?? '';
        candidates.push({
          id: syntheticId,
          name: entry.name,
          filePath: fsm.path,
          className: '',
          language: fsm.language,
          signature: sig,
          docstring: doc,
          fanIn: 0,
          fanOut: 0,
          isHub: false,
          isEntryPoint: false,
          text: `[${fsm.language}] ${fsm.path} ${entry.name}\n${sig}${doc ? '\n' + doc : ''}`,
        });
      }
    }

    // ── Incremental cache lookup ─────────────────────────────────────────────
    const dbPath = join(outputDir, DB_FOLDER);
    let cachedVectors = new Map<string, number[]>(); // id → vector

    if (incremental && VectorIndex.exists(outputDir)) {
      try {
        const db = await connect(dbPath);
        const table = await db.openTable(TABLE_NAME);
        // Full table scan to load existing vectors
        const existing = await table.query().toArray();
        for (const row of existing) {
          const id = row.id as string;
          const text = row.text as string;
          // Convert Arrow typed arrays (Float32Array etc.) to plain number[]
          // so LanceDB can re-infer the schema when writing back
          const vector = Array.from(row.vector as ArrayLike<number>);
          // Cache the vector keyed by "id::text" so a text change invalidates it
          cachedVectors.set(`${id}::${text}`, vector);
        }
      } catch {
        // Existing index unreadable — fall back to full build
        cachedVectors = new Map();
      }
    }

    // ── Split into cached vs needs-embedding ────────────────────────────────
    const toEmbed: typeof candidates = [];
    const toEmbedIdx: number[] = []; // index into `candidates`
    const cachedIdx: number[] = [];

    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i];
      const cacheKey = `${r.id}::${r.text}`;
      if (cachedVectors.has(cacheKey)) {
        cachedIdx.push(i);
      } else {
        toEmbed.push(r);
        toEmbedIdx.push(i);
      }
    }

    // ── Embed only changed / new functions ───────────────────────────────────
    let newVectors: number[][] = [];
    if (toEmbed.length > 0) {
      newVectors = await embedSvc.embed(toEmbed.map(r => r.text));
      if (newVectors.length !== toEmbed.length) {
        throw new Error(
          `Embedding count mismatch: expected ${toEmbed.length}, got ${newVectors.length}`
        );
      }
    }

    // ── Assemble final records ───────────────────────────────────────────────
    const fullRecords: FunctionRecord[] = new Array(candidates.length);
    for (let i = 0; i < cachedIdx.length; i++) {
      const idx = cachedIdx[i];
      const r = candidates[idx];
      fullRecords[idx] = { ...r, vector: cachedVectors.get(`${r.id}::${r.text}`)! };
    }
    for (let i = 0; i < toEmbedIdx.length; i++) {
      const idx = toEmbedIdx[i];
      fullRecords[idx] = { ...candidates[idx], vector: newVectors[i] };
    }

    // ── Write table ──────────────────────────────────────────────────────────
    const db = await connect(dbPath);
    await db.createTable(TABLE_NAME, fullRecords as unknown as Record<string, unknown>[], { mode: 'overwrite' });

    // Invalidate search caches — index was just rebuilt
    _tableCache.delete(dbPath);
    _bm25Cache.delete(dbPath);

    return { embedded: toEmbed.length, reused: cachedIdx.length };
  }

  /**
   * Hybrid search over the index: dense (ANN) + sparse (BM25) merged via RRF.
   *
   * Dense recall fetches top `limit*5` candidates from the vector index.
   * Sparse recall scores the full corpus with BM25 (cached per session).
   * Reciprocal Rank Fusion (RRF) combines both rankings into a single list.
   *
   * Set `hybrid: false` to use dense-only search (original behaviour).
   * Returns up to `limit` results sorted by relevance (highest first).
   */
  static async search(
    outputDir: string,
    query: string,
    embedSvc: EmbeddingService | null | undefined,
    opts: {
      limit?: number;
      language?: string;
      minFanIn?: number;
      /** Enable hybrid dense+sparse retrieval via RRF (default: true when embedSvc available) */
      hybrid?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const { limit = 10, language, minFanIn, hybrid = true } = opts;

    if (!VectorIndex.exists(outputDir)) {
      throw new Error('Vector index not found. Run "openlore analyze --embed" first.');
    }

    const dbPath = join(outputDir, DB_FOLDER);
    let tableEntry = _tableCache.get(dbPath);
    if (!tableEntry) {
      const { connect } = await import('@lancedb/lancedb');
      const db = await connect(dbPath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const table: any = await db.openTable(TABLE_NAME);
      tableEntry = { table };
      _tableCache.set(dbPath, tableEntry);
    }
    const table = tableEntry.table;

    // ── BM25-only path (no embedding service available) ───────────────────────
    if (!embedSvc) {
      return VectorIndex._bm25Only(table, dbPath, query, limit, language, minFanIn);
    }

    // ── Dense recall ──────────────────────────────────────────────────────────
    let queryVector: number[];
    try {
      [queryVector] = await embedSvc.embed([query]);
    } catch {
      // Embedding server unreachable — fall back to BM25
      return VectorIndex._bm25Only(table, dbPath, query, limit, language, minFanIn);
    }
    if (!queryVector) throw new Error('Failed to embed query');

    const denseFetch = hybrid ? Math.min(limit * 5, 500) : Math.min(limit * 10, 1000);
    const denseRows = await table.query().nearestTo(queryVector).limit(denseFetch).toArray() as Record<string, unknown>[];

    const passesFilters = (row: Record<string, unknown>): boolean => {
      if (language && (row.language as string) !== language) return false;
      if (minFanIn !== undefined && minFanIn > 0 && (row.fanIn as number) < minFanIn) return false;
      return true;
    };

    // ── Dense-only path ───────────────────────────────────────────────────────
    if (!hybrid) {
      return denseRows
        .filter(passesFilters)
        .slice(0, limit)
        .map(row => ({ record: rowToRecord(row), score: row._distance as number }));
    }

    // ── Sparse recall (BM25 over full corpus) ─────────────────────────────────
    let cachedEntry = _bm25Cache.get(dbPath);
    let allRows: Record<string, unknown>[];

    if (!cachedEntry) {
      allRows = await table.query().toArray() as Record<string, unknown>[];
      const corpus = buildBm25Corpus(
        allRows.map(r => ({ id: r.id as string, text: r.text as string }))
      );
      cachedEntry = { corpus, rowCount: allRows.length, rows: allRows };
      _bm25Cache.set(dbPath, cachedEntry);
    } else {
      // Use cached rows — invalidated by build() when index is rebuilt
      allRows = cachedEntry.rows;
    }

    const { corpus } = cachedEntry;
    const queryTokens = tokenize(query);

    // Score all corpus documents with BM25
    const sparseScored = corpus.docs
      .map((_, i) => ({ idx: i, score: bm25Score(corpus, queryTokens, i) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 5);

    // Build id→row map from allRows for sparse candidates
    const rowById = new Map(allRows.map(r => [r.id as string, r]));

    // ── RRF merge ────────────────────────────────────────────────────────────
    const rrfMap = new Map<string, { row: Record<string, unknown>; score: number }>();

    denseRows.forEach((row, rank) => {
      const id = row.id as string;
      const entry = rrfMap.get(id) ?? { row, score: 0 };
      entry.score += rrfScore(rank, Infinity); // sparse rank = Infinity if not in sparse list
      rrfMap.set(id, entry);
    });

    sparseScored.forEach(({ idx, score: bm25 }, rank) => {
      if (bm25 === 0) return; // no BM25 signal — skip
      const id = corpus.docs[idx].id;
      const row = rowById.get(id);
      if (!row) return;
      const entry = rrfMap.get(id) ?? { row, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      rrfMap.set(id, entry);
    });

    // Fix dense ranks now that we know the full picture
    // Re-compute proper RRF scores with both ranks available
    const denseRankById = new Map(denseRows.map((r, i) => [r.id as string, i]));
    const sparseRankById = new Map(sparseScored.map(({ idx }, i) => [corpus.docs[idx].id, i]));

    const merged = [...rrfMap.values()].map(({ row }) => {
      const id = row.id as string;
      const dr = denseRankById.get(id) ?? Infinity;
      const sr = sparseRankById.get(id) ?? Infinity;
      return { row, score: rrfScore(dr, sr) };
    });

    return merged
      .sort((a, b) => b.score - a.score)
      .filter(({ row }) => passesFilters(row))
      .slice(0, limit)
      .map(({ row, score }) => ({ record: rowToRecord(row), score }));
  }

  /**
   * BM25-only search: used when no embedding service is available.
   * Scores the full corpus with BM25 and returns the top `limit` results.
   */
  private static async _bm25Only(
    table: { query(): { toArray(): Promise<Record<string, unknown>[]> } },
    dbPath: string,
    query: string,
    limit: number,
    language?: string,
    minFanIn?: number,
  ): Promise<SearchResult[]> {
    let cachedEntry = _bm25Cache.get(dbPath);
    let allRows: Record<string, unknown>[];

    if (!cachedEntry) {
      allRows = await table.query().toArray() as Record<string, unknown>[];
      const corpus = buildBm25Corpus(
        allRows.map(r => ({ id: r.id as string, text: r.text as string }))
      );
      cachedEntry = { corpus, rowCount: allRows.length, rows: allRows };
      _bm25Cache.set(dbPath, cachedEntry);
    } else {
      // Use cached rows — invalidated by build() when index is rebuilt
      allRows = cachedEntry.rows;
    }

    const { corpus } = cachedEntry;
    const queryTokens = tokenize(query);
    const rowById = new Map(allRows.map(r => [r.id as string, r]));

    return corpus.docs
      .map((_, i) => ({ idx: i, score: bm25Score(corpus, queryTokens, i) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 3) // oversample before filtering
      .map(({ idx, score }) => {
        const row = rowById.get(corpus.docs[idx].id);
        return row ? { row, score } : null;
      })
      .filter((x): x is { row: Record<string, unknown>; score: number } => x !== null)
      .filter(({ row }) => {
        if (language && (row.language as string) !== language) return false;
        if (minFanIn !== undefined && minFanIn > 0 && (row.fanIn as number) < minFanIn) return false;
        return true;
      })
      .slice(0, limit)
      .map(({ row, score }) => ({ record: rowToRecord(row), score }));
  }

  /**
   * Returns true if a vector index has been built for this output directory.
   */
  static exists(outputDir: string): boolean {
    return existsSync(join(outputDir, DB_FOLDER));
  }
}
