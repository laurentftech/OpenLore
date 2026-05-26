/**
 * MCP handler performance benchmark.
 *
 * Measures cold vs warm path for:
 *   - readCachedContext (file IO + JSON.parse + EdgeStore connect)
 *   - handleOrient (full orient flow incl. vector search)
 *   - handleSearchCode (BM25 / hybrid)
 *
 * Run: npx tsx scripts/bench-mcp.ts [project-dir]
 *
 * Requires: openlore analyze has been run (call-graph.db + llm-context.json exist).
 */

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readCachedContext, _resetContextCacheForTesting } from '../src/core/services/mcp-handlers/utils.js';
import { handleOrient } from '../src/core/services/mcp-handlers/orient.js';
import { handleSearchCode } from '../src/core/services/mcp-handlers/semantic.js';
import { _resetVectorIndexCachesForTesting } from '../src/core/analyzer/vector-index.js';
import { configureLogger } from '../src/utils/logger.js';

configureLogger({ quiet: true });

function resetAllCaches(): void {
  _resetContextCacheForTesting();
  _resetVectorIndexCachesForTesting();
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const targetDir = process.argv[2]
  ? resolve(process.argv[2])
  : join(__dirname, '..');

if (!existsSync(join(targetDir, '.openlore', 'analysis', 'llm-context.json'))) {
  console.error(`llm-context.json not found in ${targetDir}/.openlore/analysis/`);
  console.error(`Run: openlore analyze ${targetDir}`);
  process.exit(1);
}

interface Stats { min: number; p50: number; p95: number; max: number; mean: number }

async function measureAsync(fn: () => Promise<unknown>, iterations = 50, warmup = 3): Promise<Stats> {
  for (let i = 0; i < warmup; i++) await fn();
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    min: times[0],
    p50: times[Math.floor(iterations * 0.5)],
    p95: times[Math.floor(iterations * 0.95)],
    max: times[times.length - 1],
    mean: sum / iterations,
  };
}

async function measureColdAsync(fn: () => Promise<unknown>, iterations = 20, reset: () => void): Promise<Stats> {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    reset();
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    min: times[0],
    p50: times[Math.floor(iterations * 0.5)],
    p95: times[Math.floor(iterations * 0.95)],
    max: times[times.length - 1],
    mean: sum / iterations,
  };
}

function fmt(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}

function row(label: string, s: Stats): void {
  console.log(
    `  ${label.padEnd(38)} │ ${fmt(s.min).padStart(8)} │ ${fmt(s.p50).padStart(8)} │ ${fmt(s.p95).padStart(8)} │ ${fmt(s.mean).padStart(8)}`
  );
}

function header(): void {
  console.log(
    `  ${'Operation'.padEnd(38)} │ ${'min'.padStart(8)} │ ${'p50'.padStart(8)} │ ${'p95'.padStart(8)} │ ${'mean'.padStart(8)}`
  );
  console.log(
    `  ${'-'.repeat(38)}-┼-${'-'.repeat(8)}-┼-${'-'.repeat(8)}-┼-${'-'.repeat(8)}-┼-${'-'.repeat(8)}`
  );
}

async function main() {
  console.log(`\nMCP handler benchmark — ${targetDir}\n`);

  // ── readCachedContext ───────────────────────────────────────────────────────
  console.log(`readCachedContext`);
  header();

  const ctxCold = await measureColdAsync(
    () => readCachedContext(targetDir),
    20,
    () => _resetContextCacheForTesting()
  );
  row('cold (cache cleared each call)', ctxCold);

  const ctxWarm = await measureAsync(() => readCachedContext(targetDir), 100);
  row('warm (mtime hit)', ctxWarm);

  // ── handleOrient ────────────────────────────────────────────────────────────
  console.log(`\nhandleOrient ("authentication middleware")`);
  header();

  const orientCold = await measureColdAsync(
    () => handleOrient(targetDir, 'authentication middleware', 5),
    10,
    resetAllCaches
  );
  row('cold (cache cleared each call)', orientCold);

  const orientWarm = await measureAsync(
    () => handleOrient(targetDir, 'authentication middleware', 5),
    30,
    3
  );
  row('warm', orientWarm);

  // ── handleSearchCode ────────────────────────────────────────────────────────
  console.log(`\nhandleSearchCode ("panic state")`);
  header();

  const searchCold = await measureColdAsync(
    () => handleSearchCode(targetDir, 'panic state', 10),
    10,
    resetAllCaches
  );
  row('cold (cache cleared each call)', searchCold);

  const searchWarm = await measureAsync(
    () => handleSearchCode(targetDir, 'panic state', 10),
    30,
    3
  );
  row('warm', searchWarm);

  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
