/**
 * openlore setup command
 *
 * Installs workflow skills and agent integration files into the current project.
 * Unlike `analyze --ai-configs` (which generates project-specific context files),
 * `setup` copies static workflow assets that are the same for every project:
 *
 *   - Mistral Vibe skills  -> .vibe/skills/openlore-{name}/SKILL.md      (8 skills)
 *   - Cline workflows      -> .clinerules/workflows/openlore-{name}.md
 *   - Claude Code skills   -> .claude/skills/openlore-{name}/SKILL.md    (8 skills)
 *   - OpenCode skills      -> .opencode/skills/openlore-{name}/SKILL.md  (8 skills)
 *   - GSD commands         -> .claude/commands/gsd/openlore-{name}.md
 *
 * Files are never overwritten — existing files are skipped silently.
 * Assets are read from the `examples/` directory shipped with the openlore package.
 */

import { Command } from 'commander';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkbox } from '@inquirer/prompts';
import { logger } from '../../utils/logger.js';
import { installPreCommitHook, installClaudeHook } from './decisions.js';
import { readOpenLoreConfig, writeOpenLoreConfig } from '../../core/services/config-manager.js';
import type { PanicResponseMode } from '../../types/index.js';

// ============================================================================
// PANIC CHECK HOOK
// Installs openlore panic-check as a PreToolUse hook in .claude/settings.json.
// ============================================================================

const PANIC_CHECK_HOOK_MARKER = 'openlore panic-check';

interface ClaudeHookSettings {
  hooks?: {
    PreToolUse?: Array<{ _comment?: string; [key: string]: unknown }>;
    PostToolUse?: Array<{ _comment?: string; [key: string]: unknown }>;
    UserPromptSubmit?: Array<{ _comment?: string; [key: string]: unknown }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function installPanicCheckHook(rootPath: string, format: string = 'claude'): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  let settings: ClaudeHookSettings = {};

  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as ClaudeHookSettings;
  } catch { /* file missing or corrupt — start fresh */ }

  const hooks = settings.hooks?.PreToolUse ?? [];
  if (hooks.some((h) => JSON.stringify(h).includes(PANIC_CHECK_HOOK_MARKER))) {
    logger.success('panic-check PreToolUse hook already present in .claude/settings.json');
    return;
  }

  const hookEntry = {
    _comment: 'openlore: behavioral destabilization guard — fires before every tool call',
    type: 'command',
    command: `openlore panic-check --directory "$(pwd)" --format ${format}`,
  };

  settings.hooks ??= {};
  settings.hooks.PreToolUse = [...hooks, hookEntry];

  await mkdir(join(rootPath, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  logger.success(`panic-check PreToolUse hook added to .claude/settings.json (format: ${format})`);
}

// ============================================================================
// GRYPH WATCH HOOK
// Installs openlore gryph-watch as a UserPromptSubmit hook — starts the
// background Gryph observer once per session, decoupled from MCP tool calls.
// ============================================================================

const GRYPH_WATCH_HOOK_MARKER = 'openlore gryph-watch';

export async function installGryphWatchHook(rootPath: string): Promise<void> {
  const settingsPath = join(rootPath, '.claude', 'settings.json');
  let settings: ClaudeHookSettings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf-8')) as ClaudeHookSettings;
  } catch { /* start fresh */ }

  const hooks = settings.hooks?.UserPromptSubmit ?? [];
  if (hooks.some((h) => JSON.stringify(h).includes(GRYPH_WATCH_HOOK_MARKER))) {
    logger.success('gryph-watch UserPromptSubmit hook already present in .claude/settings.json');
    return;
  }

  const hookEntry = {
    _comment: 'openlore: start Gryph behavioral observer (singleton, background)',
    type: 'command',
    command: 'openlore gryph-watch &',
  };
  settings.hooks ??= {};
  settings.hooks.UserPromptSubmit = [...hooks, hookEntry];

  await mkdir(join(rootPath, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  logger.success('gryph-watch UserPromptSubmit hook added to .claude/settings.json');
}

// ============================================================================
// TYPES
// ============================================================================

type ToolName = 'vibe' | 'cline' | 'gsd' | 'bmad' | 'claude' | 'opencode' | 'omoa';

interface SkillEntry {
  /** Absolute source path inside the package's examples/ directory */
  src: string;
  /** Relative destination path from the project root */
  dest: string;
}

interface SetupResult {
  tool: ToolName;
  rel: string;
  status: 'created' | 'updated' | 'skipped';
}

// ============================================================================
// HELPERS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the openlore package (dist/cli/commands -> ../../.. -> package root) */
const PACKAGE_ROOT = join(__dirname, '../../..');

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether oh-my-openagent is installed in the project or user config.
 * Checks both the legacy oh-my-opencode and the renamed oh-my-openagent basenames.
 */
async function detectOmoa(projectRoot: string): Promise<boolean> {
  const home = homedir();
  const candidates = [
    // Project-level config
    join(projectRoot, '.opencode', 'oh-my-openagent.jsonc'),
    join(projectRoot, '.opencode', 'oh-my-openagent.json'),
    join(projectRoot, '.opencode', 'oh-my-opencode.jsonc'),
    join(projectRoot, '.opencode', 'oh-my-opencode.json'),
    // User-level config
    join(home, '.config', 'opencode', 'oh-my-openagent.jsonc'),
    join(home, '.config', 'opencode', 'oh-my-openagent.json'),
    join(home, '.config', 'opencode', 'oh-my-opencode.jsonc'),
    join(home, '.config', 'opencode', 'oh-my-opencode.json'),
  ];
  for (const p of candidates) {
    if (await fileExists(p)) return true;
  }

  // Also check if opencode.json plugin list references oh-my-openagent / oh-my-opencode
  for (const opencodeJson of [
    join(home, '.config', 'opencode', 'opencode.json'),
    join(projectRoot, '.opencode', 'opencode.json'),
    join(projectRoot, 'opencode.json'),
  ]) {
    try {
      const raw = await readFile(opencodeJson, 'utf-8');
      if (raw.includes('oh-my-openagent') || raw.includes('oh-my-opencode')) return true;
    } catch {
      /* file not found */
    }
  }

  return false;
}

async function copyFile(
  src: string,
  dest: string,
  force: boolean
): Promise<'created' | 'updated' | 'skipped'> {
  const exists = await fileExists(dest);
  if (exists && !force) return 'skipped';
  const content = await readFile(src, 'utf-8');
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content, 'utf-8');
  return exists ? 'updated' : 'created';
}

// ============================================================================
// SKILL MANIFESTS
// ============================================================================

function buildManifest(projectRoot: string): Record<ToolName, SkillEntry[]> {
  const ex = join(PACKAGE_ROOT, 'examples');

  const VIBE_SKILLS = [
    'openlore-analyze-codebase',
    'openlore-brainstorm',
    'openlore-debug',
    'openlore-execute-refactor',
    'openlore-generate',
    'openlore-implement-story',
    'openlore-plan-refactor',
    'openlore-write-tests',
  ];

  const OPENCODE_SKILLS = VIBE_SKILLS; // same skill names, different source + dest

  const CLINE_WORKFLOWS = [
    'openlore-analyze-codebase.md',
    'openlore-check-spec-drift.md',
    'openlore-execute-refactor.md',
    'openlore-implement-feature.md',
    'openlore-plan-refactor.md',
    'openlore-refactor-codebase.md',
    'openlore-write-tests.md',
  ];

  const GSD_COMMANDS = ['openlore-orient.md', 'openlore-drift.md'];

  const BMAD_AGENTS = ['architect.md', 'dev-brownfield.md'];
  const BMAD_TASKS = ['implement-story.md', 'onboarding.md', 'refactor.md', 'sprint-planning.md'];

  return {
    vibe: VIBE_SKILLS.map((name) => ({
      src: join(ex, 'mistral-vibe', 'skills', name, 'SKILL.md'),
      dest: join(projectRoot, '.vibe', 'skills', name, 'SKILL.md'),
    })),
    cline: CLINE_WORKFLOWS.map((file) => ({
      src: join(ex, 'cline-workflows', file),
      dest: join(projectRoot, '.clinerules', 'workflows', file),
    })),
    gsd: GSD_COMMANDS.map((file) => ({
      src: join(ex, 'gsd', 'commands', 'gsd', file),
      dest: join(projectRoot, '.claude', 'commands', 'gsd', file),
    })),
    bmad: [
      ...BMAD_AGENTS.map((file) => ({
        src: join(ex, 'bmad', 'agents', file),
        dest: join(projectRoot, '_bmad', 'openlore', 'agents', file),
      })),
      ...BMAD_TASKS.map((file) => ({
        src: join(ex, 'bmad', 'tasks', file),
        dest: join(projectRoot, '_bmad', 'openlore', 'tasks', file),
      })),
    ],
    claude: OPENCODE_SKILLS.map((name) => ({
      src: join(ex, 'opencode-skills', name, 'SKILL.md'),
      dest: join(projectRoot, '.claude', 'skills', name, 'SKILL.md'),
    })),
    opencode: [
      ...OPENCODE_SKILLS.map((name) => ({
        src: join(ex, 'opencode-skills', name, 'SKILL.md'),
        dest: join(projectRoot, '.opencode', 'skills', name, 'SKILL.md'),
      })),
      {
        src: join(ex, 'opencode', 'agent-guard.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'agent-guard.ts'),
      },
    ],
    omoa: [
      // SDD enforcement plugins
      {
        src: join(ex, 'opencode', 'plugins', 'anti-laziness.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'anti-laziness.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'openlore-enforcer.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'openlore-enforcer.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'openlore-decision-extractor.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'openlore-decision-extractor.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'lib', 'openlore-decision-extractor-helpers.ts'),
        dest: join(
          projectRoot,
          '.opencode',
          'plugins',
          'lib',
          'openlore-decision-extractor-helpers.ts'
        ),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'openlore-context-injector.ts'),
        dest: join(projectRoot, '.opencode', 'plugins', 'openlore-context-injector.ts'),
      },
      {
        src: join(ex, 'opencode', 'plugins', 'lib', 'openlore-context-injector-helpers.ts'),
        dest: join(
          projectRoot,
          '.opencode',
          'plugins',
          'lib',
          'openlore-context-injector-helpers.ts'
        ),
      },
      // Sisyphus SDD system prompt
      {
        src: join(ex, 'opencode', 'prompts', 'sisyphus-sdd.md'),
        dest: join(projectRoot, '.opencode', 'prompts', 'sisyphus-sdd.md'),
      },
    ],
  };
}

// ============================================================================
// CORE
// ============================================================================

async function runSetup(
  projectRoot: string,
  tools: ToolName[],
  force: boolean
): Promise<SetupResult[]> {
  const manifest = buildManifest(projectRoot);
  const results: SetupResult[] = [];

  for (const tool of tools) {
    for (const entry of manifest[tool]) {
      if (!(await fileExists(entry.src))) {
        logger.warning(`setup: source not found — ${entry.src} (re-install openlore to fix)`);
        continue;
      }
      const status = await copyFile(entry.src, entry.dest, force);
      const rel = entry.dest.startsWith(projectRoot)
        ? entry.dest.slice(projectRoot.length).replace(/^\//, '')
        : entry.dest;
      results.push({ tool, rel, status });
    }
  }

  return results;
}

// ============================================================================
// COMMAND
// ============================================================================

export const setupCommand = new Command('setup')
  .description(
    'Install workflow skills and agent integration files into this project.\n' +
      'Copies static assets from the openlore package — safe to re-run (skips existing files).'
  )
  .option(
    '--tools <list>',
    'Comma-separated list of tools to install: vibe, cline, claude, opencode, gsd, bmad (default: all)'
  )
  .option(
    '--force',
    'Overwrite existing files (use after upgrading openlore to pull in updated skills)',
    false
  )
  .option('--dir <path>', 'Project root directory', process.cwd())
  .option(
    '--hooks <format>',
    'Install PreToolUse panic-check hook for the given agent format: claude|kilo|codex'
  )
  .option(
    '--panic <mode>',
    'Set panic response mode in .openlore/config.json: off|observe|advisory|experimental_blocking'
  )
  .action(async (options: { tools?: string; force: boolean; dir: string; hooks?: string; panic?: string }) => {
    const projectRoot = options.dir;
    const allTools: ToolName[] = ['vibe', 'cline', 'gsd', 'bmad', 'claude', 'opencode', 'omoa'];

    // If only flag options (no tool install needed), run them and exit early
    if (!options.tools && (options.hooks || options.panic) && !process.stdout.isTTY) {
      if (options.hooks) {
        const validFormats = ['claude', 'kilo', 'codex'];
        const fmt = validFormats.includes(options.hooks) ? options.hooks : 'claude';
        if (!validFormats.includes(options.hooks)) {
          logger.warning(`Unknown hooks format "${options.hooks}" — defaulting to "claude"`);
        }
        await installPanicCheckHook(projectRoot, fmt);
        await installGryphWatchHook(projectRoot);
      }
      if (options.panic !== undefined) {
        const validModes: PanicResponseMode[] = ['off', 'observe', 'advisory', 'experimental_blocking'];
        if (!validModes.includes(options.panic as PanicResponseMode)) {
          logger.error(`Unknown panic mode "${options.panic}". Valid: ${validModes.join(', ')}`);
        } else {
          const cfg = await readOpenLoreConfig(projectRoot);
          if (!cfg) {
            logger.warning('No .openlore/config.json found — run openlore init first.');
          } else {
            cfg.panicResponse = { mode: options.panic as PanicResponseMode };
            await writeOpenLoreConfig(projectRoot, cfg);
            logger.success(`panic response mode set to "${options.panic}"`);
          }
        }
      }
      process.exit(0);
    }

    let tools: ToolName[];
    if (options.tools) {
      tools = (options.tools.split(',').map((t) => t.trim()) as ToolName[]).filter((t) =>
        allTools.includes(t)
      );
      if (tools.length === 0) {
        logger.error(
          'setup: no valid tools specified. Valid values: vibe, cline, gsd, bmad, claude, opencode, omoa'
        );
        process.exit(1);
      }
    } else if (process.stdout.isTTY) {
      const omoaDetected = await detectOmoa(projectRoot);
      if (omoaDetected) {
        console.log('  ✦ oh-my-openagent detected — SDD plugins available.\n');
      }

      const selected = await checkbox({
        message: 'Which agent tools do you want to install skills for?',
        choices: [
          {
            name: 'Claude Code   (.claude/skills/ — 8 skills + pre-commit & PostToolUse hooks)',
            value: 'claude' as ToolName,
          },
          {
            name: 'Cline / Roo   (.clinerules/workflows/openlore-{name}.md — 7 workflows)',
            value: 'cline' as ToolName,
          },
          {
            name: 'Mistral Vibe  (.vibe/skills/openlore-{name}/SKILL.md — 8 skills)',
            value: 'vibe' as ToolName,
          },
          {
            name: 'OpenCode      (.opencode/skills/openlore-{name}/SKILL.md — 8 skills + agent-guard plugin)',
            value: 'opencode' as ToolName,
          },
          {
            name: 'GSD           (.claude/commands/gsd/openlore-{name}.md — 2 commands)',
            value: 'gsd' as ToolName,
          },
          {
            name: 'BMAD          (_bmad/openlore/{agents,tasks}/ — 2 agents, 4 tasks)',
            value: 'bmad' as ToolName,
          },
          {
            name: `oh-my-openagent  (.opencode/plugins/ — SDD enforcement: anti-laziness, enforcer, decision-extractor)${omoaDetected ? ' ← detected' : ''}`,
            value: 'omoa' as ToolName,
            checked: omoaDetected,
          },
        ],
      });
      if (selected.length === 0) {
        console.log('Nothing selected — exiting.');
        process.exit(0);
      }
      tools = selected;
    } else {
      logger.error(
        'setup requires an interactive terminal.\n' +
          'Use --tools to specify which to install.\n' +
          'Example: openlore setup --tools claude,cline,omoa'
      );
      process.exit(1);
    }

    logger.success(`Installing workflow skills into ${projectRoot}`);

    let results: SetupResult[];
    try {
      results = await runSetup(projectRoot, tools, options.force);
    } catch (err) {
      logger.error(`setup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
      return;
    }

    if (tools.includes('claude')) {
      await installPreCommitHook(projectRoot);
      await installClaudeHook(projectRoot);
    }

    // --hooks flag: install panic-check PreToolUse hook independently of --tools
    if (options.hooks) {
      const validFormats = ['claude', 'kilo', 'codex'];
      const fmt = validFormats.includes(options.hooks) ? options.hooks : 'claude';
      if (!validFormats.includes(options.hooks)) {
        logger.warning(`Unknown hooks format "${options.hooks}" — defaulting to "claude"`);
      }
      await installPanicCheckHook(projectRoot, fmt);
      await installGryphWatchHook(projectRoot);
    }

    // --panic flag: update panicResponse.mode in .openlore/config.json
    if (options.panic !== undefined) {
      const validModes: PanicResponseMode[] = ['off', 'observe', 'advisory', 'experimental_blocking'];
      if (!validModes.includes(options.panic as PanicResponseMode)) {
        logger.error(`Unknown panic mode "${options.panic}". Valid: ${validModes.join(', ')}`);
      } else {
        const mode = options.panic as PanicResponseMode;
        const cfg = await readOpenLoreConfig(projectRoot);
        if (!cfg) {
          logger.warning('No .openlore/config.json found — run openlore init first.');
        } else {
          cfg.panicResponse = { mode };
          await writeOpenLoreConfig(projectRoot, cfg);
          logger.success(`panic response mode set to "${mode}"`);
        }
      }
    }

    // ── Report ───────────────────────────────────────────────────────────────
    const byTool: Record<string, SetupResult[]> = {};
    for (const r of results) {
      (byTool[r.tool] ??= []).push(r);
    }

    const LABELS: Record<ToolName, string> = {
      vibe: 'Mistral Vibe',
      cline: 'Cline / Roo Code',
      claude: 'Claude Code',
      opencode: 'OpenCode',
      gsd: 'get-shit-done (GSD)',
      bmad: 'BMAD',
      omoa: 'oh-my-openagent (SDD plugins)',
    };

    for (const tool of tools) {
      const entries = byTool[tool] ?? [];
      const created = entries.filter((e) => e.status === 'created').length;
      const updated = entries.filter((e) => e.status === 'updated').length;
      const skipped = entries.filter((e) => e.status === 'skipped').length;
      console.log(`\n${LABELS[tool as ToolName]}`);
      for (const e of entries) {
        const marker =
          e.status === 'created' ? '✓ created' : e.status === 'updated' ? '↑ updated' : '– exists ';
        console.log(`  ${marker} ${e.rel}`);
      }
      if (entries.length === 0) {
        logger.warning('  (no source files found — check openlore installation)');
      } else {
        console.log(`  ${created} created, ${updated} updated, ${skipped} already up-to-date`);
      }
    }

    const totalChanged = results.filter((r) => r.status !== 'skipped').length;
    if (totalChanged > 0) {
      logger.success(`${totalChanged} file(s) installed.`);
      console.log(
        'Run `openlore analyze --ai-configs` to also generate project-specific context files (CLAUDE.md, .cursorrules, etc.).'
      );
    } else {
      console.log(
        '\nAll files already up-to-date. Use --force to overwrite with the latest version.'
      );
    }

    if (tools.includes('omoa')) {
      console.log(`
┌─ oh-my-openagent SDD plugins installed ────────────────────────────────────┐
│                                                                              │
│  Wire the Sisyphus SDD prompt in your oh-my-openagent config:               │
│                                                                              │
│  ~/.config/opencode/oh-my-openagent.jsonc  (or .opencode/oh-my-openagent)  │
│                                                                              │
│  {                                                                           │
│    "agents": {                                                               │
│      "sisyphus": {                                                           │
│        "prompt_append": "file://.opencode/prompts/sisyphus-sdd.md"          │
│      }                                                                       │
│    }                                                                         │
│  }                                                                           │
│                                                                              │
│  Plugins loaded automatically from .opencode/plugins/ by OpenCode.           │
│  decision-extractor uses the Librarian agent — configure it in your config:  │
│    "agents": { "librarian": { "model": "google/gemini-3-flash" } }          │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘`);
    }
  });
