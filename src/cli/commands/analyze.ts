/**
 * openlore analyze command
 *
 * Runs static analysis on the codebase without LLM involvement.
 * Outputs repository map, dependency graph, and file significance scores.
 */

import { Command } from 'commander';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { fileExists, formatDuration, formatAge, getAnalysisAge } from '../../utils/command-helpers.js';
import {
  ANALYSIS_STALE_THRESHOLD_MS,
  ARTIFACT_DEPENDENCY_GRAPH,
  ARTIFACT_FINGERPRINT,
  ARTIFACT_REFACTOR_PRIORITIES,
  ARTIFACT_REPO_STRUCTURE,
  DEFAULT_MAX_FILES,
  DEEP_ANALYSIS_FILE_RATIO,
  MAX_DEEP_ANALYSIS_FILES,
  MAX_VALIDATION_FILES,
  OPENSPEC_DIR,
  OPENSPEC_SPECS_SUBDIR,
  OPENSPEC_DECISIONS_SUBDIR,
  OPENLORE_ANALYSIS_REL_PATH,
  OPENLORE_CONFIG_REL_PATH,
} from '../../constants.js';
import { computeProjectFingerprint } from '../../core/services/mcp-handlers/utils.js';
import type { AnalyzeOptions, OpenLoreConfig } from '../../types/index.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { RepositoryMapper, type RepositoryMap } from '../../core/analyzer/repository-mapper.js';
import type { CloneGroup, CloneInstance } from '../../core/analyzer/duplicate-detector.js';
import {
  DependencyGraphBuilder,
  type DependencyGraphResult,
} from '../../core/analyzer/dependency-graph.js';
import {
  AnalysisArtifactGenerator,
  type AnalysisArtifacts,
} from '../../core/analyzer/artifact-generator.js';
import {
  buildArchitectureOverview,
  writeArchitectureMd,
} from '../../core/analyzer/architecture-writer.js';
import { EmbeddingService } from '../../core/analyzer/embedding-service.js';
import { generateCodebaseDigest } from '../../core/analyzer/codebase-digest.js';
import { extractUIComponents } from '../../core/analyzer/ui-component-extractor.js';
import { extractSchemas } from '../../core/analyzer/schema-extractor.js';
import { buildRouteInventory } from '../../core/analyzer/http-route-parser.js';
import { extractMiddleware } from '../../core/analyzer/middleware-extractor.js';
import { extractEnvVars } from '../../core/analyzer/env-extractor.js';
import { generateAiConfigs, AI_TOOL_TARGETS, type AiTool, type AiConfigResult } from '../../core/analyzer/ai-config-generator.js';

// ============================================================================
// TYPES
// ============================================================================

interface ExtendedAnalyzeOptions extends AnalyzeOptions {
  force?: boolean;
  embed?: boolean;
  reindexSpecs?: boolean;
  aiConfigs?: boolean;
}

interface AnalysisResult {
  repoMap: RepositoryMap;
  depGraph: DependencyGraphResult;
  artifacts: AnalysisArtifacts;
  duration: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Collect multiple values for repeatable options
 */
function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Check if analysis exists and return its age
 */

// ============================================================================
// CORE ANALYSIS FUNCTION
// ============================================================================

/**
 * Run the complete analysis pipeline
 */
export async function runAnalysis(
  rootPath: string,
  outputPath: string,
  options: {
    maxFiles: number;
    include: string[];
    exclude: string[];
  }
): Promise<AnalysisResult> {
  const startTime = Date.now();

  // Merge config patterns with caller-supplied patterns so all entry points
  // (CLI, MCP, …) automatically respect the project configuration.
  const openloreConfig = await readOpenLoreConfig(rootPath);
  const configExclude = openloreConfig?.analysis.excludePatterns ?? [];
  const configInclude = openloreConfig?.analysis.includePatterns ?? [];
  const mergedExclude = [...new Set([...configExclude, ...options.exclude])];
  const mergedInclude = [...new Set([...configInclude, ...options.include])];

  // Phase 1: Repository Mapping
  logger.analysis('Scanning directory structure...');

  const mapper = new RepositoryMapper(rootPath, {
    maxFiles: options.maxFiles,
    includePatterns: mergedInclude.length > 0 ? mergedInclude : undefined,
    excludePatterns: mergedExclude.length > 0 ? mergedExclude : undefined,
  });

  const repoMap = await mapper.map();

  logger.info('Files found', repoMap.summary.totalFiles);
  logger.info('Files analyzed', repoMap.summary.analyzedFiles);
  logger.info('Files skipped', repoMap.summary.skippedFiles);
  logger.blank();

  // Phase 2: Dependency Graph
  logger.analysis('Building dependency graph...');

  const graphBuilder = new DependencyGraphBuilder({
    rootDir: rootPath,
  });

  const depGraph = await graphBuilder.build(repoMap.allFiles);

  logger.info('Nodes', depGraph.statistics.nodeCount);
  logger.info('Edges', depGraph.statistics.edgeCount);
  logger.info('Clusters', depGraph.statistics.clusterCount);
  if (depGraph.statistics.cycleCount > 0) {
    logger.warning(`Circular dependencies: ${depGraph.statistics.cycleCount}`);
  }
  logger.blank();

  // Phase 3: Run new enrichment extractors in parallel
  logger.analysis('Extracting UI components, schemas, routes, and env vars...');

  const allFilePaths = repoMap.allFiles.map(f => f.path);

  const [uiComponents, schemas, routeInventory, middleware, envVars] = await Promise.all([
    extractUIComponents(allFilePaths, rootPath),
    extractSchemas(allFilePaths, rootPath),
    buildRouteInventory(allFilePaths, rootPath),
    extractMiddleware(allFilePaths, rootPath),
    extractEnvVars(allFilePaths, rootPath),
  ]);

  // Phase 4: Generate Artifacts
  logger.analysis('Generating analysis artifacts...');

  const artifactGenerator = new AnalysisArtifactGenerator({
    rootDir: rootPath,
    outputDir: outputPath,
    maxDeepAnalysisFiles: Math.min(MAX_DEEP_ANALYSIS_FILES, Math.ceil(repoMap.highValueFiles.length * DEEP_ANALYSIS_FILE_RATIO)),
    maxValidationFiles: MAX_VALIDATION_FILES,
  });

  const artifacts = await artifactGenerator.generateAndSave(repoMap, depGraph, {
    uiComponents,
    schemas,
    routeInventory,
    middleware,
    envVars,
  });

  // Also save the raw dependency graph
  await writeFile(
    join(outputPath, ARTIFACT_DEPENDENCY_GRAPH),
    JSON.stringify(depGraph, null, 2)
  );

  // Write content-hash fingerprint so future runs can skip re-analysis when
  // source files are unchanged (replaces the 1-hour TTL on a warm cache).
  const fingerprintHash = await computeProjectFingerprint(rootPath);
  await writeFile(
    join(outputPath, ARTIFACT_FINGERPRINT),
    JSON.stringify({ hash: fingerprintHash, computedAt: new Date().toISOString(), fileCount: repoMap.allFiles.length })
  );

  const duration = Date.now() - startTime;

  return { repoMap, depGraph, artifacts, duration };
}

// ============================================================================
// COMMAND
// ============================================================================

export const analyzeCommand = new Command('analyze')
  .description('Run static analysis on the codebase (no LLM required)')
  .option(
    '--output <path>',
    'Directory to write analysis results',
    `${OPENLORE_ANALYSIS_REL_PATH}/`
  )
  .option(
    '--max-files <n>',
    'Maximum number of files to analyze (default: 100000)',
    '100000'
  )
  .option(
    '--include <glob>',
    'Additional glob patterns to include (repeatable)',
    collect,
    []
  )
  .option(
    '--exclude <glob>',
    'Additional glob patterns to exclude (repeatable)',
    collect,
    []
  )
  .option(
    '--force',
    'Force re-analysis even if recent analysis exists',
    false
  )
  .option(
    '--embed',
    'Build a semantic vector index after analysis (requires EMBED_BASE_URL + EMBED_MODEL)',
    true
  )
  .option(
    '--no-embed',
    'Skip vector index build (overrides default --embed)'
  )
  .option(
    '--reindex-specs',
    'Re-index OpenSpec specs into the vector index without re-running full analysis (requires EMBED_BASE_URL + EMBED_MODEL)',
    false
  )
  .option(
    '--ai-configs',
    'Generate AI tool config files (.cursorrules, .clinerules/openlore.md, CLAUDE.md) if they do not already exist',
    false
  )
  .addHelpText(
    'after',
    `
Examples:
  $ openlore analyze                 Analyze with defaults
  $ openlore analyze --max-files 1000
                                     Analyze more files
  $ openlore analyze --include "*.graphql" --include "*.prisma"
                                     Include additional file types
  $ openlore analyze --exclude "legacy/**"
                                     Exclude specific directories
  $ openlore analyze --output ./my-analysis
                                     Custom output location
  $ openlore analyze --force         Force re-analysis
  $ openlore analyze --no-embed      Skip vector index build
  $ openlore analyze --reindex-specs Re-index specs only (no full re-analysis)

Output files:
  .openlore/analysis/
  ├── repo-structure.json    Repository structure and metadata
  ├── dependency-graph.json  Import/export relationships
  ├── llm-context.json       Optimized context for LLM
  ├── dependencies.mermaid   Visual dependency diagram
  └── SUMMARY.md             Human-readable analysis summary

After analysis, run 'openlore generate' to create OpenSpec files.
`
  )
  .action(async (options: Partial<ExtendedAnalyzeOptions>) => {
    const startTime = Date.now();
    const rootPath = process.cwd();

    const opts: ExtendedAnalyzeOptions = {
      output: options.output ?? `${OPENLORE_ANALYSIS_REL_PATH}/`,
      maxFiles: typeof options.maxFiles === 'string'
        ? parseInt(options.maxFiles, 10)
        : options.maxFiles ?? DEFAULT_MAX_FILES,
      include: options.include ?? [],
      exclude: options.exclude ?? [],
      force: options.force ?? false,
      embed: options.embed ?? false,
      reindexSpecs: options.reindexSpecs ?? false,
      aiConfigs: options.aiConfigs ?? false,
      quiet: false,
      verbose: false,
      noColor: false,
      config: OPENLORE_CONFIG_REL_PATH,
    };

    if (isNaN(opts.maxFiles) || opts.maxFiles < 1) {
      logger.error('--max-files must be a positive integer');
      process.exitCode = 1;
      return;
    }

    try {
      // ========================================================================
      // PHASE 1: VALIDATION
      // ========================================================================
      logger.section('Analyzing Codebase');

      // Check for openlore config
      const openloreConfig = await readOpenLoreConfig(rootPath);
      if (!openloreConfig) {
        logger.error('No openlore configuration found. Run "openlore init" first.');
        process.exitCode = 1;
        return;
      }

      // Auto-enable --embed when embedding is configured but flag wasn't passed explicitly.
      if (!options.embed) {
        const embedConfigured =
          !!process.env.EMBED_BASE_URL ||
          !!EmbeddingService.fromConfig(openloreConfig);
        if (embedConfigured) opts.embed = true;
      }

      logger.info('Project', openloreConfig.projectType);
      logger.info('Output', opts.output);
      logger.info('Max files', opts.maxFiles);
      if (opts.include.length > 0) {
        logger.info('Include patterns', opts.include.join(', '));
      }
      if (opts.exclude.length > 0) {
        logger.info('Exclude patterns', opts.exclude.join(', '));
      }
      logger.blank();

      // ========================================================================
      // PHASE 1b: --reindex-specs fast path (no full analysis)
      // ========================================================================
      if (opts.reindexSpecs) {
        const outputPath = join(rootPath, opts.output);
        await mkdir(outputPath, { recursive: true });
        await runSpecIndexing(rootPath, outputPath, openloreConfig);
        return;
      }

      // ========================================================================
      // PHASE 2: CHECK EXISTING ANALYSIS
      // ========================================================================
      const outputPath = join(rootPath, opts.output);
      const analysisAge = await getAnalysisAge(outputPath);

      if (analysisAge !== null && !opts.force) {
        // Analysis exists - check if recent
        if (analysisAge < ANALYSIS_STALE_THRESHOLD_MS) {
          logger.discovery(`Recent analysis exists (${formatAge(analysisAge)})`);
          logger.info('Tip', 'Use --force to re-analyze');
          logger.blank();

          // Show existing analysis stats
          try {
            const repoStructurePath = join(outputPath, ARTIFACT_REPO_STRUCTURE);
            const content = await import('node:fs/promises').then(fs =>
              fs.readFile(repoStructurePath, 'utf-8')
            );
            const repoStructure = JSON.parse(content);

            logger.success('Analysis Summary');
            logger.info('Files analyzed', repoStructure.statistics.analyzedFiles);
            logger.info('Domains detected', repoStructure.domains.map((d: { name: string }) => d.name).join(', ') || 'None');
            logger.info('Architecture', repoStructure.architecture.pattern);
            logger.blank();

            // If embed is requested, run the embed step (incremental: only re-embeds changed functions)
            if (opts.embed) {
              await runEmbedStep(rootPath, outputPath, openloreConfig, opts.force ?? false, null);
            }

            // If --ai-configs is requested, generate them even from cached analysis
            if (opts.aiConfigs) {
              let selectedTools: AiTool[] | undefined;
              if (process.stdin.isTTY) {
                const { checkbox } = await import('@inquirer/prompts');
                const chosen = await checkbox<AiTool>({
                  message: 'Generate config files for which AI assistants?',
                  choices: AI_TOOL_TARGETS.map(t => ({
                    name: t.label,
                    value: t.tool,
                    checked: true,
                  })),
                });
                selectedTools = chosen.length > 0 ? chosen : undefined;
              }
              if (selectedTools === undefined || selectedTools.length > 0) {
                const aiResults = await generateAiConfigs({
                  rootDir: rootPath,
                  analysisDir: opts.output.replace(/\/$/, ''),
                  projectName: repoStructure.projectName ?? 'project',
                  tools: selectedTools,
                });
                logger.blank();
                console.log('  Agent config files:');
                for (const { rel, created } of aiResults) {
                  const tag = created ? '(created)' : '(already exists)';
                  console.log(`    ├─ ${rel}  ${tag}`);
                }
                logger.blank();
              }
            }

            logger.info('Next step', "Run 'openlore generate' to create OpenSpec files");
            return;
          } catch (readErr) {
            logger.debug(`Could not read existing analysis summary: ${(readErr as Error).message}`);
          }
        } else {
          logger.discovery(`Existing analysis is ${formatAge(analysisAge)} old, re-analyzing...`);
          logger.blank();
        }
      }

      // ========================================================================
      // PHASE 3: RUN ANALYSIS
      // ========================================================================
      // Ensure output directory exists
      await mkdir(outputPath, { recursive: true });

      const result = await runAnalysis(rootPath, outputPath, {
        maxFiles: opts.maxFiles,
        include: opts.include,
        exclude: opts.exclude,
      });

      // ========================================================================
      // PHASE 4: DISPLAY RESULTS
      // ========================================================================
      logger.blank();
      logger.section('Analysis Complete');

      const { repoMap, depGraph, artifacts } = result;

      // Summary
      console.log('');
      console.log('  Repository Structure:');
      console.log(`    ├─ Files analyzed: ${repoMap.summary.analyzedFiles}`);
      console.log(`    ├─ High-value files: ${repoMap.highValueFiles.length}`);
      console.log(`    ├─ Languages: ${repoMap.summary.languages.slice(0, 3).map(l => l.language).join(', ')}`);
      console.log(`    └─ Architecture: ${artifacts.repoStructure.architecture.pattern}`);
      console.log('');

      console.log('  Dependency Graph:');
      console.log(`    ├─ Nodes: ${depGraph.statistics.nodeCount}`);
      console.log(`    ├─ Edges: ${depGraph.statistics.edgeCount}`);
      console.log(`    ├─ Clusters: ${depGraph.statistics.clusterCount}`);
      if (depGraph.statistics.cycleCount > 0) {
        console.log(`    ├─ ⚠ Circular dependencies: ${depGraph.statistics.cycleCount}`);
      }
      console.log(`    └─ Average degree: ${depGraph.statistics.avgDegree.toFixed(1)}`);
      console.log('');

      // Call Graph
      const cg = artifacts.llmContext.callGraph;
      if (cg && cg.stats?.totalNodes > 0) {
        console.log('  Call Graph (static analysis):');
        console.log(`    ├─ Functions: ${cg.stats.totalNodes}`);
        console.log(`    ├─ Internal calls: ${cg.stats.totalEdges}`);
        if (cg.hubFunctions?.length > 0) {
          const hubs = cg.hubFunctions.slice(0, 3).map(f => `${f.name}(fanIn=${f.fanIn})`).join(', ');
          console.log(`    ├─ Hub functions: ${hubs}`);
        }
        if (cg.layerViolations?.length > 0) {
          console.log(`    ├─ ⚠ Layer violations: ${cg.layerViolations.length}`);
        }
        console.log(`    └─ Entry points: ${cg.entryPoints?.length ?? 0}`);
        console.log('');
      }

      // Refactor priorities (read from disk if available)
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const rp = JSON.parse(await rf(join(opts.output, ARTIFACT_REFACTOR_PRIORITIES), 'utf-8'));
        if (rp?.stats?.withIssues > 0) {
          const s = rp.stats;
          const badges = [
            s.unreachable   > 0 ? `${s.unreachable} unreachable`  : null,
            s.highFanIn     > 0 ? `${s.highFanIn} hub overload`   : null,
            s.highFanOut    > 0 ? `${s.highFanOut} god function`   : null,
            s.srpViolations > 0 ? `${s.srpViolations} SRP`        : null,
            s.cyclesDetected> 0 ? `${s.cyclesDetected} cycle`     : null,
            s.inCloneGroup  > 0 ? `${s.inCloneGroup} duplicate`   : null,
          ].filter(Boolean).join('  ·  ');

          const issueLabel: Record<string, string> = {
            unreachable:       'dead code',
            high_fan_in:       `hub   fanIn`,
            high_fan_out:      `god   fanOut`,
            multi_requirement: 'SRP',
            in_cycle:          'cycle',
            in_clone_group:    'clone',
          };

          console.log(`  Refactoring Candidates  (${s.withIssues}/${s.totalFunctions} functions):`);
          console.log(`    ${badges}`);
          console.log('');

          const top = (rp.priorities as Array<{ function: string; file: string; fanIn: number; fanOut: number; issues: string[]; requirements: string[] }>).slice(0, 7);
          if (top.length === 0) {
            console.log('    (no refactoring candidates)');
          } else {
            const maxNameLen = Math.max(...top.map(p => (p.function ?? '').length), 8);
            const maxFileLen = Math.max(...top.map(p => (p.file?.split('/').pop() ?? '').length), 8);

            for (const p of top) {
              const name  = (p.function ?? '').padEnd(maxNameLen);
              const file  = (p.file?.split('/').pop() ?? '').padEnd(maxFileLen);
              const main  = p.issues?.[0];
              const val   = main === 'high_fan_in'  ? `fanIn=${p.fanIn}`
                          : main === 'high_fan_out' ? `fanOut=${p.fanOut}`
                          : main === 'in_cycle'     ? `cycle`
                          : main === 'unreachable'  ? `unreachable`
                          : `${p.requirements?.length ?? 0} req`;
              const extra = (p.issues ?? []).slice(1).map(i => issueLabel[i] ?? i).join(', ');
              const reqs  = (p.requirements?.length ?? 0) > 0 ? `  [${p.requirements.slice(0,2).join(', ')}${p.requirements.length > 2 ? '…' : ''}]` : '';
              console.log(`    ${name}  ${file}  ${val.padEnd(12)}${extra ? '  +' + extra : ''}${reqs}`);
            }
          }

          if (rp.cycles?.length > 0) {
            console.log('');
            for (const c of rp.cycles as Array<{ size: number; participants: Array<{ function: string; file: string }> }>) {
              const names = c.participants.map(p => p.function).join(' ↔ ');
              console.log(`    ⚠ Cycle: ${names}`);
            }
          }

          console.log('');
          console.log(`    → ${opts.output}refactor-priorities.json`);
          console.log('');
        }
      } catch (rpErr) {
        logger.debug(`Refactor priorities not available: ${(rpErr as Error).message}`);
      }

      // Duplicate code detection
      try {
        const { readFile: rf } = await import('node:fs/promises');
        const dup = JSON.parse(await rf(join(opts.output, 'duplicates.json'), 'utf-8'));
        if (dup?.stats?.cloneGroupCount > 0) {
          const s = dup.stats;
          const severity = s.duplicationRatio >= 0.2 ? '⚠'
                           : s.duplicationRatio >= 0.1 ? 'ℹ'
                           : ' ';
          console.log(`  ${severity} Code Duplication  (${s.duplicatedFunctions}/${s.totalFunctions} functions):`);
          console.log(`    ├─ Ratio: ${(s.duplicationRatio * 100).toFixed(1)}%`);
          console.log(`    ├─ Clone groups: ${s.cloneGroupCount}`);

          // Show top clone types
          const typeCounts: Record<string, number> = { exact: 0, structural: 0, near: 0 };
          for (const group of dup.cloneGroups) {
            typeCounts[group.type]++;
          }
          const typeLabels = Object.entries(typeCounts)
            .filter(([_, count]) => count > 0)
            .map(([type, count]) => `${count} ${type}`)
            .join('  ·  ');

          console.log(`    └─ Types: ${typeLabels}`);

          // Show top 5 clone groups
          if (dup.cloneGroups.length > 0) {
            console.log('');
            console.log('  Top 5 Clone Groups:');
            const topGroups = dup.cloneGroups
              .sort((a: CloneGroup, b: CloneGroup) => b.instances.length - a.instances.length)
              .slice(0, 5);

            for (const group of topGroups) {
              const files = group.instances.map((i: CloneInstance) => {
                const fileParts = i.file.split('/');
                return `${fileParts[fileParts.length - 2]}/${fileParts[fileParts.length - 1]}:${i.functionName}`;
              }).join('  ');

              console.log(`    ${group.type.padEnd(10)} (${group.instances.length}x, ${group.lineCount} lines): ${files}`);
            }
          }

          console.log('');
          console.log(`    → ${opts.output}duplicates.json`);
          console.log('');
        }
      } catch (dupErr) {
        logger.debug(`Duplicates report not available: ${(dupErr as Error).message}`);
      }

      // Detected domains
      if (artifacts.repoStructure.domains.length > 0) {
        console.log('  Detected Domains:');
        for (let i = 0; i < Math.min(artifacts.repoStructure.domains.length, 6); i++) {
          const domain = artifacts.repoStructure.domains[i];
          const isLast = i === Math.min(artifacts.repoStructure.domains.length, 6) - 1;
          const prefix = isLast ? '└─' : '├─';
          console.log(`    ${prefix} ${domain.name} (${domain.files.length} files)`);
        }
        if (artifacts.repoStructure.domains.length > 6) {
          console.log(`       ... and ${artifacts.repoStructure.domains.length - 6} more`);
        }
        console.log('');
      }

      // Generate ARCHITECTURE.md from cached analysis (no LLM)
      let architectureMdWritten = false;
      try {
        const ctx = artifacts.llmContext ?? null;
        const overview = buildArchitectureOverview(depGraph, ctx, rootPath);
        await writeArchitectureMd(rootPath, overview);
        architectureMdWritten = true;
      } catch (archErr) {
        logger.debug(`ARCHITECTURE.md generation skipped: ${(archErr as Error).message}`);
      }

      // Generate .openlore/analysis/CODEBASE.md — agent-readable architecture digest
      const digestWritten = await generateCodebaseDigest(
        artifacts.llmContext,
        depGraph,
        { rootPath, outputDir: outputPath },
      );

      // Generate AI tool config files — prompt user to select which assistants
      let aiConfigsCreated: AiConfigResult[] = [];
      if (opts.aiConfigs) {
        let selectedTools: AiTool[] | undefined;

        if (process.stdin.isTTY) {
          const { checkbox } = await import('@inquirer/prompts');
          const chosen = await checkbox<AiTool>({
            message: 'Generate config files for which AI assistants?',
            choices: AI_TOOL_TARGETS.map(t => ({
              name: t.label,
              value: t.tool,
              checked: true,
            })),
          });
          selectedTools = chosen.length > 0 ? chosen : undefined;
        }
        // Non-TTY: generate for all tools (CI / pipe usage)

        if (selectedTools === undefined || selectedTools.length > 0) {
          aiConfigsCreated = await generateAiConfigs({
            rootDir: rootPath,
            analysisDir: opts.output.replace(/\/$/, ''),
            projectName: result.repoMap.metadata.projectName,
            tools: selectedTools,
          });
        }
      }

      // Files generated
      console.log('  Output Files:');
      console.log(`    ├─ ${opts.output}repo-structure.json`);
      console.log(`    ├─ ${opts.output}dependency-graph.json`);
      console.log(`    ├─ ${opts.output}llm-context.json`);
      console.log(`    ├─ ${opts.output}dependencies.mermaid`);
      if (artifacts.repoStructure.schemas.length > 0) {
        console.log(`    ├─ ${opts.output}schema-inventory.json  (${artifacts.repoStructure.schemas.length} table(s))`);
      }
      if (artifacts.repoStructure.routeInventory.total > 0) {
        console.log(`    ├─ ${opts.output}route-inventory.json  (${artifacts.repoStructure.routeInventory.total} route(s))`);
      }
      if (artifacts.repoStructure.middleware.length > 0) {
        console.log(`    ├─ ${opts.output}middleware-inventory.json  (${artifacts.repoStructure.middleware.length} middleware entry(ies))`);
      }
      if (artifacts.repoStructure.uiComponents.length > 0) {
        console.log(`    ├─ ${opts.output}ui-inventory.json  (${artifacts.repoStructure.uiComponents.length} UI component(s))`);
      }
      if (artifacts.repoStructure.envVars.length > 0) {
        console.log(`    ├─ ${opts.output}env-inventory.json  (${artifacts.repoStructure.envVars.length} env var(s))`);
      }
      if (architectureMdWritten) {
        console.log(`    ├─ ${opts.output}SUMMARY.md`);
        console.log('    ├─ ARCHITECTURE.md');
      } else {
        console.log(`    ├─ ${opts.output}SUMMARY.md`);
      }
      if (digestWritten) {
        console.log(`    └─ ${opts.output}CODEBASE.md`);
        console.log('');
        console.log('  Agent setup (one-time):');
        console.log(`    Add to your CLAUDE.md or .clinerules:`);
        console.log('');
        console.log(`    @.openlore/analysis/CODEBASE.md`);
        console.log('');
        console.log('    ## openlore MCP tools — when to use them');
        console.log('    | Situation                                       | Tool                              |');
        console.log('    |-------------------------------------------------|-----------------------------------|');
        console.log("    | Don't know which file/function handles a concept | search_code                      |");
        console.log('    | Need call topology across many files            | get_subgraph / analyze_impact     |');
        console.log('    | Starting a new task on an unfamiliar codebase   | orient                            |');
        console.log('    | Planning where to add a feature                 | suggest_insertion_points          |');
        console.log('    | Checking if code still matches spec             | check_spec_drift                  |');
        console.log('    | Finding spec requirements by meaning            | search_specs                      |');
      }
      console.log('');
      if (aiConfigsCreated.length > 0) {
        console.log('  Agent config files:');
        for (const { rel, created } of aiConfigsCreated) {
          const tag = created ? '(created)' : '(already exists)';
          console.log(`    ├─ ${rel}  ${tag}`);
        }
      } else {
        console.log('  Agent config files: not generated');
        console.log('    Tip: Re-run with --ai-configs to generate CLAUDE.md, .cursorrules, AGENTS.md, etc.');
      }
      console.log('');

      // ========================================================================
      // PHASE 5 (optional): BUILD VECTOR INDEX
      // ========================================================================
      if (opts.embed) {
        await runEmbedStep(rootPath, outputPath, openloreConfig, opts.force ?? false, result.artifacts.llmContext);
      }

      // Duration
      const totalDuration = Date.now() - startTime;
      console.log(`  Total time: ${formatDuration(totalDuration)}`);
      console.log('');

      logger.success('Ready for generation!');
      logger.blank();
      logger.info('Next step', "Run 'openlore generate' to create OpenSpec files");

    } catch (error) {
      logger.error(`Analysis failed: ${(error as Error).message}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exitCode = 1;
    }
  });

// ============================================================================
// EMBED STEP HELPER
// ============================================================================

/**
 * Build (or incrementally update) the vector index from a LLMContext.
 * When llmContext is null, reads llm-context.json from outputDir (cache path).
 * Non-fatal: prints a warning on failure without throwing.
 */
async function runEmbedStep(
  rootPath: string,
  outputPath: string,
  openloreConfig: OpenLoreConfig | null,
  force: boolean,
  llmContext: import('../../core/analyzer/artifact-generator.js').LLMContext | null,
): Promise<void> {
  console.log('  Building semantic vector index...');
  try {
    const { EmbeddingService } = await import('../../core/analyzer/embedding-service.js');
    const { VectorIndex } = await import('../../core/analyzer/vector-index.js');

    // Resolve embedding service — best-effort. When none is configured we build
    // a keyword-only (BM25) index rather than aborting the whole index build.
    let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
    try {
      embedSvc = EmbeddingService.fromEnv();
    } catch {
      const cfg = openloreConfig ?? await readOpenLoreConfig(rootPath);
      embedSvc = cfg ? EmbeddingService.fromConfig(cfg) : null;
    }

    // Load context from disk if not provided (cache hit path)
    if (!llmContext) {
      try {
        const raw = await readFile(join(outputPath, 'llm-context.json'), 'utf-8');
        llmContext = JSON.parse(raw);
      } catch {
        console.log('    ⚠ Could not read llm-context.json — run openlore analyze --force');
        return;
      }
    }

    const cg = llmContext!.callGraph;
    const sigs = llmContext!.signatures ?? [];

    if (!cg || cg.nodes.length === 0) {
      console.log('    ⚠ No call graph data — function index skipped');
    } else {
      const hubIds = new Set(cg.hubFunctions.map(f => f.id));
      const entryIds = new Set(cg.entryPoints.map(f => f.id));

      const fileContents = new Map<string, string>();
      const uniquePaths = new Set(cg.nodes.map(n => n.filePath));
      await Promise.all([...uniquePaths].map(async fp => {
        try {
          fileContents.set(fp, await readFile(join(rootPath, fp), 'utf-8'));
        } catch { /* skip unreadable files */ }
      }));

      // Build with the embedder when available; if a configured embedder fails
      // at runtime (endpoint unreachable), warn and fall back to a BM25 index
      // rather than producing nothing.
      let result;
      try {
        result = await VectorIndex.build(
          outputPath, cg.nodes, sigs, hubIds, entryIds, embedSvc, fileContents,
          /* incremental */ !force
        );
      } catch (buildErr) {
        if (embedSvc) {
          console.log(`    ⚠ Embedding failed (${(buildErr as Error).message}) — building keyword (BM25) index instead.`);
          result = await VectorIndex.build(
            outputPath, cg.nodes, sigs, hubIds, entryIds, null, fileContents,
            /* incremental */ false
          );
        } else {
          throw buildErr;
        }
      }

      if (result.hasEmbeddings) {
        const cacheNote = result.reused > 0 ? ` (${result.embedded} embedded, ${result.reused} cached)` : '';
        console.log(`    ✓ Function index built (${result.total} functions${cacheNote}, ${fileContents.size} files with skeleton bodies)`);
      } else {
        console.log(`    ✓ Built keyword (BM25) search index (${result.total} functions) — set EMBED_BASE_URL/EMBED_MODEL or add "embedding" to .openlore/config.json for semantic search.`);
      }
      console.log(`    → ${outputPath.replace(rootPath + '/', '')}vector-index/`);
    }

    // Also index specs if they exist
    await runSpecIndexing(rootPath, outputPath, openloreConfig);
  } catch (embedErr) {
    console.log(`    ✗ Vector index failed: ${(embedErr as Error).message}`);
  }
  console.log('');
}

// ============================================================================
// SPEC INDEXING HELPER
// ============================================================================

/**
 * Index OpenSpec specs into the vector index.
 * Looks for specs in <rootPath>/openspec/specs/ (configured or default).
 * Non-fatal: prints a warning if no specs found or embedding fails.
 */
async function runSpecIndexing(
  rootPath: string,
  outputPath: string,
  openloreConfig: OpenLoreConfig | null
): Promise<void> {
  const { join: pathJoin } = await import('node:path');
  const { SpecVectorIndex } = await import('../../core/analyzer/spec-vector-index.js');
  const { readOpenLoreConfig } = await import('../../core/services/config-manager.js');

  // Resolve embedding service — best-effort. When none is configured we build
  // a keyword-only (BM25) spec index rather than skipping spec search entirely.
  let embedSvc: InstanceType<typeof EmbeddingService> | null = null;
  try {
    embedSvc = EmbeddingService.fromEnv();
  } catch {
    const cfg = openloreConfig ?? await readOpenLoreConfig(rootPath);
    embedSvc = cfg ? EmbeddingService.fromConfig(cfg) : null;
  }

  // Locate specs directory
  const specsDir = pathJoin(rootPath, OPENSPEC_DIR, OPENSPEC_SPECS_SUBDIR);
  if (!(await fileExists(specsDir))) {
    console.log(`    ℹ No ${OPENSPEC_DIR}/${OPENSPEC_SPECS_SUBDIR}/ directory found — spec index skipped`);
    return;
  }

  const mappingJsonPath = pathJoin(outputPath, 'mapping.json');

  try {
    const decisionsDir = pathJoin(rootPath, OPENSPEC_DIR, OPENSPEC_DECISIONS_SUBDIR);
    const { recordCount, hasEmbeddings } = await SpecVectorIndex.build(outputPath, specsDir, embedSvc, mappingJsonPath, decisionsDir);
    const specNote = hasEmbeddings ? '' : ' (keyword/BM25 — set EMBED_* for semantic spec search)';
    console.log(`    ✓ Spec index built (${recordCount} sections)${specNote}`);
    console.log(`    → ${outputPath.replace(rootPath + '/', '')}vector-index/`);
  } catch (err) {
    console.log(`    ⚠ Spec index skipped: ${(err as Error).message}`);
  }
}
