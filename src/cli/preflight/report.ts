/**
 * Human-readable + JSON renderers for preflight results.
 */

import type { DiffResult } from './diff.js';
import type { ScoreResult } from './score.js';

export type PreflightStatus = 'FRESH' | 'STALE' | 'ERROR';

export interface PreflightSummary {
  status: PreflightStatus;
  graphBuiltAt: string | null;
  graphCommit: string | null;
  workingCommit: string | null;
  changedFiles: string[];
  unknownFiles: string[];
  hubCount: number;
  leafCount: number;
  stalenessScore: number;
  threshold: number;
  mechanism: 'git' | 'mtime';
  warnings: string[];
  message: string;
}

export interface BuildSummaryInput {
  diff: DiffResult;
  score: ScoreResult;
  graphBuiltAt: string | null;
  graphCommit: string | null;
  threshold: number;
}

export function buildSummary(input: BuildSummaryInput): PreflightSummary {
  const { diff, score, graphBuiltAt, graphCommit, threshold } = input;
  const totalChanged = diff.changed.length;
  const stale = score.totalScore > threshold;
  const status: PreflightStatus = stale ? 'STALE' : 'FRESH';

  let message: string;
  if (totalChanged === 0) {
    message = 'nothing to check — no changed files since graph build';
  } else if (stale) {
    message = `STALE — run \`openlore analyze\` or re-run with --fix`;
  } else {
    message = 'FRESH';
  }

  return {
    status,
    graphBuiltAt,
    graphCommit,
    workingCommit: diff.workingCommit,
    changedFiles: diff.changed,
    unknownFiles: score.unknownFiles,
    hubCount: score.hubCount,
    leafCount: score.leafCount,
    stalenessScore: score.totalScore,
    threshold,
    mechanism: diff.mechanism,
    warnings: diff.warnings,
    message,
  };
}

function pad(s: string, n: number): string {
  return s + ' '.repeat(Math.max(0, n - s.length));
}

export function renderHuman(s: PreflightSummary): string {
  const lines: string[] = [];
  lines.push('OpenLore preflight');
  lines.push('──────────────────');
  lines.push(
    `${pad('Graph built:', 15)}${s.graphBuiltAt ?? '(unknown)'}` +
      (s.graphCommit ? `   commit ${s.graphCommit}` : '')
  );
  lines.push(
    `${pad('Working tree:', 15)}${new Date().toISOString()}` +
      (s.workingCommit ? `   commit ${s.workingCommit}` : '')
  );
  if (s.changedFiles.length === 0) {
    lines.push(`${pad('Changed files:', 15)}0`);
  } else {
    lines.push(
      `${pad('Changed files:', 15)}${s.changedFiles.length} (${s.hubCount} hub, ${s.leafCount} leaf` +
        (s.unknownFiles.length ? `, ${s.unknownFiles.length} new/untracked` : '') +
        `)`
    );
  }
  lines.push(
    `${pad('Staleness:', 15)}score ${s.stalenessScore} (threshold ${s.threshold})`
  );
  lines.push(`${pad('Status:', 15)}${s.status === 'STALE' ? 'STALE — ' + s.message.replace('STALE — ', '') : s.status}`);
  if (s.warnings.length) {
    lines.push('');
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
  }
  if (s.changedFiles.length > 0 && s.changedFiles.length <= 20) {
    lines.push('');
    lines.push('Changed:');
    for (const f of s.changedFiles) lines.push(`  - ${f}`);
  } else if (s.changedFiles.length > 20) {
    lines.push('');
    lines.push(`Changed (showing first 20 of ${s.changedFiles.length}):`);
    for (const f of s.changedFiles.slice(0, 20)) lines.push(`  - ${f}`);
  }
  return lines.join('\n');
}

/**
 * Emit GitHub Actions workflow-command annotations so that stale files
 * appear inline in the PR diff UI when this runs in CI. No-op outside of
 * GHA. Format docs:
 *   https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 */
export function renderGithubAnnotations(s: PreflightSummary): string {
  if (s.status !== 'STALE') return '';
  if (process.env.GITHUB_ACTIONS !== 'true') return '';
  const lines: string[] = [];
  // Per-file warnings — point CI users at the exact files that pushed us
  // over the threshold. Only annotate files that contributed weight (i.e.
  // appeared in the graph); new/untracked files have weight 0.
  for (const f of s.changedFiles) {
    const inGraphContributor = !s.unknownFiles.includes(f);
    if (!inGraphContributor) continue;
    // Escape per GHA workflow-command escape rules.
    const msg = `OpenLore graph is stale for this file — run \`openlore analyze\` to refresh`;
    lines.push(`::warning file=${escapeAnnotation(f)}::${escapeAnnotation(msg)}`);
  }
  // Top-line error so the PR check fails visibly.
  lines.push(
    `::error::OpenLore preflight: staleness score ${s.stalenessScore} > threshold ${s.threshold} (${s.hubCount} hub, ${s.leafCount} leaf changes). Run \`openlore analyze\`.`
  );
  return lines.join('\n');
}

function escapeAnnotation(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function renderJson(s: PreflightSummary): string {
  // Exclude transient fields that don't belong in the documented schema.
  const payload = {
    status: s.status,
    graph_built_at: s.graphBuiltAt,
    graph_commit: s.graphCommit,
    working_commit: s.workingCommit,
    changed_files: s.changedFiles,
    unknown_files: s.unknownFiles,
    hub_count: s.hubCount,
    leaf_count: s.leafCount,
    staleness_score: s.stalenessScore,
    threshold: s.threshold,
    mechanism: s.mechanism,
    warnings: s.warnings,
  };
  return JSON.stringify(payload, null, 2);
}
