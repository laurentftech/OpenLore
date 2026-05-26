/**
 * Shared types for OpenLore install adapters.
 *
 * An adapter knows how to plan, apply, and uninstall OpenLore's footprint on
 * one specific agent surface. Adapters never write to disk directly when
 * `dryRun` is true; instead they return a list of `PlannedChange` entries that
 * the caller renders.
 */

import type { AgentName } from '../detect.js';

export interface PlannedChange {
  /** Absolute path the change applies to. */
  path: string;
  /** What we'd do to that file. */
  kind: 'create' | 'update' | 'noop' | 'delete';
  /** Short human-readable summary (one line). */
  summary: string;
  /** Optional unified-diff-ish preview for `--dry-run`. */
  preview?: string;
}

export interface ApplyContext {
  root: string;
  /** Template content for the markdown instruction block. */
  instructionTemplate: string;
  dryRun: boolean;
  force: boolean;
}

export interface ApplyResult {
  changes: PlannedChange[];
  /** Warnings to surface to the user (e.g. hand-edited block, unsure-of-path TODO). */
  warnings: string[];
  /** If true, install should exit non-zero (hand-edit conflict without --force). */
  conflict: boolean;
}

export interface Adapter {
  name: AgentName;
  apply(ctx: ApplyContext): Promise<ApplyResult>;
  uninstall(ctx: ApplyContext): Promise<ApplyResult>;
}
