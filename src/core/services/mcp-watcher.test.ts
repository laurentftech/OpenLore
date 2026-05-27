/**
 * Tests for McpWatcher — handleChange (unit, no real FS watcher needed)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMContext } from '../analyzer/artifact-generator.js';
import type { SerializedCallGraph } from '../analyzer/call-graph.js';
import { EdgeStore } from './edge-store.js';
import type { CallEdge } from '../analyzer/call-graph.js';

// ── chokidar mock (prevents real FS watcher from opening) ────────────────────

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
      const watcher = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (!handlers.has(event)) handlers.set(event, []);
          handlers.get(event)!.push(handler);
          // Fire 'ready' synchronously so start() resolves in tests
          if (event === 'ready') handler();
          return watcher;
        }),
        close: vi.fn().mockResolvedValue(undefined),
      };
      return watcher;
    }),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<LLMContext> = {}): LLMContext {
  return {
    phase1_survey: { purpose: '', files: [], totalTokens: 0 },
    phase2_deep:   { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    signatures: [],
    ...overrides,
  };
}

function makeCallGraph(): SerializedCallGraph {
  return {
    nodes: [], edges: [], classes: [], inheritanceEdges: [],
    hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
}

async function setupProject(ctx: LLMContext): Promise<{ rootPath: string; outputPath: string; contextPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-test-'));
  const outputPath = join(rootPath, '.openlore', 'analysis');
  await mkdir(outputPath, { recursive: true });
  const contextPath = join(outputPath, 'llm-context.json');
  await writeFile(contextPath, JSON.stringify(ctx, null, 2), 'utf-8');
  return { rootPath, outputPath, contextPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpWatcher.handleChange', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('updates signatures for a changed TypeScript file', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'auth.ts');
    await writeFile(srcFile, 'export function login(user: string): boolean { return true; }', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entry = updated.signatures?.find(s => s.path === 'src/auth.ts');
    expect(entry).toBeDefined();
    expect(entry!.path).toBe('src/auth.ts');
    expect(entry!.language).toBe('TypeScript');
  });

  it('does not touch callGraph when patching signatures', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.callGraph).toEqual(cg);
  });

  it('preserves non-empty callGraph edges when patching signatures', async () => {
    const cg = makeCallGraph();
    cg.edges = [
      { callerId: 'src/a.ts::foo', calleeId: 'src/b.ts::bar', calleeName: 'bar', confidence: 'name_only' },
    ];
    cg.stats.totalEdges = 1;
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    // Change a file unrelated to the edge above
    const srcFile = join(rootPath, 'other.ts');
    await writeFile(srcFile, 'export function baz() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.callGraph?.edges).toHaveLength(1);
    expect(updated.callGraph?.edges?.[0].callerId).toBe('src/a.ts::foo');
    expect(updated.callGraph?.edges?.[0].calleeId).toBe('src/b.ts::bar');
    expect(updated.callGraph?.edges?.[0].calleeName).toBe('bar');
  });

  it('updates signatures when call-graph.db is absent (backward compat)', async () => {
    // No call-graph.db present — SQLite edge store not yet initialized.
    // Signature updates must still work regardless of DB presence.
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'service.ts');
    await writeFile(srcFile, 'export function doWork() { return 1; }', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.signatures?.some(s => s.path === 'src/service.ts')).toBe(true);
  });

  it('replaces an existing signature entry for the same file', async () => {
    const ctx = makeContext({
      signatures: [{ path: 'src/foo.ts', language: 'TypeScript', entries: [] }],
    });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'foo.ts');
    await writeFile(srcFile, 'export function bar() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entries = updated.signatures?.filter(s => s.path === 'src/foo.ts');
    expect(entries).toHaveLength(1);   // no duplicate
  });

  it('inserts a new entry when the file was not previously indexed', async () => {
    const ctx = makeContext({
      signatures: [{ path: 'src/other.ts', language: 'TypeScript', entries: [] }],
    });
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    const srcFile = join(rootPath, 'new.ts');
    await writeFile(srcFile, 'export function baz() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.signatures?.some(s => s.path === 'new.ts')).toBe(true);
    expect(updated.signatures?.some(s => s.path === 'src/other.ts')).toBe(true);
  });

  it('skips test files and does not write llm-context.json', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);
    const before = await readFile(contextPath, 'utf-8');

    const testFile = join(rootPath, 'auth.test.ts');
    await writeFile(testFile, 'it("test", () => {})', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(testFile);

    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);   // unchanged
  });

  it('skips files with unknown language', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);
    const before = await readFile(contextPath, 'utf-8');

    const txtFile = join(rootPath, 'notes.txt');
    await writeFile(txtFile, 'some text', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(txtFile);

    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);
  });

  it('warns to stderr and does not throw when llm-context.json is missing', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-missing-'));
    const outputPath = join(rootPath, '.openlore', 'analysis');
    // Do NOT create outputPath — simulate analyze never having been run

    const srcFile = join(rootPath, 'foo.ts');
    await writeFile(srcFile, 'export function x() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await expect(watcher.handleChange(srcFile)).resolves.not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('run analyze first'));
  });

  it('warns to stderr and does not throw when llm-context.json is corrupted', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'mcp-watcher-corrupt-'));
    const outputPath = join(rootPath, '.openlore', 'analysis');
    await mkdir(outputPath, { recursive: true });
    await writeFile(join(outputPath, 'llm-context.json'), '{ invalid json !!!', 'utf-8');

    const srcFile = join(rootPath, 'foo.ts');
    await writeFile(srcFile, 'export function x() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await expect(watcher.handleChange(srcFile)).resolves.not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('run analyze first'));
  });

  // ── SQLite edge update path ───────────────────────────────────────────────────

  it('updates edges in call-graph.db when DB is present and content changed', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath } = await setupProject(ctx);

    // Seed the DB with a stale edge from src/a.ts to src/b.ts (relative paths — DB convention)
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const staleEdge: CallEdge = {
      callerId: 'src/a.ts::foo',
      calleeId: 'src/b.ts::bar',
      calleeName: 'bar',
      confidence: 'name_only',
    };
    store.insertEdges([staleEdge]);
    store.close();

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'a.ts');
    // New content: foo no longer exists, only baz
    await writeFile(srcFile, 'export function baz() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    // Stale edge (foo → bar) should be gone since we deleted edges for src/a.ts
    const store2 = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const { outgoing } = store2.getEdgesForFile('src/a.ts');
    store2.close();
    // baz() doesn't call anything → 0 outgoing edges; stale edge was removed
    expect(outgoing.filter(e => e.calleeName === 'bar')).toHaveLength(0);
  });

  it('skips re-index when file content is unchanged (hash cache hit)', async () => {
    const ctx = makeContext();
    const { rootPath, outputPath, contextPath } = await setupProject(ctx);

    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'stable.ts');
    const content = 'export function stable() {}';
    await writeFile(srcFile, content, 'utf-8');

    // Seed hash cache with the same content (relative path — DB convention)
    const store = EdgeStore.open(EdgeStore.dbPath(outputPath));
    const { createHash } = await import('node:crypto');
    store.setFileHash('src/stable.ts', createHash('sha256').update(content).digest('hex'));
    store.close();

    const before = await readFile(contextPath, 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    // llm-context.json must not be written (early return on hash hit)
    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);
  });
});

// ── reEmbed paths ─────────────────────────────────────────────────────────────

describe('McpWatcher.reEmbed', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('refreshes the BM25 index (embedSvc=null) when no embedding service is available', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath } = await setupProject(ctx);

    // Write a fake vector index marker so VectorIndex.exists returns true
    await mkdir(join(outputPath, 'vector-index'), { recursive: true });
    await writeFile(join(outputPath, 'vector-index', '.keep'), '', 'utf-8');

    const mockBuild = vi.fn().mockResolvedValue({ embedded: 0, reused: 0, total: 1, hasEmbeddings: false });
    vi.doMock('../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), build: mockBuild },
    }));
    vi.doMock('../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockImplementation(() => { throw new Error('no EMBED_BASE_URL'); }),
        fromConfig: vi.fn().mockReturnValue(null),
      },
    }));
    vi.doMock('./config-manager.js', () => ({
      readOpenLoreConfig: vi.fn().mockResolvedValue(null),
    }));

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    // build is invoked with a null embedder (BM25 refresh), not skipped
    expect(mockBuild).toHaveBeenCalledWith(
      outputPath,
      cg.nodes,
      expect.any(Array),
      expect.any(Set),
      expect.any(Set),
      null,
      expect.any(Map),
      true,
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('refreshed BM25 index'),
    );
  });

  it('calls VectorIndex.build and logs when embedding succeeds', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath } = await setupProject(ctx);

    const mockBuild = vi.fn().mockResolvedValue({ embedded: 3, reused: 1, total: 4, hasEmbeddings: true });
    const mockEmbedSvc = {};

    vi.doMock('../analyzer/vector-index.js', () => ({
      VectorIndex: { exists: vi.fn().mockReturnValue(true), build: mockBuild },
    }));
    vi.doMock('../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockReturnValue(mockEmbedSvc),
        fromConfig: vi.fn(),
      },
    }));
    vi.doMock('./config-manager.js', () => ({
      readOpenLoreConfig: vi.fn().mockResolvedValue(null),
    }));

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await watcher.handleChange(srcFile);

    expect(mockBuild).toHaveBeenCalledWith(
      outputPath,
      cg.nodes,
      expect.any(Array),
      expect.any(Set),
      expect.any(Set),
      mockEmbedSvc,
      expect.any(Map),
      true,
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('re-embedded'),
    );
  });

  it('logs embed error and does not throw when VectorIndex.build throws', async () => {
    const cg = makeCallGraph();
    const ctx = makeContext({ callGraph: cg });
    const { rootPath, outputPath } = await setupProject(ctx);

    vi.doMock('../analyzer/vector-index.js', () => ({
      VectorIndex: {
        exists: vi.fn().mockReturnValue(true),
        build: vi.fn().mockRejectedValue(new Error('LanceDB connection failed')),
      },
    }));
    vi.doMock('../analyzer/embedding-service.js', () => ({
      EmbeddingService: {
        fromEnv: vi.fn().mockReturnValue({}),
        fromConfig: vi.fn(),
      },
    }));
    vi.doMock('./config-manager.js', () => ({
      readOpenLoreConfig: vi.fn().mockResolvedValue(null),
    }));

    const srcFile = join(rootPath, 'index.ts');
    await writeFile(srcFile, 'export function foo() {}', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath });
    await expect(watcher.handleChange(srcFile)).resolves.not.toThrow();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('embed error'),
    );
  });
});

// ── Debounce ──────────────────────────────────────────────────────────────────

describe('McpWatcher debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid changes to the same file into one handleChange call', async () => {
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: '/tmp/proj', debounceMs: 200 });
    const spy = vi.spyOn(watcher, 'handleChange').mockResolvedValue(undefined);

    // Simulate 5 rapid saves
    for (let i = 0; i < 5; i++) {
      (watcher as unknown as { scheduleChange(p: string): void }).scheduleChange('/tmp/proj/src/foo.ts');
    }

    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fires separate handleChange for two different files', async () => {
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: '/tmp/proj', debounceMs: 200 });
    const spy = vi.spyOn(watcher, 'handleChange').mockResolvedValue(undefined);

    (watcher as unknown as { scheduleChange(p: string): void }).scheduleChange('/tmp/proj/src/a.ts');
    (watcher as unknown as { scheduleChange(p: string): void }).scheduleChange('/tmp/proj/src/b.ts');

    await vi.runAllTimersAsync();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('McpWatcher reschedule-when-busy', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.useFakeTimers();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.useRealTimers();
  });

  it('reschedules a change instead of dropping it when busy', async () => {
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: '/tmp/proj', debounceMs: 100 });

    // Make handleChange block until we resolve it
    let resolveFirst!: () => void;
    const firstCall = new Promise<void>(r => { resolveFirst = r; });
    let callCount = 0;
    vi.spyOn(watcher, 'handleChange').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) await firstCall;
    });

    const schedule = (watcher as unknown as { scheduleChange(p: string): void }).scheduleChange.bind(watcher);

    // First change — will start processing after debounce
    schedule('/tmp/proj/src/a.ts');
    await vi.advanceTimersByTimeAsync(100);
    // handleChange is now running (blocked on firstCall)
    expect(callCount).toBe(1);

    // Second change arrives while busy — should be rescheduled, not dropped
    schedule('/tmp/proj/src/a.ts');
    await vi.advanceTimersByTimeAsync(100);
    // Still blocked — rescheduled change fires but sees busy, reschedules again
    expect(callCount).toBe(1);

    // Unblock first handleChange
    resolveFirst();
    await vi.advanceTimersByTimeAsync(200);

    // Rescheduled change should now have fired
    expect(callCount).toBe(2);
  });
});

// ── start / stop ──────────────────────────────────────────────────────────────

describe('McpWatcher start/stop', () => {
  it('starts without throwing and stop resolves', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath: '/tmp/proj' });
    await expect(watcher.start()).resolves.not.toThrow();
    await expect(watcher.stop()).resolves.not.toThrow();
  });
});
