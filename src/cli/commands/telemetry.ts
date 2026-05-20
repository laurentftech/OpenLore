/**
 * openlore telemetry — cognitive telemetry analysis for EpistemicLease.
 *
 * Reads append-only JSONL streams from .openlore/telemetry/ and computes
 * higher-level behavioral metrics describing long-session agent cognition.
 *
 * Streams line-by-line via readline (O(1) memory — arbitrarily large sessions).
 */

import { Command } from 'commander';
import { createReadStream, existsSync, watch } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';

const TELEMETRY_SUBDIR = 'telemetry';

// ============================================================================
// JSONL reader — O(1) streaming
// ============================================================================

async function readJsonl<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) return [];
  const rows: T[] = [];
  const rl = createInterface({ input: createReadStream(filePath, 'utf-8'), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed) as T); } catch { /* skip malformed */ }
  }
  return rows;
}

interface McpEvent {
  ts: string; event: 'tool_call' | 'tool_error'; tool: string;
  ms: number; agent?: string; agent_version?: string; error?: string;
}
interface OrientEvent {
  ts: string; event: 'orient_call';
  agent?: string; functions: number; files: number;
  spec_domains: number; insertion_points: number;
}
interface CacheEvent {
  ts: string; event: 'cache_read'; hit: boolean;
}
interface LeaseEvent {
  ts: string;
  event: 'degraded' | 'stale' | 'depth_escalate' | 'orient_reset';
  trigger?: string; depth?: number; from_depth?: number; to_depth?: number;
  from_state?: string; tool?: string; cognitive_load?: number;
  density?: number; oscillation?: number; age_min?: number; prior_load?: number; prior_depth?: number;
}
interface PanicEvent {
  ts: string;
  event: 'panic_level_change' | 'panic_orient_reset' | 'hook_intervention' | 'panic_signal_injected';
  from_level?: number; to_level?: number;
  panic_score?: number; severity?: string;
  orient_kind?: 'normal' | 'rapid' | 'spam';
  delta?: number; from_score?: number; to_score?: number;
  intervention_count?: number;
  call_triggers?: string[];
  gryph_enriched?: boolean;
}

// ============================================================================
// METRIC COMPUTATIONS
// ============================================================================

function computeToolStats(mcp: McpEvent[]) {
  const calls = mcp.filter(e => e.event === 'tool_call');
  const errors = mcp.filter(e => e.event === 'tool_error');
  const byTool = new Map<string, number[]>();
  for (const e of calls) {
    const arr = byTool.get(e.tool) ?? [];
    arr.push(e.ms);
    byTool.set(e.tool, arr);
  }
  const stats = [...byTool.entries()].map(([tool, latencies]) => {
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    const max = Math.max(...latencies);
    return { tool, count: latencies.length, avg_ms: avg, max_ms: max };
  }).sort((a, b) => b.count - a.count);
  return { stats, total_calls: calls.length, total_errors: errors.length };
}

function computeCacheStats(cache: CacheEvent[]) {
  const hits = cache.filter(e => e.hit).length;
  const total = cache.length;
  return { hits, misses: total - hits, total, hit_rate: total ? Math.round(hits / total * 100) : 0 };
}

function computeOrientQuality(orient: OrientEvent[]) {
  if (!orient.length) return null;
  const avg = (arr: number[]) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const byAgent = new Map<string, OrientEvent[]>();
  for (const e of orient) {
    const agent = e.agent ?? 'unknown';
    const arr = byAgent.get(agent) ?? [];
    arr.push(e);
    byAgent.set(agent, arr);
  }
  const perAgent = [...byAgent.entries()]
    .map(([agent, events]) => ({
      agent,
      calls: events.length,
      avg_functions: avg(events.map(e => e.functions)),
      avg_files: avg(events.map(e => e.files)),
      avg_insertion_points: avg(events.map(e => e.insertion_points)),
    }))
    .sort((a, b) => b.calls - a.calls);
  return { total_calls: orient.length, per_agent: perAgent };
}

/**
 * Obstinacy: tool calls (non-orient) after each stale event before next orient/reset.
 * High value = agent ignores stale warnings.
 */
function computeObstinacy(mcp: McpEvent[], lease: LeaseEvent[]) {
  // Merge and sort by ts
  type Tagged = { ts: string; kind: 'stale' | 'orient' | 'tool'; depth?: number; tool?: string };
  const events: Tagged[] = [];

  for (const e of lease) {
    if (e.event === 'stale') events.push({ ts: e.ts, kind: 'stale', depth: e.depth });
    if (e.event === 'orient_reset') events.push({ ts: e.ts, kind: 'orient' });
  }
  for (const e of mcp) {
    if (e.event === 'tool_call') events.push({ ts: e.ts, kind: e.tool === 'orient' ? 'orient' : 'tool', tool: e.tool });
  }
  // ISO 8601 strings from toISOString() are lexicographically sortable
  events.sort((a, b) => a.ts.localeCompare(b.ts));

  const segments: { depth: number; calls_before_orient: number }[] = [];
  let inStale = false;
  let staleDepth = 0;
  let callCount = 0;

  for (const ev of events) {
    if (ev.kind === 'stale') {
      if (!inStale) { inStale = true; staleDepth = ev.depth ?? 1; callCount = 0; }
      else if ((ev.depth ?? 1) > staleDepth) { staleDepth = ev.depth ?? 1; }
    } else if (ev.kind === 'orient') {
      if (inStale) { segments.push({ depth: staleDepth, calls_before_orient: callCount }); }
      inStale = false; callCount = 0;
    } else if (ev.kind === 'tool' && inStale) {
      callCount++;
    }
  }
  if (inStale) segments.push({ depth: staleDepth, calls_before_orient: callCount });

  const avg = (arr: number[]) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '—';
  const d2 = segments.filter(s => s.depth >= 2).map(s => s.calls_before_orient);
  const d3 = segments.filter(s => s.depth >= 3).map(s => s.calls_before_orient);
  return {
    total_stale_episodes: segments.length,
    avg_calls_before_orient: avg(segments.map(s => s.calls_before_orient)),
    depth2_avg: avg(d2),
    depth3_avg: avg(d3),
    episodes: segments,
  };
}

/**
 * Recovery efficiency: time from stale to orient call (ms),
 * and recovery half-life: time from orient_reset to first degraded/stale after it.
 */
function computeRecovery(mcp: McpEvent[], lease: LeaseEvent[]) {
  const staleTs = lease.filter(e => e.event === 'stale').map(e => e.ts).sort();
  const orientTs = mcp.filter(e => e.event === 'tool_call' && e.tool === 'orient').map(e => e.ts).sort();

  const latencies: number[] = [];
  for (const st of staleTs) {
    const next = orientTs.find(o => o > st);
    if (next) latencies.push(new Date(next).getTime() - new Date(st).getTime());
  }
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  // Recovery half-life: orient_reset → next degraded/stale (how long context stays fresh post-orient).
  const resetTs = lease.filter(e => e.event === 'orient_reset').map(e => e.ts).sort();
  const degradationTs = lease.filter(e => e.event === 'degraded' || e.event === 'stale').map(e => e.ts).sort();
  const stableDurations: number[] = [];
  for (const rt of resetTs) {
    const next = degradationTs.find(d => d > rt);
    if (next) stableDurations.push(new Date(next).getTime() - new Date(rt).getTime());
  }
  const avgStableMs = stableDurations.length
    ? Math.round(stableDurations.reduce((a, b) => a + b, 0) / stableDurations.length)
    : null;

  const staleRecurrences = lease.filter(e => e.event === 'stale').length;
  const orients = orientTs.length;
  return {
    stale_events: staleRecurrences,
    orient_calls: orients,
    orient_resets: resetTs.length,
    avg_recovery_ms: avg,
    avg_stable_after_orient_ms: avgStableMs,
    recurrence_rate: orients ? `${(staleRecurrences / orients).toFixed(2)} stale/orient` : '—',
  };
}

// Exported for testing
export type { PanicEvent, LeaseEvent, McpEvent };
export { computePanicStats, computeRecovery, computeObstinacy };

/**
 * Panic stats: episode count, avg recovery latency, hook intercepts, orient spam.
 */
function computePanicStats(panic: PanicEvent[]) {
  // Episodes: sequences from first level change up to return to level 0
  const levelChanges = panic.filter(e => e.event === 'panic_level_change');
  const hookIntercepts = panic.filter(e => e.event === 'hook_intervention').length;
  const injections = panic.filter(e => e.event === 'panic_signal_injected').length;

  // Episode: starts when level goes from 0→N, ends when N→0
  const episodes: { start: string; end?: string; peak: number }[] = [];
  let inEpisode = false;
  let peakLevel = 0;
  let startTs = '';
  for (const e of levelChanges.sort((a, b) => a.ts.localeCompare(b.ts))) {
    const from = e.from_level ?? 0;
    const to = e.to_level ?? 0;
    if (!inEpisode && from === 0 && to > 0) {
      inEpisode = true; peakLevel = to; startTs = e.ts;
    } else if (inEpisode) {
      if (to > peakLevel) peakLevel = to;
      if (to === 0) {
        episodes.push({ start: startTs, end: e.ts, peak: peakLevel });
        inEpisode = false; peakLevel = 0;
      }
    }
  }
  if (inEpisode) episodes.push({ start: startTs, peak: peakLevel });

  // Avg recovery latency (ms): episode start to end
  const completedEpisodes = episodes.filter(e => e.end);
  const recoveryLatencies = completedEpisodes.map(e =>
    new Date(e.end!).getTime() - new Date(e.start).getTime()
  );
  const avgRecoveryMs = recoveryLatencies.length
    ? Math.round(recoveryLatencies.reduce((a, b) => a + b, 0) / recoveryLatencies.length)
    : null;

  // Failed recovery rate: episodes that never returned to L0
  const failedRate = episodes.length
    ? `${episodes.filter(e => !e.end).length}/${episodes.length}`
    : '—';

  // Orient spam events
  const orientResets = panic.filter(e => e.event === 'panic_orient_reset');
  const spamOrients = orientResets.filter(e => e.orient_kind === 'spam').length;
  const rapidOrients = orientResets.filter(e => e.orient_kind === 'rapid').length;

  // Gryph enrichments
  const gryphEnriched = panic.filter(e => e.event === 'hook_intervention' && e.gryph_enriched).length;

  // Trigger frequency across all events
  const triggerCounts = new Map<string, number>();
  for (const e of panic) {
    for (const t of e.call_triggers ?? []) {
      triggerCounts.set(t, (triggerCounts.get(t) ?? 0) + 1);
    }
  }

  return {
    panic_episodes: episodes.length,
    avg_recovery_ms: avgRecoveryMs,
    failed_recovery_rate: failedRate,
    hook_intercepts: hookIntercepts,
    mcp_injections: injections,
    orient_spam_events: spamOrients,
    orient_rapid_events: rapidOrients,
    gryph_enriched_intercepts: gryphEnriched,
    trigger_counts: [...triggerCounts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/**
 * Trajectory entropy: low entropy oscillation (auth→billing→auth→billing) vs
 * exploratory (auth→billing→infra→cache). Uses bigram repetition ratio.
 */
function computeTrajectoryEntropy(lease: LeaseEvent[]) {
  const densities = lease
    .filter(e => e.event === 'degraded' || e.event === 'stale')
    .map(e => e.density ?? 0)
    .filter(d => d > 0);

  const bursts = lease.filter(e => (e.event === 'degraded' || e.event === 'stale') && (e.density ?? 0) >= 0.6).length;
  const avg = densities.length ? (densities.reduce((a, b) => a + b, 0) / densities.length).toFixed(3) : '—';
  const max = densities.length ? Math.max(...densities).toFixed(3) : '—';

  return {
    avg_density: avg,
    max_density: max,
    burst_events: bursts,
    density_samples: densities.length,
  };
}

// ============================================================================
// RENDERING
// ============================================================================

function hr() { console.log('─'.repeat(60)); }
function section(title: string) { hr(); console.log(`  ${title}`); hr(); }

function renderSummary(
  mcp: McpEvent[], orient: OrientEvent[], cache: CacheEvent[], lease: LeaseEvent[], panicEvents: PanicEvent[]
) {
  const tools = computeToolStats(mcp);
  const cacheStats = computeCacheStats(cache);
  const quality = computeOrientQuality(orient);
  const obstinacy = computeObstinacy(mcp, lease);
  const recovery = computeRecovery(mcp, lease);
  const trajectory = computeTrajectoryEntropy(lease);
  const panicStats = computePanicStats(panicEvents);

  section('TOOL LATENCY');
  if (tools.stats.length) {
    console.log(`  ${'tool'.padEnd(32)} ${'calls'.padStart(6)} ${'avg ms'.padStart(8)} ${'max ms'.padStart(8)}`);
    for (const s of tools.stats.slice(0, 15)) {
      console.log(`  ${s.tool.padEnd(32)} ${String(s.count).padStart(6)} ${String(s.avg_ms).padStart(8)} ${String(s.max_ms).padStart(8)}`);
    }
    console.log(`\n  total: ${tools.total_calls} calls, ${tools.total_errors} errors`);
  } else {
    console.log('  no mcp.jsonl data');
  }

  section('CACHE');
  console.log(`  hit rate : ${cacheStats.hit_rate}%  (${cacheStats.hits} hits / ${cacheStats.total} reads)`);

  section('ORIENT QUALITY');
  if (quality) {
    console.log(`  total calls : ${quality.total_calls}\n`);
    console.log(`  ${'agent'.padEnd(28)} ${'calls'.padStart(6)} ${'avg fn'.padStart(8)} ${'avg files'.padStart(10)} ${'avg ins pts'.padStart(12)}`);
    for (const r of quality.per_agent) {
      console.log(`  ${r.agent.padEnd(28)} ${String(r.calls).padStart(6)} ${String(r.avg_functions).padStart(8)} ${String(r.avg_files).padStart(10)} ${String(r.avg_insertion_points).padStart(12)}`);
    }
  } else {
    console.log('  no orient.jsonl data');
  }

  section('EPISTEMIC STATE');
  const degraded = lease.filter(e => e.event === 'degraded').length;
  const stale = lease.filter(e => e.event === 'stale').length;
  const d2 = lease.filter(e => e.event === 'stale' && (e.depth ?? 0) >= 2).length;
  const d3 = lease.filter(e => e.event === 'stale' && (e.depth ?? 0) >= 3).length;
  const triggers = new Map<string, number>();
  for (const e of lease) {
    if (e.trigger) triggers.set(e.trigger, (triggers.get(e.trigger) ?? 0) + 1);
  }
  console.log(`  degraded events  : ${degraded}`);
  console.log(`  stale events     : ${stale}  (depth≥2: ${d2}, depth≥3: ${d3})`);
  if (triggers.size) {
    console.log(`  triggers         : ${[...triggers.entries()].map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }

  section('OBSTINACY INDEX');
  console.log(`  stale episodes         : ${obstinacy.total_stale_episodes}`);
  console.log(`  avg calls before orient: ${obstinacy.avg_calls_before_orient}`);
  console.log(`  depth≥2 avg            : ${obstinacy.depth2_avg}`);
  console.log(`  depth≥3 avg            : ${obstinacy.depth3_avg}`);

  section('RECOVERY EFFICIENCY');
  console.log(`  avg stale→orient latency : ${recovery.avg_recovery_ms != null ? `${recovery.avg_recovery_ms}ms` : '—'}`);
  console.log(`  recovery half-life       : ${recovery.avg_stable_after_orient_ms != null ? `${recovery.avg_stable_after_orient_ms}ms` : '—'}  (orient_reset → next degradation)`);
  console.log(`  orient resets            : ${recovery.orient_resets}`);
  console.log(`  recurrence rate          : ${recovery.recurrence_rate}`);

  section('TRAJECTORY DYNAMICS');
  console.log(`  avg cross-module density : ${trajectory.avg_density}`);
  console.log(`  max density              : ${trajectory.max_density}`);
  console.log(`  burst events (≥0.6)      : ${trajectory.burst_events}`);

  section('PANIC RESPONSE');
  console.log(`  panic episodes           : ${panicStats.panic_episodes}`);
  console.log(`  avg recovery latency     : ${panicStats.avg_recovery_ms != null ? `${panicStats.avg_recovery_ms}ms` : '—'}`);
  console.log(`  failed recovery rate     : ${panicStats.failed_recovery_rate}`);
  console.log(`  hook intercepts          : ${panicStats.hook_intercepts}`);
  console.log(`  mcp injections           : ${panicStats.mcp_injections}`);
  console.log(`  orient spam events       : ${panicStats.orient_spam_events}  (rapid: ${panicStats.orient_rapid_events})`);
  console.log(`  gryph-enriched           : ${panicStats.gryph_enriched_intercepts}`);
  if (panicStats.trigger_counts.length) {
    console.log(`  triggers                 : ${panicStats.trigger_counts.map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }

  hr();
}

function renderLive(dir: string) {
  const leaseFile = join(dir, OPENLORE_DIR, TELEMETRY_SUBDIR, 'epistemic-lease.jsonl');
  const mcpFile = join(dir, OPENLORE_DIR, TELEMETRY_SUBDIR, 'mcp.jsonl');

  // Track file positions to only read new lines; in-flight guard prevents
  // overlapping reads when watch() fires twice before the first stream ends.
  const offsets = new Map<string, number>([
    [leaseFile, 0], [mcpFile, 0],
  ]);
  const inFlight = new Set<string>();

  async function tail(filePath: string) {
    if (!existsSync(filePath)) return;
    if (inFlight.has(filePath)) return;
    inFlight.add(filePath);
    const { createReadStream } = await import('node:fs');
    const offset = offsets.get(filePath) ?? 0;
    const stream = createReadStream(filePath, { start: offset, encoding: 'utf-8' });
    let buf = '';
    stream.on('data', chunk => { buf += chunk; });
    stream.on('end', () => {
      offsets.set(filePath, offset + Buffer.byteLength(buf, 'utf-8'));
      inFlight.delete(filePath);
      for (const line of buf.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as Record<string, unknown>;
          const ts = String(ev['ts'] ?? '').slice(11, 23);
          if (filePath === leaseFile) {
            const evt = ev['event'];
            if (evt === 'stale' || evt === 'degraded') {
              const density = Number(ev['density'] ?? 0);
              const oscillation = Number(ev['oscillation'] ?? 0);
              const isSpike = density >= 0.60;
              const isOscillating = oscillation >= 0.50;
              const structuredType = isSpike ? 'TRAJECTORY_SPIKE' : 'STATE_TRANSITION';
              const depthStr = evt === 'stale' ? ` depth=${ev['depth']}` : '';
              let line = `${ts}  [${structuredType}] ${String(evt).toUpperCase()}${depthStr} trigger=${ev['trigger']} load=${ev['cognitive_load']} density=${density.toFixed(3)}`;
              if (isOscillating) line += `  [OSCILLATION_DETECTED osc=${oscillation.toFixed(2)}]`;
              console.log(line);
            } else if (evt === 'orient_reset') {
              console.log(`${ts}  [ORIENT_RECOVERY] from=${ev['from_state']} prior_load=${ev['prior_load']} prior_depth=${ev['prior_depth']}`);
            } else if (evt === 'depth_escalate') {
              const burstStr = ev['trigger'] === 'burst' ? ' (burst)' : '';
              console.log(`${ts}  [STATE_TRANSITION] DEPTH ${ev['from_depth']} → ${ev['to_depth']}${burstStr} density=${Number(ev['density'] ?? 0).toFixed(3)}`);
            }
          } else {
            const tool = ev['tool'];
            const agent = ev['agent'] ? ` [${ev['agent']}]` : '';
            if (ev['event'] === 'tool_call') console.log(`${ts}  ${String(tool).padEnd(30)} ${ev['ms']}ms${agent}`);
            else if (ev['event'] === 'tool_error') console.log(`${ts}  ERROR ${tool}${agent}`);
          }
        } catch { /* skip */ }
      }
    });
  }

  console.log(`Watching ${join(dir, OPENLORE_DIR, TELEMETRY_SUBDIR)} — Ctrl+C to stop\n`);

  const files = [leaseFile, mcpFile];
  // Initial tail
  Promise.all(files.map(tail));

  const watchDir = join(dir, OPENLORE_DIR, TELEMETRY_SUBDIR);
  if (existsSync(watchDir)) {
    watch(watchDir, { persistent: true }, async (_event, filename) => {
      if (!filename) return;
      const full = join(watchDir, filename);
      if (files.includes(full)) await tail(full);
    });
  }
}

// ============================================================================
// COMMAND
// ============================================================================

export const telemetryCommand = new Command('telemetry')
  .description('Analyze EpistemicLease cognitive telemetry')
  .argument('[directory]', 'Project directory', process.cwd())
  .option('--live', 'Stream cognitive events in real time')
  .addHelpText('after', `
Examples:
  $ openlore telemetry                    Summary stats for current directory
  $ openlore telemetry /path/to/repo      Summary for specific project
  $ openlore telemetry --live             Stream events live
`)
  .action(async function (directory: string, options: { live?: boolean }) {
    const dir = directory ?? process.cwd();
    const telDir = join(dir, OPENLORE_DIR, TELEMETRY_SUBDIR);

    if (options.live) {
      renderLive(dir);
      return; // keep process alive — watcher keeps running
    }

    const [mcp, orient, cache, lease, panicEvents] = await Promise.all([
      readJsonl<McpEvent>(join(telDir, 'mcp.jsonl')),
      readJsonl<OrientEvent>(join(telDir, 'orient.jsonl')),
      readJsonl<CacheEvent>(join(telDir, 'cache.jsonl')),
      readJsonl<LeaseEvent>(join(telDir, 'epistemic-lease.jsonl')),
      readJsonl<PanicEvent>(join(telDir, 'panic.jsonl')),
    ]);

    if (!mcp.length && !orient.length && !cache.length && !lease.length && !panicEvents.length) {
      console.log(`No telemetry found at ${telDir}`);
      console.log('Enable with: export OPENLORE_TELEMETRY=1');
      return;
    }

    renderSummary(mcp, orient, cache, lease, panicEvents);
  });
