/**
 * Opt-in telemetry writer for openlore.
 *
 * Gate: OPENLORE_TELEMETRY=1 (disabled by default).
 * Writes append-only JSONL to .openlore/telemetry/<domain>.jsonl.
 * Never throws — telemetry must not crash the hot path.
 *
 * Rotation: when a domain file exceeds ROTATE_THRESHOLD_BYTES, it is renamed
 * to <domain>.1.jsonl and older rotated files shifted (keeps MAX_ROTATED_FILES).
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';

const TELEMETRY_SUBDIR = 'telemetry';
const ROTATE_THRESHOLD_BYTES = 50 * 1024 * 1024;  // 50 MB
const MAX_ROTATED_FILES = 5;
const _createdDirs = new Set<string>();

function rotateTelemetryFile(filePath: string): void {
  // Shift existing rotated files: .5.jsonl deleted, .4 → .5, …, .1 → .2
  const base = filePath.replace(/\.jsonl$/, '');
  try { unlinkSync(`${base}.${MAX_ROTATED_FILES}.jsonl`); } catch { /* not present */ }
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    try { renameSync(`${base}.${i}.jsonl`, `${base}.${i + 1}.jsonl`); } catch { /* not present */ }
  }
  try { renameSync(filePath, `${base}.1.jsonl`); } catch { /* rename failed — continue writing */ }
}

/**
 * Emit a telemetry event to .openlore/telemetry/<domain>.jsonl.
 *
 * @param directory  - project root (must be absolute)
 * @param domain     - log file name without extension (e.g. 'mcp', 'cache', 'epistemic-lease')
 * @param payload    - arbitrary fields merged with the timestamp
 */
export function emit(
  directory: string,
  domain: string,
  payload: Record<string, unknown>,
): void {
  if (!process.env['OPENLORE_TELEMETRY']) return;
  if (!directory) return;
  try {
    const dir = join(directory, OPENLORE_DIR, TELEMETRY_SUBDIR);
    if (!_createdDirs.has(dir)) { mkdirSync(dir, { recursive: true }); _createdDirs.add(dir); }
    const filePath = join(dir, `${domain}.jsonl`);
    // Rotate before writing if file exceeds threshold
    try {
      const { size } = statSync(filePath);
      if (size >= ROTATE_THRESHOLD_BYTES) rotateTelemetryFile(filePath);
    } catch { /* file doesn't exist yet */ }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload }) + '\n';
    appendFileSync(filePath, line, 'utf-8');
  } catch {
    // never crash the hot path
  }
}
