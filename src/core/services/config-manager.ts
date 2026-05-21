/**
 * Configuration management service
 *
 * Handles reading/writing .openlore/config.json and openspec/config.yaml
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';
import type { ProjectType, OpenLoreConfig } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import {
  DEFAULT_MAX_FILES,
  DEFAULT_ANTHROPIC_MODEL,
  OPENLORE_DIR,
  OPENLORE_CONFIG_FILENAME,
  OPENLORE_CONFIG_REL_PATH,
  OPENSPEC_CONFIG_FILENAME,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';

/**
 * OpenSpec config.yaml structure
 */
export interface OpenSpecConfig {
  schema?: string;
  context?: string;
  'openlore'?: {
    generatedAt?: string;
    domains?: string[];
    confidence?: number;
    sourceProject?: string;
  };
  [key: string]: unknown;
}

/**
 * Ensure directory exists, creating it if necessary
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    // Ignore if directory already exists
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Get default openlore configuration
 */
export function getDefaultConfig(projectType: ProjectType, openspecPath: string): OpenLoreConfig {
  return {
    version: '1.0.0',
    projectType,
    openspecPath,
    analysis: {
      maxFiles: DEFAULT_MAX_FILES,
      includePatterns: [],
      excludePatterns: [],
    },
    generation: {
      model: DEFAULT_ANTHROPIC_MODEL,
      domains: 'auto',
    },
    panicResponse: { mode: 'off' },
    createdAt: new Date().toISOString(),
    lastRun: null,
  };
}

/**
 * Read openlore configuration from .openlore/config.json
 */
export async function readOpenLoreConfig(rootPath: string): Promise<OpenLoreConfig | null> {
  const configPath = join(rootPath, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME);
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    return null; // File doesn't exist — normal case before init
  }
  try {
    return JSON.parse(content) as OpenLoreConfig;
  } catch (err) {
    logger.warning(`Failed to parse ${configPath}: ${(err as Error).message}`);
    logger.warning(`Delete ${OPENLORE_CONFIG_REL_PATH} and run 'openlore init' to recreate it.`);
    return null;
  }
}

/**
 * Write openlore configuration to .openlore/config.json
 */
export async function writeOpenLoreConfig(
  rootPath: string,
  config: OpenLoreConfig
): Promise<void> {
  const configDir = join(rootPath, OPENLORE_DIR);
  const configPath = join(configDir, OPENLORE_CONFIG_FILENAME);

  await ensureDir(configDir);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Check if openlore config already exists
 */
export async function openloreConfigExists(rootPath: string): Promise<boolean> {
  return fileExists(join(rootPath, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME));
}

/**
 * Read OpenSpec config.yaml if it exists
 */
export async function readOpenSpecConfig(openspecPath: string): Promise<OpenSpecConfig | null> {
  const configPath = join(openspecPath, OPENSPEC_CONFIG_FILENAME);
  let content: string;
  try {
    content = await readFile(configPath, 'utf-8');
  } catch {
    return null; // File doesn't exist — normal case before generate
  }
  try {
    return YAML.parse(content) as OpenSpecConfig;
  } catch (err) {
    logger.warning(`Failed to parse ${configPath}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Write OpenSpec config.yaml
 */
export async function writeOpenSpecConfig(
  openspecPath: string,
  config: OpenSpecConfig
): Promise<void> {
  const configPath = join(openspecPath, OPENSPEC_CONFIG_FILENAME);

  await ensureDir(openspecPath);
  await writeFile(configPath, YAML.stringify(config), 'utf-8');
}

/**
 * Check if openspec directory exists
 */
export async function openspecDirExists(openspecPath: string): Promise<boolean> {
  return fileExists(openspecPath);
}

/**
 * Check if openspec/config.yaml exists
 */
export async function openspecConfigExists(openspecPath: string): Promise<boolean> {
  return fileExists(join(openspecPath, OPENSPEC_CONFIG_FILENAME));
}

/**
 * Create minimal OpenSpec directory structure
 */
export async function createOpenSpecStructure(openspecPath: string): Promise<void> {
  await ensureDir(openspecPath);
  await ensureDir(join(openspecPath, 'specs'));
}

/**
 * Merge existing OpenSpec config with openlore metadata
 */
export function mergeOpenSpecConfig(
  existing: OpenSpecConfig | null,
  openloreMeta: OpenSpecConfig['openlore']
): OpenSpecConfig {
  if (existing) {
    return {
      ...existing,
      'openlore': {
        ...existing['openlore'],
        ...openloreMeta,
      },
    };
  }

  return {
    schema: 'spec-driven',
    context: '',
    'openlore': openloreMeta,
  };
}
