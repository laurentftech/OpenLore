/**
 * SCIP export tests — run the real call-graph builder over a tiny 3-file
 * fixture, export it to SCIP, and assert that the output parses back through
 * the vendored protobuf schema with the expected invariants.
 *
 * Counts are locked exactly (the fixture is small and stable): see
 * fixtures/tiny-repo/. If you change the fixture, re-derive the numbers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CallGraphBuilder, type SerializedCallGraph } from '../analyzer/call-graph.js';
import { exportScip, type ExportReport } from './index.js';
import { scipIndexType } from './schema.js';
import { scipLanguageName } from './moniker.js';

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/tiny-repo', import.meta.url));
const FIXTURE_FILES = ['src/math.ts', 'src/greet.ts', 'src/index.ts'];

function emptyReport(): ExportReport {
  return {
    documentCount: 0,
    occurrenceCount: 0,
    symbolCount: 0,
    definitionCount: 0,
    unspecifiedLanguageFiles: [],
    warnings: [],
  };
}

async function buildFixtureGraph(): Promise<SerializedCallGraph> {
  const files = FIXTURE_FILES.map(rel => ({
    path: rel,
    language: 'TypeScript',
    content: readFileSync(join(FIXTURE_DIR, rel), 'utf-8'),
  }));
  const r = await new CallGraphBuilder().build(files);
  return {
    nodes: [...r.nodes.values()],
    edges: r.edges,
    classes: r.classes,
    inheritanceEdges: r.inheritanceEdges,
    hubFunctions: r.hubFunctions,
    entryPoints: r.entryPoints,
    layerViolations: r.layerViolations,
    stats: r.stats,
  };
}

const BASE_OPTS = {
  projectRoot: FIXTURE_DIR,
  package: { manager: 'npm', name: 'tiny-repo', version: '1.0.0' },
  toolVersion: '9.9.9',
};

describe('exportScip — tiny-repo fixture', () => {
  let graph: SerializedCallGraph;
  beforeAll(async () => {
    graph = await buildFixtureGraph();
  });

  it('produces a non-empty index that parses back through the SCIP schema', () => {
    const buf = exportScip(graph, { ...BASE_OPTS });
    expect(buf.byteLength).toBeGreaterThan(0);

    const Index = scipIndexType();
    const decoded = Index.toObject(Index.decode(buf), { enums: String }) as {
      metadata: { tool_info: { name: string; version: string }; project_root: string; text_document_encoding: string };
      documents: Array<{ relative_path: string; language: string; occurrences: unknown[]; symbols: unknown[] }>;
    };

    expect(decoded.metadata.tool_info).toEqual({ name: 'openlore', version: '9.9.9' });
    expect(decoded.metadata.text_document_encoding).toBe('UTF8');
    expect(decoded.metadata.project_root).toMatch(/^file:\/\//);
    expect(decoded.documents.length).toBe(3);
  });

  it('asserts exact document, symbol, occurrence, and definition counts', () => {
    const report = emptyReport();
    exportScip(graph, { ...BASE_OPTS, report });
    expect(report).toMatchObject({
      documentCount: 3,
      symbolCount: 4,
      occurrenceCount: 8,
      definitionCount: 4,
    });
    expect(report.unspecifiedLanguageFiles).toEqual([]);
  });

  it('emits the spec-documented symbol moniker format', () => {
    const buf = exportScip(graph, { ...BASE_OPTS });
    const Index = scipIndexType();
    const decoded = Index.toObject(Index.decode(buf)) as {
      documents: Array<{ relative_path: string; symbols: Array<{ symbol: string }> }>;
    };
    const math = decoded.documents.find(d => d.relative_path === 'src/math.ts')!;
    const symbols = math.symbols.map(s => s.symbol);
    expect(symbols).toContain('openlore npm tiny-repo 1.0.0 `src/math.ts`/add(2).');
    expect(symbols).toContain('openlore npm tiny-repo 1.0.0 `src/math.ts`/double(1).');
  });

  it('is byte-deterministic across runs on the same graph', () => {
    const a = exportScip(graph, { ...BASE_OPTS });
    const b = exportScip(graph, { ...BASE_OPTS });
    const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
    expect(sha(a)).toBe(sha(b));
  });

  it('sorts documents by path, occurrences by (line, col), and dedups symbols', () => {
    const buf = exportScip(graph, { ...BASE_OPTS });
    const Index = scipIndexType();
    const decoded = Index.toObject(Index.decode(buf)) as {
      documents: Array<{ relative_path: string; occurrences: Array<{ range: number[] }>; symbols: Array<{ symbol: string }> }>;
    };

    const paths = decoded.documents.map(d => d.relative_path);
    expect(paths).toEqual([...paths].sort());

    for (const doc of decoded.documents) {
      const ranges = doc.occurrences.map(o => [o.range[0] ?? 0, o.range[1] ?? 0]);
      const sorted = [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      expect(ranges).toEqual(sorted);

      const syms = doc.symbols.map(s => s.symbol);
      expect(syms.length).toBe(new Set(syms).size);
    }
  });

  it('warns once that column-level ranges are unavailable', () => {
    const report = emptyReport();
    exportScip(graph, { ...BASE_OPTS, report });
    expect(report.warnings.some(w => /column-level ranges/i.test(w))).toBe(true);
    expect(report.warnings.length).toBe(1);
  });

  it('filters with --include / --exclude globs', () => {
    const report = emptyReport();
    exportScip(graph, { ...BASE_OPTS, include: ['src/**'], exclude: ['src/math.ts'], report });
    // math.ts dropped → only greet.ts and index.ts remain as documents.
    expect(report.documentCount).toBe(2);
    // add/double symbols gone → only greet + main definitions.
    expect(report.definitionCount).toBe(2);
  });

  it('excludes synthetic external nodes', () => {
    // External nodes carry isExternal and have no real file; they must never
    // appear as exported symbols.
    const withExternal: SerializedCallGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 'external::fetch',
          name: 'fetch',
          filePath: 'external',
          isAsync: false,
          language: 'unknown',
          startIndex: 0,
          endIndex: 0,
          fanIn: 0,
          fanOut: 0,
          isExternal: true,
        },
      ],
    };
    const report = emptyReport();
    exportScip(withExternal, { ...BASE_OPTS, report });
    expect(report.symbolCount).toBe(4); // unchanged
  });

  it('fails loudly when a node lacks a defining line', () => {
    const broken: SerializedCallGraph = {
      ...graph,
      nodes: graph.nodes.map(n => ({ ...n, startLine: undefined })),
    };
    expect(() => exportScip(broken, { ...BASE_OPTS })).toThrow(/no defining line/);
  });
});

describe('scipLanguageName', () => {
  it('maps known OpenLore tags to SCIP enum names', () => {
    expect(scipLanguageName('TypeScript')).toBe('TypeScript');
    expect(scipLanguageName('C++')).toBe('CPP');
    expect(scipLanguageName('C#')).toBe('CSharp');
  });

  it('maps spec-08 languages with SCIP enum values', () => {
    expect(scipLanguageName('Kotlin')).toBe('Kotlin');
    expect(scipLanguageName('PHP')).toBe('PHP');
    expect(scipLanguageName('C')).toBe('C');
  });

  it('maps spec-08 languages without SCIP enum values to UnspecifiedLanguage', () => {
    for (const lang of ['Scala', 'Dart', 'Lua', 'Elixir', 'Bash']) {
      expect(scipLanguageName(lang)).toBe('');
    }
  });

  it('returns empty string for languages SCIP has no enum value for', () => {
    expect(scipLanguageName('unknown')).toBe('');
    expect(scipLanguageName('Brainfuck')).toBe('');
  });

  it('maps IaC (spec-07) tags to UnspecifiedLanguage (empty string)', () => {
    for (const lang of ['Terraform', 'Kubernetes', 'Helm', 'CloudFormation', 'Ansible', 'Pulumi', 'CDK', 'CDKTF']) {
      expect(scipLanguageName(lang)).toBe('');
    }
  });
});
