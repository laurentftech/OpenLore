/**
 * Shared utilities for MCP tool handlers.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { LLMContext } from '../../analyzer/artifact-generator.js';
import { EdgeStore } from '../edge-store.js';
import { ANALYSIS_STALE_THRESHOLD_MS, ARTIFACT_FINGERPRINT, ARTIFACT_LLM_CONTEXT, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR } from '../../../constants.js';

/** LLMContext with optional SQLite edge store attached (present when call-graph.db exists). */
export type CachedContext = LLMContext & { edgeStore?: EdgeStore };
import { logger } from '../../../utils/logger.js';
import { emit } from '../telemetry.js';

/**
 * Resolve and validate a user-supplied directory path.
 *
 * Ensures the path resolves to an existing directory, which prevents path
 * traversal attacks where a client supplies `"../../../../etc"` or a plain
 * file path instead of a project directory.
 */
export async function validateDirectory(directory: string, maxDepth?: number): Promise<string> {
  logger.debug(`Validating directory: ${directory}`);
  return validateDirectoryImpl(directory, maxDepth);
}

export async function validateDirectoryImpl(directory: string, maxDepth?: number): Promise<string> {
  if (!directory || typeof directory !== 'string') {
    logger.warning('Directory validation failed: directory parameter is required and must be a string');
    throw new Error('directory parameter is required and must be a string');
  }
  const absDir = resolve(directory);
  logger.debug(`Resolved directory path: ${absDir}`);

  // Validate directory traversal depth if maxDepth is specified
  if (maxDepth !== undefined) {
    validateDirectoryDepth(absDir, maxDepth);
  }

  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(absDir);
  } catch {
    logger.error(`Directory validation failed: Directory not found: ${absDir}`);
    throw new Error(`Directory not found: ${absDir}`);
  }
  if (!s.isDirectory()) {
    logger.error(`Directory validation failed: Not a directory: ${absDir}`);
    throw new Error(`Not a directory: ${absDir}`);
  }
  logger.success(`Successfully validated directory: ${absDir}`);
  return absDir;
}

function calculateDirectoryDepth(path: string): number {
  const normalizedPath = path.replace(/^\\|\\$/g, '');
  const segments = normalizedPath.split(/[\\/]/);
  return segments.length;
}

export function validateDirectoryDepth(absDir: string, maxDepth: number): void {
  const depth = calculateDirectoryDepth(absDir);
  if (depth > maxDepth) {
    logger.error(`Directory validation failed: Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
    throw new Error(`Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
  }
}

/**
 * Strip common API key and token patterns from an error message before
 * returning it to MCP clients, to prevent secret leakage via error responses.
 * 
 * @param err - The error to sanitize
 * @param format - Output format: "string" (default) or "json"
 * @returns Sanitized error as string or {message, code} object when format is "json"
 */
export function sanitizeMcpError(err: unknown, format: 'string' | 'json' = 'string'): string | { message: string; code: number } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const sanitized = rawMessage
    .replace(/sk-ant-[A-Za-z0-9\-_]{10,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9\-_]{20,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S{10,}/g, 'Bearer [REDACTED]')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]')
    .replace(/api[_-]?key[=:]\s*\S{8,}/gi, 'api_key=[REDACTED]');
  
  if (format === 'json') {
    const errCode = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
    const code = typeof errCode === 'number' ? errCode : 500;
    return { message: sanitized, code };
  }
  
  return sanitized;
}

/**
 * Resolve a user-supplied relative file path against a validated project root
 * and ensure the result stays within that root. Prevents path traversal via
 * `../` sequences.
 */
export function safeJoin(absDir: string, filePath: string): string {
  const resolved = resolve(absDir, filePath);
  if (!resolved.startsWith(absDir + sep) && resolved !== absDir) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside project directory`);
  }
  return resolved;
}

interface ContextCacheEntry {
  ctx: CachedContext;
  mtime: number;
}

/** One entry per project directory. Invalidated by llm-context.json mtime change. */
const _contextCache = new Map<string, ContextCacheEntry>();

/** Test-only: clear in-memory context cache to force cold path. */
export function _resetContextCacheForTesting(): void {
  for (const entry of _contextCache.values()) entry.ctx.edgeStore?.close();
  _contextCache.clear();
}

export async function readCachedContext(directory: string, timeout?: number): Promise<CachedContext | null> {
  const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const filePath = join(analysisDir, ARTIFACT_LLM_CONTEXT);

  async function load(): Promise<CachedContext | null> {
    try {
      const mtime = (await stat(filePath)).mtimeMs;
      const cached = _contextCache.get(directory);
      if (cached && cached.mtime === mtime) {
        emit(directory, 'cache', { event: 'cache_read', hit: true });
        return cached.ctx;
      }
      // Cache miss — read 3.7MB JSON and open EdgeStore connection
      const raw = await readFile(filePath, 'utf-8');
      const ctx = JSON.parse(raw) as CachedContext;
      if (EdgeStore.exists(analysisDir)) {
        ctx.edgeStore = EdgeStore.open(EdgeStore.dbPath(analysisDir));
      }
      _contextCache.set(directory, { ctx, mtime });
      emit(directory, 'cache', { event: 'cache_read', hit: true });
      return ctx;
    } catch {
      emit(directory, 'cache', { event: 'cache_read', hit: false });
      return null;
    }
  }

  if (timeout !== undefined && timeout > 0) {
    return Promise.race([
      load(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error(`readCachedContext timed out after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  return load();
}

// ============================================================================
// PROJECT FINGERPRINT — content-hash based cache invalidation
// ============================================================================

const FINGERPRINT_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.openlore',
  'coverage', '.cache', '__pycache__', '.venv', 'venv', 'target',
  '.dart_tool', '.pub-cache',
]);

const FINGERPRINT_SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.cs',
]);

async function walkForFingerprint(
  dir: string,
  root: string,
  out: Array<{ path: string; mtime: number; size: number }>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!FINGERPRINT_SKIP_DIRS.has(entry.name)) {
        await walkForFingerprint(join(dir, entry.name), root, out);
      }
    } else if (entry.isFile() && FINGERPRINT_SOURCE_EXTS.has(extname(entry.name))) {
      try {
        const s = await stat(join(dir, entry.name));
        out.push({ path: relative(root, join(dir, entry.name)), mtime: s.mtimeMs, size: s.size });
      } catch {
        // skip unreadable
      }
    }
  }
}

/** Compute a SHA-256 fingerprint of all source file mtimes+sizes under rootDir. */
export async function computeProjectFingerprint(rootDir: string): Promise<string> {
  const files: Array<{ path: string; mtime: number; size: number }> = [];
  await walkForFingerprint(rootDir, rootDir, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const payload = files.map(f => `${f.path}:${f.mtime}:${f.size}`).join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Returns true if the cached analysis matches the current source files.
 * Uses content-hash fingerprint when available; falls back to TTL check.
 */
export async function isCacheFresh(directory: string): Promise<boolean> {
  const fingerprintPath = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_FINGERPRINT);
  try {
    const stored = JSON.parse(await readFile(fingerprintPath, 'utf-8')) as { hash: string };
    const current = await computeProjectFingerprint(directory);
    return current === stored.hash;
  } catch {
    // No fingerprint yet — fall back to TTL
    try {
      const s = await stat(join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT));
      return Date.now() - s.mtimeMs < ANALYSIS_STALE_THRESHOLD_MS;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// BIDIRECTIONAL CODE ↔ SPEC LINKING (#4)
// ============================================================================

export interface MappingEntry {
  requirement: string;
  service: string;
  domain: string;
  specFile: string;
  functions: Array<{ name: string; file: string; line: number; kind: string; confidence: string }>;
}

export interface MappingIndex {
  /** filePath → list of mapping entries that reference it */
  byFile: Map<string, MappingEntry[]>;
  /** domain → list of mapping entries for that domain */
  byDomain: Map<string, MappingEntry[]>;
  entries: MappingEntry[];
}

/** Cache for mapping indices, keyed by directory path */
const mappingCache = new Map<string, MappingIndex>();

/** Load and index mapping.json for bidirectional lookup. Returns null if not found. */
export async function loadMappingIndex(absDir: string, retryCount: number = 1): Promise<MappingIndex | null> {
  // Check cache first
  const cacheKey = absDir;
  const cached = mappingCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  const loadAttempt = async (attempt: number): Promise<MappingIndex | null> => {
    try {
      const raw = await readFile(join(absDir, '.openlore', 'analysis', 'mapping.json'), 'utf-8');
      const data = JSON.parse(raw) as { mappings: MappingEntry[] };
      const entries = data.mappings ?? [];
      
      const byFile = new Map<string, MappingEntry[]>();
      const byDomain = new Map<string, MappingEntry[]>();
      
      for (const entry of entries) {
        // index by domain
        const domainList = byDomain.get(entry.domain) ?? [];
        domainList.push(entry);
        byDomain.set(entry.domain, domainList);
        
        // index by each referenced file
        for (const fn of entry.functions) {
          if (!fn.file || fn.file === '*') continue;
          const fileList = byFile.get(fn.file) ?? [];
          // avoid duplicates (same requirement may appear multiple times per file)
          if (!fileList.includes(entry)) fileList.push(entry);
          byFile.set(fn.file, fileList);
        }
      }
      
      const result = { byFile, byDomain, entries };
      // Cache the result
      mappingCache.set(cacheKey, result);
      return result;
    } catch (error) {
      if (attempt < retryCount && error instanceof Error) {
        const delay = Math.pow(2, attempt) * 100; // Exponential backoff: 200ms, 400ms, 800ms...
        await new Promise(resolve => setTimeout(resolve, delay));
        return loadAttempt(attempt + 1);
      }
      return null;
    }
  };
  
  return loadAttempt(1);
}

/** Clear the mapping cache. Useful for tests to reset state. */
export function clearMappingCache(): void {
  mappingCache.clear();
}

/** Summarise which specs cover a given file path (for search_code enrichment). */
export function specsForFile(index: MappingIndex, filePath: string): Array<{ requirement: string; domain: string; specFile: string }> {
  const entries = index.byFile.get(filePath) ?? [];
  // deduplicate by requirement
  const seen = new Set<string>();
  return entries
    .filter(e => { const k = `${e.domain}::${e.requirement}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(e => ({ requirement: e.requirement, domain: e.domain, specFile: e.specFile }));
}

/** Return functions that implement a given domain/specFile (for search_specs enrichment). */
export function functionsForDomain(index: MappingIndex, domain: string): Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> {
  const entries = index.byDomain.get(domain) ?? [];
  const result: Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> = [];
  for (const entry of entries) {
    for (const fn of entry.functions) {
      if (fn.name === '*') continue;
      result.push({ ...fn, requirement: entry.requirement });
    }
  }
  return result;
}
