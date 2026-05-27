/**
 * McpWatcher — incremental re-indexer for the MCP server's --watch mode.
 *
 * Watches source files for changes and incrementally updates:
 *   1. signatures in llm-context.json (always)
 *   2. vector index (only when embed: true and an embedding server is reachable)
 *
 * The call graph is deliberately excluded — rebuilding it requires full
 * tree-sitter analysis of all call sites and is too expensive for a watch loop.
 * It stays current via the post-commit hook (openlore analyze --force --embed).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { extractSignatures, detectLanguage } from '../analyzer/signature-extractor.js';
import type { LLMContext } from '../analyzer/artifact-generator.js';
import { EdgeStore } from './edge-store.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
} from '../../constants.js';

const CALL_GRAPH_LANGS = new Set([
  'Python', 'TypeScript', 'JavaScript', 'Go', 'Rust', 'Ruby', 'Java', 'C++', 'Swift',
]);
/** Max callerFiles to re-parse in a single watch event (guards against high-fanIn renames). */
const CALLER_REPARSE_LIMIT = 10;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpWatcherOptions {
  /** Absolute path to the project root being watched */
  rootPath: string;
  /** Absolute path to .openlore/analysis/ — where llm-context.json lives */
  outputPath?: string;
  /** Milliseconds to debounce file-change events (default: 400) */
  debounceMs?: number;
  /** Extra glob patterns to ignore in addition to defaults */
  ignore?: string[];
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|php|cs|cpp|cc|cxx|h|hpp|c|swift)$/;

// String-segment checks evaluated before kqueue/inotify FDs are opened — avoids
// EMFILE on macOS when chokidar opens FDs for all directories before applying globs.
const IGNORED_SEGMENTS = ['/node_modules/', '/.openlore/', '/dist/', '/.git/'];
const IGNORED_SUFFIXES = ['.test.ts', '.test.js', '.spec.ts', '.spec.js'];

function isIgnoredPath(filePath: string): boolean {
  for (const seg of IGNORED_SEGMENTS) {
    if (filePath.includes(seg)) return true;
  }
  for (const suf of IGNORED_SUFFIXES) {
    if (filePath.endsWith(suf)) return true;
  }
  return false;
}

// ── McpWatcher ────────────────────────────────────────────────────────────────

export class McpWatcher {
  private readonly rootPath: string;
  private readonly outputPath: string;
  private readonly debounceMs: number;
  private readonly extraIgnore: string[];

  private fsWatcher?: FSWatcher;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(options: McpWatcherOptions) {
    this.rootPath   = options.rootPath;
    this.outputPath = options.outputPath
      ?? join(options.rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    this.debounceMs  = options.debounceMs ?? 400;
    this.extraIgnore = options.ignore ?? [];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const extraIgnore = this.extraIgnore;
      this.fsWatcher = chokidar.watch(this.rootPath, {
        ignored: (filePath: string) =>
          isIgnoredPath(filePath) ||
          extraIgnore.some((p) => filePath.includes(p)),
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      });

      this.fsWatcher.on('change', (absPath: string) => {
        if (SOURCE_EXTENSIONS.test(absPath)) {
          this.scheduleChange(absPath);
        }
      });

      this.fsWatcher.on('ready', () => resolve());
      this.fsWatcher.on('error', (err: unknown) => reject(err));
    });

    process.stderr.write(`[mcp-watcher] watching ${this.rootPath}\n`);
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.fsWatcher?.close();
    process.stderr.write('[mcp-watcher] stopped\n');
  }

  // ── Debounce ───────────────────────────────────────────────────────────────

  private scheduleChange(absPath: string): void {
    const existing = this.timers.get(absPath);
    if (existing) clearTimeout(existing);

    const t = setTimeout(() => {
      this.timers.delete(absPath);
      if (this.running) {
        // Re-schedule instead of dropping — ensures no changes are lost
        this.scheduleChange(absPath);
        return;
      }
      this.running = true;
      this.handleChange(absPath)
        .catch(err => process.stderr.write(`[mcp-watcher] error: ${(err as Error).message}\n`))
        .finally(() => { this.running = false; });
    }, this.debounceMs);

    this.timers.set(absPath, t);
  }

  // ── Core re-index ──────────────────────────────────────────────────────────

  /**
   * Re-index a single changed file.
   * Exposed for unit testing without needing a real file watcher.
   */
  async handleChange(absPath: string): Promise<void> {
    const rel = relative(this.rootPath, absPath);

    // Skip test files and unsupported languages
    if (isTestFile(rel)) return;
    if (detectLanguage(rel) === 'unknown') return;

    // Read new file content (needed for hash check and re-parse)
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      return; // file may have been deleted between the event and now
    }

    // ── Incremental edge update (CGC _handle_modification algorithm) ──────────
    if (EdgeStore.exists(this.outputPath)) {
      const store = EdgeStore.open(EdgeStore.dbPath(this.outputPath));
      try {
        // Content hash — skip entirely on no-op IDE autosaves
        const newHash = createHash('sha256').update(content).digest('hex');
        if (store.getFileHash(rel) === newHash) return;

        // Reverse lookup BEFORE delete so we know which files call into this one
        // callerFiles are relative paths (DB stores relative paths)
        const callerFiles = store.getCallerFiles(rel);

        // Re-parse BEFORE mutating DB — graph stays readable (old state) during parse
        const { edges: newEdges, nodes: newNodes } = await buildGraphSubset(rel, content, callerFiles, this.rootPath);

        // Atomic swap: delete stale data and insert fresh data in one transaction
        // so concurrent MCP reads never see a torn graph
        store.transaction(() => {
          store.deleteEdgesForFile(rel);
          for (const cf of callerFiles.slice(0, CALLER_REPARSE_LIMIT)) {
            store.deleteOutgoingEdgesForFile(cf);
          }
          store.deleteNodesForFile(rel);
          store.insertNodes(newNodes);
          store.insertEdges(newEdges);
          store.setFileHash(rel, newHash);
        });

        process.stderr.write(
          `[mcp-watcher] updated graph: ${rel} (+${newNodes.length} nodes, +${newEdges.length} edges, ${callerFiles.length} callers re-parsed)\n`
        );
      } finally {
        store.close();
      }
    }

    // ── Signature patch ───────────────────────────────────────────────────────
    const contextPath = join(this.outputPath, ARTIFACT_LLM_CONTEXT);
    let context: LLMContext;
    try {
      const raw = await readFile(contextPath, 'utf-8');
      context = JSON.parse(raw) as LLMContext;
    } catch {
      process.stderr.write(`[mcp-watcher] no context at ${contextPath} — run analyze first\n`);
      return;
    }

    const newMap = extractSignatures(rel, content);
    if (!context.signatures) context.signatures = [];
    const idx = context.signatures.findIndex(m => m.path === rel);
    if (idx >= 0) {
      context.signatures[idx] = newMap;
    } else {
      context.signatures.push(newMap);
    }

    await writeFile(contextPath, JSON.stringify(context, null, 2), 'utf-8');
    process.stderr.write(`[mcp-watcher] re-indexed signatures: ${rel}\n`);

    // Incremental vector re-embed — silently skipped if no embedding service available
    if (context.callGraph) {
      await this.reEmbed(context, rel, content);
    }
  }

  // ── Embed step ─────────────────────────────────────────────────────────────

  private async reEmbed(context: LLMContext, rel: string, content: string): Promise<void> {
    try {
      const { VectorIndex }      = await import('../analyzer/vector-index.js');
      const { EmbeddingService } = await import('../analyzer/embedding-service.js');
      const { readOpenLoreConfig } = await import('./config-manager.js');

      if (!VectorIndex.exists(this.outputPath)) return;

      let embedSvc: InstanceType<typeof EmbeddingService> | null;
      try {
        embedSvc = EmbeddingService.fromEnv();
      } catch {
        const cfg = await readOpenLoreConfig(this.rootPath);
        embedSvc = cfg ? EmbeddingService.fromConfig(cfg) : null;
      }
      // embedSvc may be null: VectorIndex.build then refreshes the BM25-only
      // corpus rather than re-embedding. Keeps the keyword index live in watch mode.

      const cg = context.callGraph!;
      const hubIds    = new Set((cg.hubFunctions ?? []).map(f => f.id));
      const entryIds  = new Set((cg.entryPoints ?? []).map(f => f.id));
      const fileContents = new Map([[rel, content]]);

      const { embedded, reused, total, hasEmbeddings } = await VectorIndex.build(
        this.outputPath,
        cg.nodes,
        context.signatures ?? [],
        hubIds,
        entryIds,
        embedSvc,
        fileContents,
        /* incremental */ true
      );

      process.stderr.write(
        hasEmbeddings
          ? `[mcp-watcher] re-embedded ${rel}: ${embedded} new, ${reused} reused\n`
          : `[mcp-watcher] refreshed BM25 index for ${rel}: ${total} functions\n`
      );
    } catch (err) {
      process.stderr.write(`[mcp-watcher] embed error: ${(err as Error).message}\n`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes('.test.') ||
    relPath.includes('.spec.') ||
    relPath.includes('__tests__')
  );
}

/**
 * Re-parse changedFile + up to CALLER_REPARSE_LIMIT callerFiles.
 * Returns fresh edges (all files in subset) and nodes (changedFile only —
 * callerFiles nodes are untouched since their function signatures didn't change).
 */
async function buildGraphSubset(
  changedRel: string,
  changedContent: string,
  callerFiles: string[],
  rootDir: string,
): Promise<{
  edges: import('../analyzer/call-graph.js').CallEdge[];
  nodes: import('../analyzer/call-graph.js').FunctionNode[];
}> {
  const lang = detectLanguage(changedRel);
  if (!CALL_GRAPH_LANGS.has(lang)) return { edges: [], nodes: [] };

  const { CallGraphBuilder } = await import('../analyzer/call-graph.js');
  // Use relative paths as node IDs (consistent with analyze output)
  const files: Array<{ path: string; content: string; language: string }> = [
    { path: changedRel, content: changedContent, language: lang },
  ];

  for (const cf of callerFiles.slice(0, CALLER_REPARSE_LIMIT)) {
    const cfLang = detectLanguage(cf);
    if (!CALL_GRAPH_LANGS.has(cfLang)) continue;
    try {
      const cfContent = await readFile(join(rootDir, cf), 'utf-8');
      files.push({ path: cf, content: cfContent, language: cfLang });
    } catch {
      // skip unreadable files
    }
  }

  const builder = new CallGraphBuilder();
  const result = await builder.build(files);

  // Only return nodes from changedFile — callerFiles nodes are already in DB and unchanged
  const changedNodes = Array.from(result.nodes.values()).filter(n => n.filePath === changedRel);

  return { edges: result.edges, nodes: changedNodes };
}
