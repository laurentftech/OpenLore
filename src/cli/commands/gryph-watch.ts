/**
 * openlore gryph-watch
 *
 * Standalone Gryph behavioral observer. Runs as an independent background
 * process — lifetime decoupled from the MCP server session. Polls Gryph every
 * interval and writes behavioral signals to panic-state.json via CAS writes.
 *
 * Why a separate process: MCP-path Gryph polling only starts after the first
 * openlore tool call. Agents working exclusively via Bash/Edit/Read never
 * trigger that path. gryph-watch closes this gap by running continuously from
 * session start.
 *
 * Signals provided (standalone, without MCP tracker context):
 *   repetitiveRetryBurst — low entropy + failing commands (no stale context needed)
 *
 * Signals requiring MCP tracker (not available here):
 *   largePatchWhileStale — staleDepth unknown without EpistemicLease session
 *
 * Install via: openlore setup --hooks claude
 * Which installs a UserPromptSubmit hook: openlore gryph-watch &
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { startGryphPolling } from '../../core/services/mcp-handlers/gryph-bridge.js';

const PID_FILE = 'gryph-watch.pid';

function findProjectDirectory(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, OPENLORE_DIR, 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

export const gryphWatchCommand = new Command('gryph-watch')
  .description('Background Gryph behavioral observer (install via: openlore setup --hooks)')
  .argument('[directory]', 'Project directory — auto-detected from cwd if omitted')
  .action(async (directoryArg?: string) => {
    const directory = directoryArg
      ?? findProjectDirectory(process.cwd())
      ?? process.cwd();

    const cfg = await readOpenLoreConfig(directory);
    const mode = cfg?.panicResponse?.mode ?? 'off';
    if (mode === 'off') process.exit(0);

    // Singleton enforcement: one watcher per directory
    const pidPath = join(directory, OPENLORE_DIR, PID_FILE);
    if (existsSync(pidPath)) {
      try {
        const existing = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
        if (!isNaN(existing) && isProcessAlive(existing)) process.exit(0);
      } catch { /* stale PID file — proceed */ }
    }
    try { writeFileSync(pidPath, String(process.pid), 'utf-8'); } catch { /* non-fatal */ }

    const cleanup = (): void => {
      try { unlinkSync(pidPath); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    // Detect parent process death via stdin EOF (pipe from shell/agent closes)
    process.stdin.resume();
    process.stdin.on('close', cleanup);

    // startGryphPolling drives a while loop internally — pending setTimeout keeps
    // the process alive. getTracker: () => null is intentional: staleDepth is
    // unknown without an active MCP session; largePatchWhileStale is MCP-path-only.
    startGryphPolling({ directory, getTracker: () => null });
  });
