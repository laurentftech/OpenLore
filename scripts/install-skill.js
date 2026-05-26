#!/usr/bin/env node
/**
 * Copy `skills/openlore-orient/` into the current user's
 * `~/.claude/skills/openlore-orient/` directory.
 *
 * Idempotent — re-running overwrites any previously-installed copy with the
 * version from this repo. Uses only Node built-ins.
 */

import { cp, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', 'skills', 'openlore-orient');
const target = resolve(homedir(), '.claude', 'skills', 'openlore-orient');

try {
  await stat(source);
} catch {
  console.error(`[install-skill] source not found: ${source}`);
  process.exit(1);
}

await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true, force: true });
console.log(`[install-skill] copied ${source} → ${target}`);
