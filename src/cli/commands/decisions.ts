/**
 * openlore decisions command
 *
 * Agent-recorded architectural decision workflow:
 *   record (via MCP) → consolidate → verify → approve → sync → spec.md
 *
 * Can be installed as a pre-commit hook that gates commits until decisions
 * are reviewed.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { join } from 'node:path';

import { logger } from '../../utils/logger.js';
import { fileExists, resolveLLMProvider } from '../../utils/command-helpers.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { createLLMService } from '../../core/services/llm-service.js';
import { isGitRepository, getChangedFiles, getFileDiff, getCommitMessages, resolveBaseRef, buildSpecMap } from '../../core/drift/index.js';
import {
  loadDecisionStore,
  saveDecisionStore,
  replaceDecisions,
  patchDecision,
  getDecisionsByStatus,
  INACTIVE_STATUSES,
} from '../../core/decisions/store.js';
import { consolidateDrafts } from '../../core/decisions/consolidator.js';
import { extractFromDiff } from '../../core/decisions/extractor.js';
import { verifyDecisions } from '../../core/decisions/verifier.js';
import { syncApprovedDecisions } from '../../core/decisions/syncer.js';
import {
  OPENLORE_DIR,
  OPENLORE_LOGS_SUBDIR,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  DECISIONS_EXTRACTION_MAX_FILES,
  DECISIONS_DIFF_MAX_CHARS,
  CONSOLIDATION_GRACE_PERIOD_MS,
  GATE_REASONS,
} from '../../constants.js';
import type { PendingDecision } from '../../types/index.js';
import { runTuiApproval } from '../tui-approval.js';

// ============================================================================
// AGENT INSTRUCTION FILES
// ============================================================================

const AGENT_INSTRUCTIONS_MARKER = '<!-- openlore-decisions-instructions -->';

const AGENT_INSTRUCTIONS_BLOCK = `${AGENT_INSTRUCTIONS_MARKER}
## Architectural decisions

When making a significant design choice, call \`record_decision\` **before** writing the code.

Significant choices: data structure, library/dependency, API contract, auth strategy,
module boundary, database schema, caching approach, error handling pattern.

\`\`\`
record_decision({
  title: "Use JWTs for stateless auth",
  rationale: "Avoids session store in infra",
  consequences: "Tokens can't be revoked early",
  affectedFiles: ["src/auth/middleware.ts"],
  supersedes: "a1b2c3d4"  // 8-char ID of prior decision being reversed
})
\`\`\`

Decisions are consolidated in the background immediately after \`record_decision\` is called — the pre-commit gate reads the already-consolidated store and adds no LLM latency.

**Performance note**: if you skip \`record_decision\`, the gate detects unrecorded source changes at commit time and triggers a slow LLM extraction on the *next* commit (~10-30s). Calling \`record_decision\` proactively keeps every commit instant.

## When git commit is blocked by the decisions gate

If \`git commit\` fails and the output is JSON with \`"gated": true\`, do NOT retry silently.
Check the \`reason\` field and act accordingly:

**\`reason: "verified"\` — decisions await review:**
Present each decision to the user:
> "The commit is blocked — I found N architectural decision(s) to validate:
> 1. **[id]** Title — rationale
Do you approve? (yes/no)"
For each approval call \`approve_decision\`, for rejections call \`reject_decision\`.
Then run \`openlore decisions --sync\` and retry \`git commit\`.

**\`reason: "approved_not_synced"\` — decisions approved but not written to specs:**
Run \`openlore decisions --sync\` then retry \`git commit\`. Do not skip this step.

**\`reason: "drafts_pending_consolidation"\` — drafts were recorded but not yet consolidated:**
Present to the user:
> "N decision draft(s) were recorded but never consolidated. Run consolidation now? (~10-30s)"
If yes: run \`openlore decisions --consolidate --gate\` and handle the result.
If no: retry with \`git commit --no-verify\` to skip the gate.

**\`reason: "no_decisions_recorded"\` — source files staged but nothing recorded:**
Present to the user:
> "Source files are staged but no architectural decisions were recorded. Run fallback extraction to check for undocumented decisions? (~10-30s)"
If yes: run \`openlore decisions --consolidate --gate\` and handle the result.
If no: retry with \`git commit --no-verify\` to skip the gate.
<!-- end-openlore-decisions-instructions -->
`;

/** Inject decisions instructions into an existing agent file, idempotently. */
async function injectAgentInstructions(filePath: string): Promise<'injected' | 'already' | 'missing'> {
  if (!(await fileExists(filePath))) return 'missing';
  const content = await readFile(filePath, 'utf-8');
  if (content.includes(AGENT_INSTRUCTIONS_MARKER)) return 'already';
  await writeFile(filePath, content.trimEnd() + '\n\n' + AGENT_INSTRUCTIONS_BLOCK, 'utf-8');
  return 'injected';
}

/** Remove decisions instructions block from an agent file. */
async function removeAgentInstructions(filePath: string): Promise<void> {
  if (!(await fileExists(filePath))) return;
  const content = await readFile(filePath, 'utf-8');
  if (!content.includes(AGENT_INSTRUCTIONS_MARKER)) return;
  const cleaned = content
    .replace(/\n*<!-- openlore-decisions-instructions -->[\s\S]*?<!-- end-openlore-decisions-instructions -->\n*/g, '')
    .trim();
  await writeFile(filePath, cleaned + '\n', 'utf-8');
}

// ============================================================================
// HOOK MANAGEMENT
// ============================================================================

const HOOK_MARKER = '# openlore-decisions-hook';

const HOOK_CONTENT = `${HOOK_MARKER}
# Gate commits until architectural decisions are reviewed.
# Installed by: openlore setup --tools claude

# Prefer local build over global install.
if [ -f "./node_modules/.bin/openlore" ]; then
  ./node_modules/.bin/openlore decisions --gate 2>&1
  DECISIONS_EXIT=$?
elif [ -f "./dist/cli/index.js" ]; then
  node ./dist/cli/index.js decisions --gate 2>&1
  DECISIONS_EXIT=$?
else
  OPENLORE=$(command -v openlore 2>/dev/null)
  if [ -n "$OPENLORE" ] && "$OPENLORE" decisions --help 2>&1 | grep -q -- '--gate'; then
    "$OPENLORE" decisions --gate 2>&1
    DECISIONS_EXIT=$?
  else
    DECISIONS_EXIT=0
  fi
fi
if [ "$DECISIONS_EXIT" -ne 0 ]; then
  exit "$DECISIONS_EXIT"
fi
# Sentinel written on successful gate pass. Post-commit checks for its absence to detect --no-verify bypass.
touch "$(git rev-parse --git-dir 2>/dev/null || echo .git)/OPENLORE_GATE_RAN" 2>/dev/null || true
# end-openlore-decisions-hook
`;

const POST_COMMIT_HOOK_MARKER = '# openlore-decisions-post-hook';
const POST_COMMIT_HOOK_CONTENT = `${POST_COMMIT_HOOK_MARKER}
# Warn when the pre-commit gate was bypassed via --no-verify.
# post-commit is NOT skipped by --no-verify (only pre-commit and commit-msg are).
SENTINEL="$(git rev-parse --git-dir 2>/dev/null || echo .git)/OPENLORE_GATE_RAN"
if [ -f "$SENTINEL" ]; then
  rm -f "$SENTINEL"
else
  echo "" >&2
  echo "⚠️  openlore: pre-commit gate was bypassed (--no-verify)." >&2
  echo "    Architectural decisions were NOT reviewed for this commit." >&2
  echo "    Run: openlore decisions --consolidate --gate" >&2
  echo "" >&2
fi
# end-openlore-decisions-post-hook
`;

async function ensureGitignored(rootPath: string, entry: string): Promise<void> {
  const gitignorePath = join(rootPath, '.gitignore');
  let content = '';
  if (await fileExists(gitignorePath)) {
    content = await readFile(gitignorePath, 'utf-8');
    if (content.split('\n').some((l) => l.trim() === entry)) return;
  }
  await writeFile(gitignorePath, content.trimEnd() + '\n' + entry + '\n', 'utf-8');
  logger.discovery(`  → added ${entry} to .gitignore`);
}

export async function installPreCommitHook(rootPath: string): Promise<void> {
  const hooksDir = join(rootPath, '.git', 'hooks');
  const hookPath = join(hooksDir, 'pre-commit');

  if (!(await fileExists(join(rootPath, '.git')))) {
    logger.error('Not a git repository. Cannot install hook.');
    process.exitCode = 1;
    return;
  }

  await mkdir(hooksDir, { recursive: true });

  let existingContent = '';
  if (await fileExists(hookPath)) {
    existingContent = await readFile(hookPath, 'utf-8');
    if (existingContent.includes(HOOK_MARKER)) {
      // Still clean up legacy spec-gen block if present
      const cleaned = existingContent.replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '');
      if (cleaned !== existingContent) {
        await writeFile(hookPath, cleaned, 'utf-8');
        logger.discovery('Removed legacy spec-gen-decisions-hook block.');
      } else {
        logger.success('Pre-commit hook already installed.');
      }
      return;
    }
    logger.discovery('Existing pre-commit hook found. Appending decisions gate.');
    // Strip legacy spec-gen block and trailing `exit 0` so our block is not unreachable.
    const stripped = existingContent
      .replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '')
      .trimEnd()
      .replace(/\n*\nexit 0\s*$/, '');
    await writeFile(hookPath, stripped + '\n\n' + HOOK_CONTENT, 'utf-8');
  } else {
    await writeFile(hookPath, '#!/bin/sh\n\n' + HOOK_CONTENT, 'utf-8');
  }

  await chmod(hookPath, 0o755);
  logger.success('Pre-commit hook installed at .git/hooks/pre-commit');
  logger.discovery('Commits will be gated until decisions are approved. Use --no-verify to skip.');

  // Install post-commit hook to detect --no-verify bypass
  const postCommitPath = join(hooksDir, 'post-commit');
  let existingPostContent = '';
  if (await fileExists(postCommitPath)) {
    existingPostContent = await readFile(postCommitPath, 'utf-8');
    if (!existingPostContent.includes(POST_COMMIT_HOOK_MARKER)) {
      const strippedPost = existingPostContent.trimEnd().replace(/\n*\nexit 0\s*$/, '');
      await writeFile(postCommitPath, strippedPost + '\n\n' + POST_COMMIT_HOOK_CONTENT, 'utf-8');
    }
  } else {
    await writeFile(postCommitPath, '#!/bin/sh\n\n' + POST_COMMIT_HOOK_CONTENT, 'utf-8');
  }
  await chmod(postCommitPath, 0o755);
  logger.success('Post-commit hook installed at .git/hooks/post-commit (bypass detector)');

  // Ensure pending decisions store is not accidentally committed
  await ensureGitignored(rootPath, '.openlore/decisions/');

  // Inject record_decision instructions into existing agent context files
  const agentFiles = [
    { path: join(rootPath, 'CLAUDE.md'), label: 'CLAUDE.md' },
    { path: join(rootPath, 'AGENTS.md'), label: 'AGENTS.md' },
    { path: join(rootPath, '.cursorrules'), label: '.cursorrules' },
    { path: join(rootPath, '.clinerules', 'openlore.md'), label: '.clinerules/openlore.md' },
    { path: join(rootPath, '.github', 'copilot-instructions.md'), label: '.github/copilot-instructions.md' },
    { path: join(rootPath, '.windsurf', 'rules.md'), label: '.windsurf/rules.md' },
    { path: join(rootPath, '.vibe', 'skills', 'openlore.md'), label: '.vibe/skills/openlore.md' },
  ];

  for (const { path: filePath, label } of agentFiles) {
    const result = await injectAgentInstructions(filePath);
    if (result === 'injected') logger.discovery(`  → record_decision instructions added to ${label}`);
  }
}

export async function uninstallPreCommitHook(rootPath: string): Promise<void> {
  const hookPath = join(rootPath, '.git', 'hooks', 'pre-commit');

  if (!(await fileExists(hookPath))) {
    logger.warning('No pre-commit hook found.');
    return;
  }

  const content = await readFile(hookPath, 'utf-8');
  if (!content.includes(HOOK_MARKER)) {
    logger.warning('Pre-commit hook does not contain openlore decisions gate.');
    return;
  }

  const newContent = content
    .replace(/\n*# openlore-decisions-hook[\s\S]*?# end-openlore-decisions-hook\n*/g, '')
    .replace(/\n*# spec-gen-decisions-hook[\s\S]*?# end-spec-gen-decisions-hook\n*/g, '')
    .trim();

  if (!newContent || newContent === '#!/bin/sh') {
    const { unlink } = await import('node:fs/promises');
    await unlink(hookPath);
    logger.success('Pre-commit hook removed (file deleted — was only openlore).');
  } else {
    await writeFile(hookPath, newContent + '\n', 'utf-8');
    logger.success('OpenLore decisions gate removed from pre-commit hook.');
  }

  // Remove post-commit bypass detector
  const postCommitPath = join(rootPath, '.git', 'hooks', 'post-commit');
  if (await fileExists(postCommitPath)) {
    const postContent = await readFile(postCommitPath, 'utf-8');
    if (postContent.includes(POST_COMMIT_HOOK_MARKER)) {
      const newPostContent = postContent
        .replace(/\n*# openlore-decisions-post-hook[\s\S]*?# end-openlore-decisions-post-hook\n*/g, '')
        .trim();
      if (!newPostContent || newPostContent === '#!/bin/sh') {
        const { unlink } = await import('node:fs/promises');
        await unlink(postCommitPath);
        logger.success('Post-commit hook removed.');
      } else {
        await writeFile(postCommitPath, newPostContent + '\n', 'utf-8');
        logger.success('OpenLore bypass detector removed from post-commit hook.');
      }
    }
  }

  // Remove record_decision instructions from agent context files
  const agentFiles = [
    join(rootPath, 'CLAUDE.md'),
    join(rootPath, 'AGENTS.md'),
    join(rootPath, '.cursorrules'),
    join(rootPath, '.clinerules', 'openlore.md'),
    join(rootPath, '.github', 'copilot-instructions.md'),
    join(rootPath, '.windsurf', 'rules.md'),
    join(rootPath, '.vibe', 'skills', 'openlore.md'),
  ];
  for (const filePath of agentFiles) await removeAgentInstructions(filePath);
}

const ANALYZE_HOOK_MARKER = 'openlore analyze';
const ANALYZE_HOOK_ENTRY = {
  _comment: 'openlore: keep call graph fresh after every file edit (debounced 10s)',
  type: 'command',
  command: [
    'LOCK=.openlore/.analyze.lock;',
    'if [ ! -f "$LOCK" ] || [ $(( $(date +%s) - $(cat "$LOCK" 2>/dev/null || echo 0) )) -gt 10 ]; then',
    '  echo $(date +%s) > "$LOCK";',
    '  openlore analyze --output .openlore/analysis 2>/dev/null & true;',
    'fi',
  ].join(' '),
};

export async function installClaudeHook(rootPath: string): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  let settings: ClaudeSettings = {};

  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as ClaudeSettings;
  } catch { /* file missing or corrupt — start fresh */ }

  const hooks = settings.hooks?.PostToolUse ?? [];
  if (hooks.some((h) => JSON.stringify(h).includes(ANALYZE_HOOK_MARKER))) {
    logger.success('Claude Code analyze hook already present in .claude/settings.json');
    return;
  }

  settings.hooks ??= {};
  settings.hooks.PostToolUse = [...hooks, ANALYZE_HOOK_ENTRY];

  await mkdir(join(rootPath, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  logger.success('Claude Code PostToolUse hook added to .claude/settings.json');
}

interface ClaudeSettings {
  hooks?: {
    PostToolUse?: Array<{ _comment?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function uninstallClaudeHook(rootPath: string): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  if (!(await fileExists(settingsPath))) return;

  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as ClaudeSettings;
    const hooks = settings.hooks?.PostToolUse ?? [];
    const filtered = hooks.filter((h) => !JSON.stringify(h).includes('openlore-mine-last') && !JSON.stringify(h).includes(ANALYZE_HOOK_MARKER));
    if (filtered.length === hooks.length) return;
    if (filtered.length === 0) delete settings.hooks!.PostToolUse;
    else settings.hooks!.PostToolUse = filtered;
    await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    logger.success('Claude Code PostToolUse hook removed from .claude/settings.json');
  } catch { /* settings corrupt — skip */ }
}

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

function displayDecision(d: PendingDecision, verbose = false): void {
  const icon =
    d.status === 'verified' ? '✓' :
    d.status === 'phantom'  ? '↗' :
    d.status === 'approved' ? '●' :
    d.status === 'synced'   ? '✔' :
    d.status === 'rejected' ? '✗' : '○';

  const confidence =
    d.confidence === 'high'   ? '\x1b[32mhigh\x1b[0m' :
    d.confidence === 'medium' ? '\x1b[33mmedium\x1b[0m' :
                                '\x1b[31mlow\x1b[0m';

  const scopeLabel = d.scope ?? 'component';
  const scopeBadge =
    scopeLabel === 'system'       ? `\x1b[31m[${scopeLabel}]\x1b[0m` :
    scopeLabel === 'cross-domain' ? `\x1b[33m[${scopeLabel}]\x1b[0m` :
    scopeLabel === 'component'    ? `\x1b[34m[${scopeLabel}]\x1b[0m` :
                                    `\x1b[90m[${scopeLabel}]\x1b[0m`;

  console.log(`${icon} [${d.id}] ${scopeBadge} ${d.title}`);
  if (verbose) {
    console.log(`   Status     : ${d.status}  Confidence: ${confidence}  Scope: ${scopeLabel}`);
    console.log(`   Rationale  : ${d.rationale}`);
    if (d.affectedDomains.length) console.log(`   Domains    : ${d.affectedDomains.join(', ')}`);
    if (d.proposedRequirement) console.log(`   Requirement: ${d.proposedRequirement}`);
    if (d.evidenceFile) console.log(`   Evidence   : ${d.evidenceFile}`);
  }
}

function displayMissing(missing: Array<{ file: string; description: string }>): void {
  if (missing.length === 0) return;
  logger.section('Unrecorded Changes Detected');
  for (const m of missing) {
    logger.warning(`⚠ ${m.file}: ${m.description}`);
  }
  console.log('These changes were not recorded as decisions. Consider adding them with record_decision.');
}

// ============================================================================
// COMMAND
// ============================================================================

export const decisionsCommand = new Command('decisions')
  .description('Record, consolidate, and sync architectural decisions to OpenSpec')
  .option('--consolidate', 'Consolidate drafts + verify against diff', false)
  .option('--gate', 'Exit non-zero if decisions await review (for use in hooks)', false)
  .option('--approve <id>', 'Approve a decision by ID')
  .option('--reject <id>', 'Reject a decision by ID')
  .option('--note <text>', 'Note to attach to approve/reject action')
  .option('--reason <text>', 'Alias for --note')
  .option('--sync', 'Sync all approved decisions to spec.md files', false)
  .option('--dry-run', 'Preview sync without writing', false)
  .option('--list', 'List decisions (default action when no other flag given)', false)
  .option('--status <status>', 'Filter list by status (draft|consolidated|verified|approved|rejected|synced)')
  .option('--uninstall-hook', 'Remove pre-commit hook', false)
  .option('--verbose', 'Show detailed decision info', false)
  .option('--json', 'Output as JSON', false)
  .addHelpText(
    'after',
    `
Workflow:
  1. Install once: openlore setup --tools claude  (hooks + skills)
  2. During dev: agent calls record_decision MCP tool
  3. At commit: openlore decisions --consolidate  (or via hook)
  4. Review: openlore decisions --approve <id>
  5. Write to spec: openlore decisions --sync

Examples:
  $ openlore decisions                             List pending decisions
  $ openlore decisions --consolidate               Consolidate + verify drafts
  $ openlore decisions --approve a1b2c3d4          Approve decision a1b2c3d4
  $ openlore decisions --sync                      Sync approved decisions
  $ openlore decisions --status verified --json    Machine-readable output
`
  )
  .action(async function (this: Command, options: {
    consolidate: boolean;
    gate: boolean;
    approve?: string;
    reject?: string;
    note?: string;
    reason?: string;
    sync: boolean;
    dryRun: boolean;
    list: boolean;
    status?: string;
    uninstallHook: boolean;
    verbose: boolean;
    json: boolean;
  }) {
    const globalOpts = this.parent?.opts() ?? {};
    const rootPath = process.cwd();

    // ── Hook management ──────────────────────────────────────────────────────
    if (options.uninstallHook) {
      await uninstallPreCommitHook(rootPath);
      await uninstallClaudeHook(rootPath); // cleans up any previously installed PostToolUse hook
      return;
    }
    // ── Load store (always needed) ───────────────────────────────────────────
    const store = await loadDecisionStore(rootPath);

    // ── Approve ──────────────────────────────────────────────────────────────
    if (options.approve) {
      const id = options.approve;
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) {
        logger.error(`Decision ${id} not found.`);
        process.exitCode = 1;
        return;
      }
      if (decision.status === 'synced') {
        logger.error(`Decision ${id} is already synced to spec files — re-approval not allowed.`);
        process.exitCode = 1;
        return;
      }
      const updated = patchDecision(store, id, {
        status: 'approved',
        reviewedAt: new Date().toISOString(),
        reviewNote: options.note ?? options.reason,
      });
      await saveDecisionStore(rootPath, updated);
      logger.success(`Decision ${id} approved.`);
      if (!options.json) displayDecision({ ...decision, status: 'approved' }, true);

      // Show a dry-run preview of what would land in the spec
      if (!options.json) {
        const openloreConfig = await readOpenLoreConfig(rootPath);
        if (openloreConfig) {
          const openspecPath = join(rootPath, openloreConfig.openspecPath ?? OPENSPEC_DIR);
          const specsExist = await fileExists(join(openspecPath, OPENSPEC_SPECS_SUBDIR));
          if (specsExist) {
            const specMap = await buildSpecMap({ rootPath, openspecPath }).catch(() => undefined);
            if (specMap) {
              const { result } = await syncApprovedDecisions(updated, {
                rootPath, openspecPath, specMap, dryRun: true,
              });
              if (result.modifiedSpecs.length > 0) {
                console.log(`\nWould write to: ${result.modifiedSpecs.join(', ')}`);
                console.log('Run "openlore decisions --sync" to apply.');
              }
            }
          }
        }
      }
      return;
    }

    // ── Reject ───────────────────────────────────────────────────────────────
    if (options.reject) {
      const id = options.reject;
      const decision = store.decisions.find((d) => d.id === id);
      if (!decision) {
        logger.error(`Decision ${id} not found.`);
        process.exitCode = 1;
        return;
      }
      const updated = patchDecision(store, id, {
        status: 'rejected',
        reviewedAt: new Date().toISOString(),
        reviewNote: options.note ?? options.reason,
      });
      await saveDecisionStore(rootPath, updated);
      logger.success(`Decision ${id} rejected.`);

      if (!options.json && decision.affectedFiles.length > 0) {
        console.log('\nIf this change should not be committed, revert it manually:');
        for (const f of decision.affectedFiles) {
          console.log(`  git restore ${f}`);
        }
        console.log('\nOr to document why this approach was rejected:');
        console.log('  openlore decisions --record');
        console.log('  (then re-run --consolidate before committing)');
      }
      return;
    }

    // ── Consolidate + Verify ─────────────────────────────────────────────────
    if (options.consolidate) {
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found. Run "openlore init" first.');
        process.exitCode = 1;
        return;
      }

      const drafts = getDecisionsByStatus(store, 'draft');
      const hasDrafts = drafts.length > 0;

      const resolved = resolveLLMProvider(openloreConfig);
      if (!resolved) {
        logger.error('No LLM provider configured. Consolidation requires an LLM.');
        logger.discovery('Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or configure llm in .openlore/config.json');
        process.exitCode = 1;
        return;
      }

      const llm = createLLMService({
        provider: resolved.provider,
        model: openloreConfig.generation?.model,
        openaiCompatBaseUrl: resolved.openaiCompatBaseUrl,
        apiBase: globalOpts.apiBase ?? openloreConfig.llm?.apiBase,
        sslVerify: globalOpts.insecure != null ? !globalOpts.insecure : (openloreConfig.llm?.sslVerify ?? true),
        enableLogging: true,
        logDir: join(rootPath, OPENLORE_DIR, OPENLORE_LOGS_SUBDIR),
      });

      // Step 1 — Consolidate drafts OR extract from diff as fallback
      const openspecPath = join(rootPath, openloreConfig.openspecPath ?? OPENSPEC_DIR);
      const specMapResult = await buildSpecMap({ rootPath, openspecPath }).catch(() => undefined);
      let consolidated: PendingDecision[];
      let supersededIds: string[] = [];
      if (hasDrafts) {
        if (!options.json) logger.discovery(`Consolidating ${drafts.length} draft decision(s) via ${resolved.provider}...`);
        const result = await consolidateDrafts(store, llm, specMapResult);
        consolidated = result.decisions;
        supersededIds = result.supersededIds;
      } else {
        if (!options.json) logger.discovery(`No drafts found — extracting decisions from diff via ${resolved.provider}...`);
        const specMap = specMapResult ?? await buildSpecMap({ rootPath, openspecPath });
        // Use staged-only scope so the fallback only sees what's actually being committed.
        consolidated = await extractFromDiff({ rootPath, stagedOnly: true, specMap, sessionId: store.sessionId, llm });
      }
      if (consolidated.length === 0) {
        if (!options.json) console.log('No architectural decisions found in drafts.');
        if (options.gate) process.exitCode = 0;
        return;
      }

      // Step 2 — Build diff + commit messages for verification
      let combinedDiff = '';
      let commitMessages = '';
      try {
        if (await isGitRepository(rootPath)) {
          const baseRef = await resolveBaseRef(rootPath, 'auto');
          const gitResult = await getChangedFiles({ rootPath, baseRef, includeUnstaged: false });
          const relevant = gitResult.files.slice(0, DECISIONS_EXTRACTION_MAX_FILES);
          const diffs = await Promise.all(
            relevant.map((f) => getFileDiff(rootPath, f.path, baseRef, DECISIONS_DIFF_MAX_CHARS))
          );
          combinedDiff = diffs.join('\n\n');
          commitMessages = await getCommitMessages(rootPath, baseRef).catch(() => '');
        }
      } catch (err) {
        logger.warning(`Could not build git diff for verification: ${(err as Error).message}`);
      }

      // Step 3 — Verify
      const { verified, phantom, missing } = combinedDiff
        ? await verifyDecisions(consolidated, combinedDiff, llm, commitMessages)
        : { verified: consolidated.map((d) => ({ ...d, status: 'verified' as const, confidence: 'medium' as const })), phantom: [], missing: [] };

      // Step 4 — Persist
      let updatedStore = { ...store };
      // Reject all original drafts — they've been replaced by consolidated decisions.
      // Also reject any explicitly superseded IDs from prior sessions.
      const originalDraftIds = new Set(drafts.map((d) => d.id));
      const originalById = new Map(store.decisions.map((d) => [d.id, d]));
      for (const id of [...originalDraftIds, ...supersededIds]) {
        updatedStore = patchDecision(updatedStore, id, { status: 'rejected' });
      }
      // Preserve recordedAt provenance:
      // - Direct match: consolidated decision ID matches original draft → use its recordedAt.
      // - Merged decision (new ID, no match): use earliest recordedAt across all superseded
      //   drafts so the audit trail reflects when the underlying work was first captured.
      const earliestSupersededAt = supersededIds
        .map((id) => originalById.get(id)?.recordedAt)
        .filter((t): t is string => t !== undefined)
        .sort()[0];
      const withProvenance = [...verified, ...phantom].map((d) => {
        const original = originalById.get(d.id);
        if (original) return { ...d, recordedAt: original.recordedAt };
        // Merged decision — anchor to earliest superseded draft's recordedAt
        if (earliestSupersededAt) return { ...d, recordedAt: earliestSupersededAt };
        return d;
      });
      // replaceDecisions (not upsertDecisions) — consolidated decisions share IDs
      // with their original drafts; upsert would silently no-op after the reject above.
      updatedStore = replaceDecisions(updatedStore, withProvenance);
      updatedStore = { ...updatedStore, lastConsolidatedAt: new Date().toISOString() };
      await saveDecisionStore(rootPath, updatedStore);

      if (options.json) {
        process.stdout.write(JSON.stringify({ verified, phantom, missing }, null, 2) + '\n');
        if (options.gate && missing.length > 0) process.exitCode = 1;
        return;
      }

      // Interactive TUI approval when running in a terminal
      if (options.gate && process.stdin.isTTY && process.stdout.isTTY && verified.length > 0) {
        const results = await runTuiApproval(verified);

        let gateStore = updatedStore;
        for (const [id, decision] of results) {
          if (decision === 'approved' || decision === 'rejected') {
            gateStore = patchDecision(gateStore, id, {
              status: decision,
              reviewedAt: new Date().toISOString(),
            });
          }
        }
        await saveDecisionStore(rootPath, gateStore);

        const stillPending = verified.filter(
          (d) => !results.has(d.id) || results.get(d.id) === 'skipped',
        );
        const approved = verified.filter((d) => results.get(d.id) === 'approved');
        const rejected = verified.filter((d) => results.get(d.id) === 'rejected');

        if (approved.length > 0) {
          console.log(`\n${approved.length} decision(s) approved. Run "openlore decisions --sync" to write to spec.md.`);
        }
        if (rejected.length > 0) {
          console.log(`${rejected.length} decision(s) rejected.`);
        }
        if (stillPending.length > 0) {
          logger.warning(`${stillPending.length} decision(s) still pending — commit blocked.`);
          process.exitCode = 1;
        }

        displayMissing(missing);
        if (missing.length > 0) process.exitCode = 1;
        return;
      }

      // Non-TTY (agent/IDE context): structured JSON for ACP consumption
      if (options.gate && !process.stdout.isTTY) {
        const payload = {
          gated: verified.length > 0 || missing.length > 0,
          verified: verified.map((d) => ({
            id: d.id,
            title: d.title,
            rationale: d.rationale,
            consequences: d.consequences,
            proposedRequirement: d.proposedRequirement,
            affectedDomains: d.affectedDomains,
            affectedFiles: d.affectedFiles,
            confidence: d.confidence,
          })),
          phantom: phantom.map((d) => ({ id: d.id, title: d.title })),
          missing: missing.map((m) => ({ file: m.file, description: m.description })),
          actions: {
            approve: 'openlore decisions --approve <id>',
            reject: 'openlore decisions --reject <id>',
            sync: 'openlore decisions --sync',
          },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        if (payload.gated) process.exitCode = 1;
        return;
      }

      // Plain text recap (non-gate or explicit --list context)
      logger.section('Architectural Decisions — Review Required');

      if (verified.length > 0) {
        console.log('\nVerified decisions (found in code):');
        for (const d of verified) displayDecision(d, options.verbose);
      }

      if (phantom.length > 0) {
        console.log('\nPhantom decisions (recorded but not found in diff — may have been rolled back):');
        for (const d of phantom) displayDecision(d, options.verbose);
      }

      displayMissing(missing);

      console.log('\nApprove with: openlore decisions --approve <id>');
      console.log('Reject with:  openlore decisions --reject <id>');
      console.log('Sync all approved: openlore decisions --sync');

      if (options.gate && missing.length > 0) {
        logger.warning(`\nCommit gated — ${missing.length} undocumented change(s) require a decision. Record with: openlore decisions --record or record_decision MCP tool.`);
        process.exitCode = 1;
      } else if (options.gate && verified.length > 0) {
        logger.warning('\nDecisions verified — approve them before syncing: openlore decisions --approve <id>');
        process.exitCode = 1;
      }
      return;
    }

    // ── Gate only (no consolidation — consolidation happens on record_decision) ──
    if (options.gate && !options.consolidate) {
      // Block if approved decisions haven't been synced to spec files yet.
      const approved = getDecisionsByStatus(store, 'approved');
      if (approved.length > 0) {
        const payload = {
          gated: true,
          reason: GATE_REASONS.APPROVED_NOT_SYNCED,
          message: `${approved.length} approved decision(s) must be synced to spec files before committing.`,
          approved: approved.map((d) => ({ id: d.id, title: d.title })),
          actions: { sync: 'openlore decisions --sync' },
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        process.exitCode = 1;
        return;
      }

      const verified = getDecisionsByStatus(store, 'verified');
      const missing: Array<{ file: string; description: string }> = [];

      if (verified.length === 0) {
        const drafts = getDecisionsByStatus(store, 'draft');
        if (drafts.length > 0) {
          // Drafts recorded but consolidation never completed.
          // Output structured JSON so the agent can relay to the user and act on the answer.
          const payload = {
            gated: true,
            reason: GATE_REASONS.DRAFTS_PENDING_CONSOLIDATION,
            message: `${drafts.length} draft decision(s) were recorded but never consolidated.`,
            drafts: drafts.map((d) => ({ id: d.id, title: d.title, recordedAt: d.recordedAt })),
            actions: {
              consolidate: 'openlore decisions --consolidate',
              consolidateAndGate: 'openlore decisions --consolidate --gate',
              skip: 'git commit --no-verify',
            },
          };
          process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
          process.exitCode = 1;
          return;
        }

        // If consolidation already ran recently, trust it found nothing — skip the warning.
        const consolidatedRecently = store.lastConsolidatedAt
          && (Date.now() - new Date(store.lastConsolidatedAt).getTime()) < CONSOLIDATION_GRACE_PERIOD_MS;
        if (consolidatedRecently) {
          process.exitCode = 0;
          return;
        }

        // If source files are staged but nothing was recorded, offer to run the fallback extractor.
        // Phantom decisions ("recorded but no code evidence") are excluded — stale phantoms from
        // previous sessions would otherwise silently bypass the gate for all future commits.
        const activeDecisions = store.decisions.filter(
          (d) => !INACTIVE_STATUSES.has(d.status),
        );
        if (activeDecisions.length === 0 && await isGitRepository(rootPath)) {
          try {
            const { stdout } = await execFileAsync(
              'git', ['diff', '--cached', '--name-only', '--diff-filter=ACDMR'],
              { cwd: rootPath },
            );
            const stagedFiles = stdout.trim().split('\n').filter(Boolean);
            const SOURCE_EXTS = /\.(ts|js|tsx|jsx|py|go|rs|rb|java|cpp|cc|swift)$/;
            const hasSourceChanges = stagedFiles.some((f) => SOURCE_EXTS.test(f));
            if (hasSourceChanges) {
              // Source files staged but nothing recorded — output JSON for agent to relay.
              const payload = {
                gated: true,
                reason: GATE_REASONS.NO_DECISIONS_RECORDED,
                message: 'Source files are staged but no architectural decisions were recorded.',
                actions: {
                  consolidateAndGate: 'openlore decisions --consolidate --gate',
                  skip: 'git commit --no-verify',
                },
              };
              process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
              process.exitCode = 1;
              return;
            }
          } catch { /* git unavailable — skip */ }
        }
        process.exitCode = 0;
        return;
      }

      // TTY: interactive TUI
      if (process.stdin.isTTY && process.stdout.isTTY && verified.length > 0) {
        const results = await runTuiApproval(verified);
        let gateStore = store;
        for (const [id, decision] of results) {
          if (decision === 'approved' || decision === 'rejected') {
            gateStore = patchDecision(gateStore, id, {
              status: decision,
              reviewedAt: new Date().toISOString(),
            });
          }
        }
        await saveDecisionStore(rootPath, gateStore);
        const stillPending = verified.filter(
          (d) => !results.has(d.id) || results.get(d.id) === 'skipped',
        );
        if (stillPending.length > 0) process.exitCode = 1;
        return;
      }

      // Non-TTY: JSON for ACP/agent consumption
      const payload = {
        gated: true,
        reason: GATE_REASONS.VERIFIED,
        verified: verified.map((d) => ({
          id: d.id,
          title: d.title,
          rationale: d.rationale,
          consequences: d.consequences,
          proposedRequirement: d.proposedRequirement,
          affectedDomains: d.affectedDomains,
          affectedFiles: d.affectedFiles,
          confidence: d.confidence,
        })),
        phantom: [],
        missing,
        actions: {
          approve: 'openlore decisions --approve <id>',
          reject: 'openlore decisions --reject <id>',
          sync: 'openlore decisions --sync',
        },
      };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }

    // ── Sync ─────────────────────────────────────────────────────────────────
    if (options.sync) {
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found.');
        process.exitCode = 1;
        return;
      }

      const openspecPath = join(rootPath, openloreConfig.openspecPath ?? OPENSPEC_DIR);
      const specsPath = join(openspecPath, OPENSPEC_SPECS_SUBDIR);
      if (!(await fileExists(specsPath))) {
        logger.error('No specs found. Run "openlore generate" first.');
        process.exitCode = 1;
        return;
      }

      const specMap = await buildSpecMap({ rootPath, openspecPath });
      const approved = getDecisionsByStatus(store, 'approved');

      if (approved.length === 0 && !options.json) {
        console.log('No approved decisions to sync. Use --approve <id> first.');
      }

      if (approved.length > 0 && !options.json) {
        logger.discovery(`Syncing ${approved.length} approved decision(s)...`);
      }

      // Always call syncApprovedDecisions so purgeInactiveDecisions runs on the store
      // even when there are no approved decisions to sync.
      const { result } = await syncApprovedDecisions(store, {
        rootPath,
        openspecPath,
        specMap,
        dryRun: options.dryRun,
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      for (const d of result.synced) {
        logger.success(`✔ Synced [${d.id}] ${d.title}`);
        for (const p of d.syncedToSpecs) console.log(`   → ${p}`);
      }
      for (const e of result.errors) {
        logger.error(`✗ [${e.id}] ${e.error}`);
      }
      if (options.dryRun) console.log('\n(dry-run — no files were written)');
      return;
    }

    // ── Default: list ────────────────────────────────────────────────────────
    const VALID_STATUSES = new Set(['draft', 'consolidated', 'verified', 'phantom', 'approved', 'rejected', 'synced']);
    if (options.status && !VALID_STATUSES.has(options.status)) {
      logger.error(`Invalid status "${options.status}". Valid values: ${[...VALID_STATUSES].join('|')}`);
      process.exitCode = 1;
      return;
    }
    const all = options.status
      ? store.decisions.filter((d) => d.status === options.status)
      : store.decisions;

    if (options.json) {
      process.stdout.write(JSON.stringify(all, null, 2) + '\n');
      return;
    }

    if (all.length === 0) {
      console.log('No decisions recorded yet. Agents can call the record_decision MCP tool during development.');
      return;
    }

    logger.section('Architectural Decisions');
    for (const d of all) displayDecision(d, options.verbose);
    console.log(`\nTotal: ${all.length}`);
  });
