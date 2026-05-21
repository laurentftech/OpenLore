/**
 * openlore MCP Server
 *
 * Exposes openlore's static analysis capabilities as Model Context Protocol
 * tools, usable from Cline, Claude Code, or any MCP-compatible AI agent.
 *
 * Transport: stdio (standard for editor-embedded MCP servers)
 *
 * Configuration for Cline / Claude Code:
 *   {
 *     "mcpServers": {
 *       "openlore": {
 *         "command": "node",
 *         "args": ["/path/to/openlore/dist/cli/index.js", "mcp"]
 *       }
 *     }
 *   }
 */

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _pkgVersion = (_require('../../../package.json') as { version: string }).version;

import { Command } from 'commander';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { sanitizeMcpError, validateDirectory } from '../../core/services/mcp-handlers/utils.js';
import { createTracker, updateTracker, updatePanic, getFreshnessSignal, trackerToPanicState } from '../../core/services/mcp-handlers/epistemic-lease.js';
import type { EpistemicTracker } from '../../core/services/mcp-handlers/epistemic-lease.js';
import type { PanicResponseMode } from '../../types/index.js';
import { writePanicState, getPanicSignalText } from '../../core/services/mcp-handlers/panic-response.js';
import { emit } from '../../core/services/telemetry.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { DEFAULT_DRIFT_MAX_FILES } from '../../constants.js';
import {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
  handleTraceExecutionPath,
} from '../../core/services/mcp-handlers/graph.js';
import {
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleListSpecDomains,
  handleGetSpec,
  handleUnifiedSearch,
} from '../../core/services/mcp-handlers/semantic.js';
import { handleOrient } from '../../core/services/mcp-handlers/orient.js';
import { handleGenerateChangeProposal, handleAnnotateStory } from '../../core/services/mcp-handlers/change.js';
import {
  handleRecordDecision,
  handleListDecisions,
  handleApproveDecision,
  handleRejectDecision,
  handleSyncDecisions,
} from '../../core/services/mcp-handlers/decisions.js';
import {
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
  handleGetFunctionBody,
  handleGetDecisions,
  handleGetRouteInventory,
  handleGetMiddlewareInventory,
  handleGetSchemaInventory,
  handleGetUIComponents,
  handleGetEnvVars,
  handleGetExternalPackages,
  handleAuditSpecCoverage,
  handleGenerateTests,
  handleGetTestCoverage,
  handleGetMinimalContext,
  handleGetCluster,
  handleDetectChanges,
} from '../../core/services/mcp-handlers/analysis.js';

// Re-export utilities for tests
export { sanitizeMcpError, validateDirectory };

// Re-export handlers for use by chat-tools.ts and tests
export {
  handleGetCallGraph,
  handleGetSubgraph,
  handleAnalyzeImpact,
  handleGetLowRiskRefactorCandidates,
  handleGetLeafFunctions,
  handleGetCriticalHubs,
  handleGetGodFunctions,
  handleGetFileDependencies,
  handleTraceExecutionPath,
  handleSearchCode,
  handleSuggestInsertionPoints,
  handleSearchSpecs,
  handleAnalyzeCodebase,
  handleGetArchitectureOverview,
  handleGetRefactorReport,
  handleGetDuplicateReport,
  handleGetSignatures,
  handleGetMapping,
  handleCheckSpecDrift,
  handleGetFunctionSkeleton,
  handleGetRouteInventory,
  handleGetMiddlewareInventory,
  handleGetSchemaInventory,
  handleGetUIComponents,
  handleGetEnvVars,
  handleGetExternalPackages,
  handleAuditSpecCoverage,
  handleGenerateTests,
  handleGetTestCoverage,
  handleGetMinimalContext,
  handleGetCluster,
  handleDetectChanges,
};

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const TOOL_DEFINITIONS = [
  {
    name: 'orient',
    description:
      'START HERE. Call this before any other tool when beginning a new task on an unfamiliar codebase. ' +
      'Given a natural-language task description, returns in ONE call: relevant functions, source files, ' +
      'spec domains that cover them, depth-1 call neighbours, top insertion point candidates, ' +
      'and matching spec sections. Falls back to keyword search if the embedding server is down. ' +
      'Requires "openlore analyze" to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        task: {
          type: 'string',
          description: 'Natural language description of the task, e.g. "add rate limiting to the HTTP API"',
        },
        limit: {
          type: 'number',
          description: 'Number of relevant functions to return (default: 5)',
        },
      },
      required: ['directory', 'task'],
    },
  },
  {
    name: 'analyze_codebase',
    description:
      'USE THIS WHEN: the project has never been analyzed, or the user says the code changed ' +
      'significantly since the last run, or other tools return "no cache found". ' +
      'Builds the call graph, dependency graph, and refactor priorities — all without an LLM. ' +
      'Results are cached for 1 hour; skip this if the cache is recent.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory to analyze',
        },
        force: {
          type: 'boolean',
          description: 'Force re-analysis even if a recent cache exists (default: false)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_architecture_overview',
    description:
      'USE THIS WHEN: onboarding to an unknown codebase, or before planning a large feature. ' +
      'Returns domain clusters, cross-cluster dependencies, global entry points, and critical hubs — ' +
      'faster than reading package.json + directory tree yourself. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_refactor_report',
    description:
      'Return a prioritized list of functions that need refactoring, based on ' +
      'the cached static analysis. Issues detected: unreachable code, high fan-in ' +
      '(hub overload), high fan-out (god function), SRP violations (multi-requirement), ' +
      'and cyclic dependencies. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_call_graph',
    description:
      'Return the call graph for a project: hub functions (high fan-in), ' +
      'entry points (no internal callers), and architectural layer violations. ' +
      'Supports TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C++. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_duplicate_report',
    description:
      'Detect duplicate code (clone groups) across the codebase using pure static analysis. ' +
      'Detects Type 1 (exact clones — identical after whitespace/comment normalization), ' +
      'Type 2 (structural clones — same structure with renamed variables), and ' +
      'Type 3 (near-clones with Jaccard similarity ≥ 0.7 on token n-grams). ' +
      'No LLM calls required. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must have been analyzed first)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_signatures',
    description:
      'Return compact function and class signatures for files in a project. ' +
      'Useful for understanding a codebase\'s public API without reading full source. ' +
      'Optionally filter by file path pattern. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        filePattern: {
          type: 'string',
          description:
            'Optional substring to filter file paths (e.g. "services", "api", ".py")',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_subgraph',
    description:
      'Extract a subgraph of the call graph centred on ONE specific function. ' +
      'Call once per function — do not combine multiple function names in a single call. ' +
      'Useful for impact analysis ("what does X call?"), dependency tracing ' +
      '("who calls X?"), or understanding a change\'s blast radius. ' +
      'Prefer maxDepth 1 or 2; depth ≥ 3 on large projects may timeout. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        functionName: {
          type: 'string',
          description: 'Name of a single function to centre the subgraph on (exact name preferred; partial substring also accepted)',
        },
        direction: {
          type: 'string',
          enum: ['downstream', 'upstream', 'both'],
          description:
            'downstream = what this function calls (default), ' +
            'upstream = who calls this function, ' +
            'both = full neighbourhood',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum traversal depth (default: 3, recommended: 1–2 to avoid timeout)',
        },
        format: {
          type: 'string',
          enum: ['json', 'mermaid'],
          description: 'Output format: "json" (default) or "mermaid" flowchart diagram',
        },
      },
      required: ['directory', 'functionName'],
    },
  },
  {
    name: 'trace_execution_path',
    description:
      'USE THIS WHEN debugging: "how does request X reach function Y?", ' +
      '"which call chain produced this error?", "is there a path from A to B?". ' +
      'Finds all execution paths between two functions in the call graph (BFS/DFS, ' +
      'shortest first). Complementary to get_subgraph — use get_subgraph for ' +
      'neighbourhood exploration, trace_execution_path for point-to-point tracing.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        entryFunction: {
          type: 'string',
          description: 'Starting function name (exact or partial match)',
        },
        targetFunction: {
          type: 'string',
          description: 'Target function name (exact or partial match)',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum path length in hops (default: 6)',
        },
        maxPaths: {
          type: 'number',
          description: 'Maximum number of paths to return (default: 10, max: 50)',
        },
      },
      required: ['directory', 'entryFunction', 'targetFunction'],
    },
  },
  {
    name: 'get_mapping',
    description:
      'Return the requirement → function mapping produced by openlore generate. ' +
      'Shows which functions implement which spec requirements, confidence level ' +
      '(llm / heuristic), and orphan functions not covered by any requirement. ' +
      'Requires openlore generate to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain name (e.g. "auth", "crawler")',
        },
        orphansOnly: {
          type: 'boolean',
          description: 'Return only orphan functions (not covered by any requirement)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'check_spec_drift',
    description:
      'USE THIS WHEN: you\'ve modified code and want to know if the specs are still aligned, ' +
      'or when asked "is the code in sync with the spec?", "what changed since the last spec run?". ' +
      'Compares git-changed files against spec coverage — impossible to replicate by reading files. ' +
      'Requires openlore generate to have been run at least once. No LLM required.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory (must be a git repository)',
        },
        base: {
          type: 'string',
          description: 'Git ref to compare against (default: auto-detect main/master)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific files to check (default: all changed files)',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only check these spec domains (default: all domains)',
        },
        failOn: {
          type: 'string',
          enum: ['error', 'warning', 'info'],
          description: 'Minimum severity to report (default: "warning")',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of changed files to analyze (default: 100)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'analyze_impact',
    description:
      'USE THIS WHEN: you\'re about to modify a function and want to know the full consequences — ' +
      '"what breaks if I change X?", "what\'s the blast radius of modifying Y?". ' +
      'Returns fan-in/out, full call chains, risk score (0–100), and refactoring strategy. ' +
      'Call this before touching any non-trivial function. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        symbol: {
          type: 'string',
          description: 'Function or method name to analyse (exact or partial match)',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth for upstream/downstream chains (default: 2)',
        },
      },
      required: ['directory', 'symbol'],
    },
  },
  {
    name: 'get_low_risk_refactor_candidates',
    description:
      'Return the safest functions to refactor first: low fan-in (few callers), ' +
      'low fan-out (few dependencies), no cyclic involvement, not a hub. ' +
      'Ideal starting point for incremental, low-risk refactoring sessions. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of candidates to return (default: 5)',
        },
        filePattern: {
          type: 'string',
          description: 'Optional substring to restrict candidates to matching file paths',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_leaf_functions',
    description:
      'Return functions that make no internal calls (leaves of the call graph). ' +
      'These are the safest refactoring targets: self-contained, easy to unit-test, ' +
      'zero downstream blast radius. Best entry point for bottom-up refactoring. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 20)',
        },
        filePattern: {
          type: 'string',
          description: 'Optional substring to restrict results to matching file paths',
        },
        sortBy: {
          type: 'string',
          enum: ['fanIn', 'name', 'file'],
          description:
            'Sort order: "fanIn" (most-called leaves first, default), "name", or "file"',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_critical_hubs',
    description:
      'Return the highest-impact hub functions: high fan-in (many callers depend on them), ' +
      'possibly high fan-out (god functions). These require the most careful, incremental ' +
      'refactoring with broad test coverage. Includes a stability score and recommended ' +
      'approach (extract, split, facade, delegate). Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of hubs to return (default: 10)',
        },
        minFanIn: {
          type: 'number',
          description: 'Minimum fan-in threshold to be considered a hub (default: 3)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_function_skeleton',
    description:
      'Return a noise-stripped skeleton of a source file: logs, inline comments, and ' +
      'non-JSDoc block comments are removed while signatures, control flow (if/for/try), ' +
      'return/throw statements, and call expressions are preserved. ' +
      'Use this before refactoring a god function to get a compact structural view ' +
      'without reading thousands of lines of raw source.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        filePath: {
          type: 'string',
          description: 'Path to the file, relative to the project directory',
        },
      },
      required: ['directory', 'filePath'],
    },
  },
  {
    name: 'get_god_functions',
    description:
      'Detect god functions (high fan-out, likely orchestrators) in the project or in a ' +
      'specific file, and return their call-graph neighborhood. ' +
      'Use this to identify which functions need to be refactored and understand what ' +
      'logical blocks to extract. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        filePath: {
          type: 'string',
          description: 'Optional: restrict search to this file (relative path)',
        },
        fanOutThreshold: {
          type: 'number',
          description: 'Minimum fan-out to be considered a god function (default: 8)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'suggest_insertion_points',
    description:
      'USE THIS WHEN: you need to find where to implement a new feature — ' +
      '"where should I add rate limiting?", "where\'s the best place to add email validation?". ' +
      'Combines semantic search + call graph to return ranked candidates with strategy. ' +
      'Call this before writing any code; then use get_subgraph on the top candidates. ' +
      'Requires "openlore analyze --embed".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        description: {
          type: 'string',
          description:
            'Natural language description of the feature to implement, ' +
            'e.g. "add retry mechanism for HTTP requests" or "validate user email on registration"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of candidates to return (default: 5)',
        },
        language: {
          type: 'string',
          description: 'Filter by language: "TypeScript", "Python", "Go", "Rust", "Ruby", "Java"',
        },
      },
      required: ['directory', 'description'],
    },
  },
  {
    name: 'search_code',
    description:
      'USE THIS WHEN: you don\'t know which file or function handles a concept — ' +
      '"where is rate limiting implemented?", "which function validates tokens?", ' +
      '"what handles authentication?". Beats grep when the function name is unknown. ' +
      'Falls back to keyword search automatically if the embedding server is down. ' +
      'Requires "openlore analyze --embed" to have been run at least once.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "authenticate user with JWT"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        language: {
          type: 'string',
          description: 'Filter by language: "TypeScript", "Python", "Go", "Rust", "Ruby", "Java"',
        },
        minFanIn: {
          type: 'number',
          description: 'Only return functions with at least this many callers (hub filter)',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'list_spec_domains',
    description:
      'List all OpenSpec domains available in this project. ' +
      'Use this first when you need to discover what domains exist before doing a targeted search_specs call.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'search_specs',
    description:
      'USE THIS WHEN: asked "which spec covers X?", "what does the spec say about Y?", ' +
      '"which requirement describes Z?". Searches specs by meaning and returns linked source files. ' +
      'Use spec-first: check what the spec says before reading or writing code. ' +
      'Requires "openlore analyze --embed" or "openlore analyze --reindex-specs".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "email validation workflow"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        domain: {
          type: 'string',
          description: 'Filter by domain name (e.g. "auth", "analyzer")',
        },
        section: {
          type: 'string',
          description: 'Filter by section type: "requirements", "purpose", "design", "architecture", "entities"',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'search_unified',
    description:
      'USE THIS WHEN: you want to find where something is implemented AND what the spec says about it ' +
      'in a single call. Searches both code functions and spec requirements simultaneously, then ' +
      'cross-boosts results that are linked through mapping.json — so a function that implements a ' +
      'matching requirement ranks higher than one found by code search alone. ' +
      'Returns results with type "code", "spec", or "both" and a mappingBoost score. ' +
      'Requires "openlore analyze --embed" and a prior "openlore generate" run.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        query: {
          type: 'string',
          description: 'Natural language query, e.g. "validate user authentication"',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        language: {
          type: 'string',
          description: 'Filter code results by language (e.g. "TypeScript")',
        },
        domain: {
          type: 'string',
          description: 'Filter spec results by domain name',
        },
        section: {
          type: 'string',
          description: 'Filter spec results by section type: "requirements", "purpose", etc.',
        },
      },
      required: ['directory', 'query'],
    },
  },
  {
    name: 'get_spec',
    description:
      'Return the full content of a spec domain\'s specification file (spec.md) and the ' +
      'functions that implement it. Use this to read requirements directly when you know the ' +
      'domain name. Complements search_specs (which searches by meaning) by giving exact ' +
      'read access to a known domain.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        domain: {
          type: 'string',
          description: 'Domain name as returned by list_spec_domains (e.g. "auth", "analyzer")',
        },
      },
      required: ['directory', 'domain'],
    },
  },
  {
    name: 'get_function_body',
    description:
      'Return the exact source code of a named function in a file. ' +
      'Use this after search_code or get_function_skeleton to read the full implementation. ' +
      'Requires a prior "openlore analyze" run for precise byte-range extraction; ' +
      'falls back to a brace-depth scan when the call graph is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        filePath: {
          type: 'string',
          description: 'File path relative to the project directory, e.g. "src/auth/jwt.ts"',
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to extract, e.g. "verifyToken"',
        },
      },
      required: ['directory', 'filePath', 'functionName'],
    },
  },
  {
    name: 'get_file_dependencies',
    description:
      'Return the file-level import dependencies for a given source file. ' +
      'Answers "what does this file import?" and "what files import this file?". ' +
      'Useful for planning refactors, understanding coupling, or scoping the blast radius ' +
      'of a change. Reads the dependency-graph.json produced by "openlore analyze".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        filePath: {
          type: 'string',
          description: 'File path relative to the project root, e.g. "src/core/analyzer/vector-index.ts"',
        },
        direction: {
          type: 'string',
          enum: ['imports', 'importedBy', 'both'],
          description: '"imports" = what this file depends on, "importedBy" = what depends on this file, "both" = both directions (default)',
        },
      },
      required: ['directory', 'filePath'],
    },
  },
  {
    name: 'generate_change_proposal',
    description:
      'USE THIS WHEN: you have a BMAD story, a feature description, or a spec delta request, ' +
      'and want to create a structured OpenSpec change proposal before writing any code. ' +
      'Combines orient + search_specs + analyze_impact to produce a pre-filled ' +
      'openspec/changes/{slug}/proposal.md — no LLM required. ' +
      'Output includes affected domains, touched requirements, risk scores, and insertion points. ' +
      'Run analyze_codebase first; spec index optional (degrades gracefully).',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        description: {
          type: 'string',
          description:
            'Intent of the change — story title + primary AC, or a free-form feature description. ' +
            'e.g. "add retry logic to payment processing — must retry up to 3 times on timeout"',
        },
        slug: {
          type: 'string',
          description:
            'Change identifier used as the directory name, e.g. "add-payment-retry". ' +
            'Will be lowercased and hyphenated automatically.',
        },
        storyContent: {
          type: 'string',
          description:
            'Optional: full BMAD story content (markdown). If provided, it is embedded verbatim ' +
            'in the proposal for traceability.',
        },
      },
      required: ['directory', 'description', 'slug'],
    },
  },
  {
    name: 'annotate_story',
    description:
      'USE THIS WHEN: you have a BMAD story file and want to auto-populate its risk_context ' +
      'section with structural analysis from the codebase. ' +
      'Reads the story file, runs orient + analyze_impact, writes the risk_context block ' +
      'directly into the file (replaces existing section or inserts it). ' +
      'Run by the Architect Agent after writing stories — eliminates manual copy-paste of ' +
      'generate_change_proposal output. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        storyFilePath: {
          type: 'string',
          description:
            'Path to the BMAD story markdown file — relative to the project directory ' +
            'or absolute. e.g. ".bmad-method/stories/001-add-payment-retry.md"',
        },
        description: {
          type: 'string',
          description:
            'Story intent for structural analysis — use story title + primary AC. ' +
            'e.g. "add payment retry — must retry up to 3 times on timeout"',
        },
      },
      required: ['directory', 'storyFilePath', 'description'],
    },
  },
  {
    name: 'get_decisions',
    description:
      'List or search Architecture Decision Records (ADRs) stored in openspec/decisions/. ' +
      'Use this when you need to understand why an architectural decision was made, ' +
      'or to check whether a pattern is already documented. ' +
      'ADRs are generated by "openlore generate --adrs".',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        query: {
          type: 'string',
          description: 'Optional text filter — returns only ADRs whose title or content contains this string',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_route_inventory',
    description:
      'Return the full HTTP/API route inventory for the project: total count, breakdown by ' +
      'HTTP method and framework, and the list of individual routes with method, path, ' +
      'framework, source file, and handler name. ' +
      'Reads the pre-computed route-inventory.json artifact when available (runs in < 1 ms), ' +
      'otherwise scans source files live. ' +
      'Supports Express, Hono, Fastify, NestJS, Next.js App Router, FastAPI, Flask, Django, and more. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_middleware_inventory',
    description:
      'Return the middleware inventory for the project: all detected middleware entries with ' +
      'type (auth, cors, rate-limit, validation, logging, error-handler, custom), framework, ' +
      'source file, line number, and name. ' +
      'Reads the pre-computed middleware-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports Express, Hono, Fastify, NestJS, Next.js, and more. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_schema_inventory',
    description:
      'Return the database schema inventory for the project: all detected ORM model/table ' +
      'definitions with their fields, types, and nullability. ' +
      'Reads the pre-computed schema-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports Prisma, TypeORM, Drizzle ORM, and SQLAlchemy. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_ui_components',
    description:
      'Return the UI component inventory for the project: all detected components with ' +
      'their framework, props, source file, and line number. ' +
      'Reads the pre-computed ui-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports React, Vue, Svelte, and Angular. ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_env_vars',
    description:
      'Return all environment variables referenced in the project: names, which files use them, ' +
      'whether they have a known default (from .env.example), and whether they are required ' +
      '(used without a fallback in source code). ' +
      'Reads the pre-computed env-inventory.json artifact when available, ' +
      'otherwise scans source files live. ' +
      'Supports JS/TS (process.env), Python (os.environ/os.getenv), Go (os.Getenv), Ruby (ENV[]). ' +
      'Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_external_packages',
    description:
      'Return all direct external dependencies declared in package manifests: ' +
      'package.json (npm), pyproject.toml / requirements.txt (pypi), Cargo.toml (cargo), go.mod (go). ' +
      'Each entry includes name, version, ecosystem, and isDev flag. ' +
      'Reads the pre-computed external-packages.json artifact when available, ' +
      'otherwise scans manifests live. Run analyze_codebase first for the fastest results.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
      },
      required: ['directory'],
    },
  },
  {
    name: 'audit_spec_coverage',
    description:
      'Parity audit: report spec coverage gaps without any LLM call. ' +
      'Returns uncovered functions (exist in call graph but have no spec), ' +
      'hub gaps (high fan-in functions with no spec), ' +
      'orphan requirements (spec requirements with no mapped implementation), ' +
      'and stale domains (source files changed after spec was last written). ' +
      'Use this before starting a new feature to understand what needs specs, ' +
      'or to audit coverage health. Requires "openlore analyze" to have been run.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        maxUncovered: {
          type: 'number',
          description: 'Maximum uncovered functions to return (default: 50)',
        },
        hubThreshold: {
          type: 'number',
          description: 'Minimum fanIn to flag a function as a hub gap (default: 5)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'generate_tests',
    description:
      'Generate spec-driven test files from OpenSpec scenarios. ' +
      'Supports vitest, playwright, pytest (Python), gtest and catch2 (C++). ' +
      'A THEN clause pattern engine emits real assertions for common patterns ' +
      '(HTTP status codes, property presence, error messages) without any LLM call. ' +
      'Pass useLlm:true to enrich unmatched clauses using mapped function source. ' +
      'Each generated test is tagged with a parseable openlore: metadata comment ' +
      'that enables spec coverage tracking via get_test_coverage. ' +
      'Defaults to dryRun:true — set dryRun:false to write files to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only generate tests for these spec domains (omit for all)',
        },
        framework: {
          type: 'string',
          enum: ['vitest', 'playwright', 'pytest', 'gtest', 'catch2', 'auto'],
          description: 'Test framework (default: auto-detect from project files)',
        },
        useLlm: {
          type: 'boolean',
          description: 'Use LLM to fill in assertions the pattern engine cannot match',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview generated content without writing files (default: true)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_test_coverage',
    description:
      'Report which OpenSpec scenarios have corresponding test coverage. ' +
      'Scans test files for // openlore: {JSON} or # openlore: {JSON} metadata tags ' +
      '(added automatically by generate_tests). ' +
      'Returns coverage percentage by domain, a list of uncovered scenarios, ' +
      'and flags domains where spec drift was detected. ' +
      'Use minCoverage to enforce a CI coverage gate.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Absolute path to the project directory',
        },
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only check these spec domains (omit for all)',
        },
        minCoverage: {
          type: 'number',
          description: 'Report belowThreshold:true if effective coverage is below this percentage',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'get_minimal_context',
    description:
      'Return the minimum context needed to safely modify a function: ' +
      'its signature and body, direct callers (signatures only), direct callees (signatures only), ' +
      'and which test files cover it. ' +
      'Use this instead of orient when you already know exactly which function to modify. ' +
      'Typically 200-600 tokens vs orient\'s 2000+. Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        functionName: { type: 'string', description: 'Exact function or method name' },
        filePath: {
          type: 'string',
          description: 'Optional relative file path to disambiguate when multiple functions share the name',
        },
      },
      required: ['directory', 'functionName'],
    },
  },
  {
    name: 'get_cluster',
    description:
      'Return all functions in the same community as the given function. ' +
      'Communities are computed via label propagation on the call graph at analyze time — ' +
      'tightly coupled functions land in the same cluster regardless of directory. ' +
      'Use this to understand the "blast radius neighbourhood" without traversing the graph manually. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        functionName: { type: 'string', description: 'Function name to look up the community for' },
      },
      required: ['directory', 'functionName'],
    },
  },
  {
    name: 'detect_changes',
    description:
      'Detect recently changed functions and rank them by blast radius. ' +
      'Runs git diff against a base ref (default HEAD), maps changed lines to function nodes, ' +
      'then scores each changed function by fan-in + transitive callers. ' +
      'Highest-scored functions are the riskiest to break. ' +
      'Also reports test coverage for each changed function via tested_by edges. ' +
      'Run analyze_codebase first.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        base: {
          type: 'string',
          description: 'Git ref to diff against (default: HEAD). Use "HEAD~1" for last commit, "main" for branch diff.',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'record_decision',
    description:
      'Record an architectural decision made during the current development session. ' +
      'Call this whenever you make a significant design choice: choosing a data structure, ' +
      'picking a library, defining an API contract, selecting an auth strategy, etc. ' +
      'Decisions are stored as drafts and consolidated before the next commit. ' +
      'Use the supersedes field when a later decision replaces an earlier one.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        title: { type: 'string', description: 'Short imperative statement, e.g. "Use UUIDs for decision IDs"' },
        rationale: { type: 'string', description: 'Why this decision was made' },
        consequences: { type: 'string', description: 'What changes as a result (optional)' },
        affectedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Source files most relevant to this decision (optional)',
        },
        supersedes: {
          type: 'string',
          description: 'ID of a prior decision this one replaces (optional)',
        },
        scope: {
          type: 'string',
          enum: ['local', 'component', 'cross-domain', 'system'],
          description: 'Decision scope. local: single file; component: single module/service; cross-domain: multiple spec domains or service contracts; system: global constraint. Only cross-domain and system generate ADR files. Defaults to component; auto-promoted to cross-domain when multiple domains inferred.',
        },
      },
      required: ['directory', 'title', 'rationale'],
    },
  },
  {
    name: 'list_decisions',
    description:
      'List architectural decisions recorded during the current session. ' +
      'Shows draft, consolidated, verified, approved, rejected, and synced decisions. ' +
      'Use approve_decision or reject_decision to act on verified decisions, ' +
      'then sync_decisions to write them to spec.md files.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        status: {
          type: 'string',
          enum: ['draft', 'consolidated', 'verified', 'phantom', 'approved', 'rejected', 'synced'],
          description: 'Filter by status (default: returns all)',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'approve_decision',
    description:
      '⚠ REQUIRES EXPLICIT HUMAN AUTHORIZATION — do NOT call this tool autonomously. ' +
      'Before calling, you MUST present the decision to the user and receive an explicit ' +
      '"yes" or "approve" response. Never approve on behalf of the user. ' +
      'Approves a verified architectural decision for syncing into spec.md files. ' +
      'After approving, call sync_decisions to write the decision to the relevant spec.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        id: { type: 'string', description: '8-character decision ID from list_decisions' },
        note: { type: 'string', description: 'Optional review note' },
      },
      required: ['directory', 'id'],
    },
  },
  {
    name: 'reject_decision',
    description:
      'Reject a pending decision. Rejected decisions are never synced to spec files.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        id: { type: 'string', description: '8-character decision ID from list_decisions' },
        note: { type: 'string', description: 'Optional reason for rejection' },
      },
      required: ['directory', 'id'],
    },
  },
  {
    name: 'sync_decisions',
    description:
      'Write all approved decisions into their target spec.md files. ' +
      'Appends new Requirement blocks and Decision sections (append-only, never overwrites). ' +
      'Creates ADR files in openspec/decisions/ for architectural decisions. ' +
      'Pass dryRun=true to preview without writing. ' +
      'Pass id to sync a single decision by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Absolute path to the project directory' },
        dryRun: { type: 'boolean', description: 'Preview without writing files (default: false)' },
        id: { type: 'string', description: 'Sync only this specific decision ID (default: all approved)' },
      },
      required: ['directory'],
    },
  },
];

// ============================================================================
// MCP SERVER
// ============================================================================

// Annotations improve Tool Search relevance in Claude Code (BM25/regex ranking).
// RO = read-only queries, RW_I = writes but idempotent, RW = non-idempotent writes.
const _RO  = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true  } as const;
const _RWI = { readOnlyHint: false, destructiveHint: false, idempotentHint: true  } as const;
const _RW  = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;

const TOOL_ANNOTATIONS: Record<string, typeof _RO | typeof _RWI | typeof _RW> = {
  orient: _RO, analyze_codebase: _RWI, get_architecture_overview: _RO,
  get_refactor_report: _RO, get_call_graph: _RO, get_duplicate_report: _RO,
  get_signatures: _RO, get_subgraph: _RO, trace_execution_path: _RO,
  get_mapping: _RO, check_spec_drift: _RO, analyze_impact: _RO,
  get_low_risk_refactor_candidates: _RO, get_leaf_functions: _RO,
  get_critical_hubs: _RO, get_function_skeleton: _RO, get_god_functions: _RO,
  suggest_insertion_points: _RO, search_code: _RO, list_spec_domains: _RO,
  search_specs: _RO, search_unified: _RO, get_spec: _RO, get_function_body: _RO,
  get_file_dependencies: _RO, generate_change_proposal: _RW, annotate_story: _RW,
  get_decisions: _RO, get_route_inventory: _RO, get_middleware_inventory: _RO,
  get_schema_inventory: _RO, get_ui_components: _RO, get_env_vars: _RO,
  get_external_packages: _RO, audit_spec_coverage: _RO, generate_tests: _RW,
  get_test_coverage: _RO, get_minimal_context: _RO, get_cluster: _RO,
  detect_changes: _RO, record_decision: _RW, list_decisions: _RO,
  approve_decision: _RWI, reject_decision: _RWI, sync_decisions: _RWI,
};

const MINIMAL_TOOLS = new Set([
  'orient', 'search_code', 'record_decision', 'detect_changes', 'check_spec_drift',
]);

interface McpServerOptions {
  watch?: string;
  watchAuto?: boolean;
  watchDebounce?: string;
  minimal?: boolean;
}

async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const activeTools = options.minimal
    ? TOOL_DEFINITIONS.filter(t => MINIMAL_TOOLS.has(t.name))
    : TOOL_DEFINITIONS;

  const server = new Server(
    { name: 'openlore', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: activeTools.map(t => ({ ...t, annotations: TOOL_ANNOTATIONS[t.name] })),
  }));

  // Per-session epistemic lease tracker — re-initialized when directory changes.
  let tracker: EpistemicTracker | undefined;
  let trackerDir = '';
  let panicPolicy: PanicResponseMode = 'off';

  // --watch-auto: start the watcher on the first tool call that carries a directory
  let autoWatcher: import('../../core/services/mcp-watcher.js').McpWatcher | undefined;

  // Agent identity captured from initialize handshake
  let agentName = 'unknown';
  let agentVersion = 'unknown';
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    agentName = request.params.clientInfo?.name ?? 'unknown';
    agentVersion = request.params.clientInfo?.version ?? 'unknown';
    return {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'openlore', version: _pkgVersion },
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (options.watchAuto && !autoWatcher) {
      const dir = (args as Record<string, unknown>).directory;
      if (typeof dir === 'string') {
        const { resolve } = await import('node:path');
        const { McpWatcher } = await import('../../core/services/mcp-watcher.js');
        const debounceMs = parseInt(options.watchDebounce ?? '400', 10);
        autoWatcher = new McpWatcher({
          rootPath: resolve(dir),
          debounceMs: isNaN(debounceMs) ? 400 : debounceMs,
        });
        await autoWatcher.start();
        const cleanup = () => autoWatcher!.stop().then(() => process.exit(0));
        process.on('SIGINT',  cleanup);
        process.on('SIGTERM', cleanup);
      }
    }

    const _dir = (args as Record<string, unknown>).directory;
    const directory = typeof _dir === 'string' ? _dir : '';
    const _t0 = Date.now();

    try {
      const filePath = (args as Record<string, unknown>).filePath;

      // Init (or re-init when project directory changes between calls)
      if (directory && (!tracker || directory !== trackerDir)) {
        tracker = createTracker(directory);
        trackerDir = directory;
        const cfg = await readOpenLoreConfig(directory);
        panicPolicy = cfg?.panicResponse?.mode ?? 'off';
        if (panicPolicy !== 'off') {
          emit(directory, 'panic-response', { event: 'panic_mode_active', mode: panicPolicy });
        }
      }
      // Update epistemic state before dispatch (orient resets tracker internally).
      // Invariant: only MCP tool calls (this path) feed panic. CLI commands (panic-check,
      // telemetry) are separate processes that read state but never call updateTracker —
      // no recursive panic feedback loop from openlore internal commands.
      if (tracker && directory && panicPolicy !== 'off') {
        updateTracker(tracker, name, directory, typeof filePath === 'string' ? filePath : undefined);
        updatePanic(tracker, {
          density: tracker.density,
          oscillation: tracker.oscillation,
          weight: 1,  // weight read from TOOL_WEIGHTS inside updatePanic via opts — set baseline here
          staleDepth: tracker.staleDepth,
          directory,
          tool: name,
        });
        writePanicState(directory, trackerToPanicState(tracker, agentName));
      }

      let result: unknown;

      if (name === 'orient') {
        const { task, limit = 5 } = args as { task: string; limit?: number };
        result = await handleOrient(directory, task, limit);
        if (result && typeof result === 'object') {
          const r = result as Record<string, unknown>;
          emit(directory, 'orient', {
            event: 'orient_call',
            agent: agentName,
            functions: Array.isArray(r['relevantFunctions']) ? r['relevantFunctions'].length : 0,
            files: Array.isArray(r['relevantFiles']) ? r['relevantFiles'].length : 0,
            spec_domains: Array.isArray(r['specDomains']) ? r['specDomains'].length : 0,
            insertion_points: Array.isArray(r['insertionPoints']) ? r['insertionPoints'].length : 0,
          });
        }
      } else if (name === 'analyze_codebase') {
        const { directory, force = false } = args as { directory: string; force?: boolean };
        result = await handleAnalyzeCodebase(directory, force);
      } else if (name === 'get_architecture_overview') {
        const { directory } = args as { directory: string };
        result = await handleGetArchitectureOverview(directory);
      } else if (name === 'get_refactor_report') {
        const { directory } = args as { directory: string };
        result = await handleGetRefactorReport(directory);
      } else if (name === 'get_call_graph') {
        const { directory } = args as { directory: string };
        result = await handleGetCallGraph(directory);
      } else if (name === 'get_signatures') {
        const { directory, filePattern } = args as { directory: string; filePattern?: string };
        result = await handleGetSignatures(directory, filePattern);
      } else if (name === 'get_subgraph') {
        const { directory, functionName, direction = 'downstream', maxDepth = 3, format = 'json' } =
          args as { directory: string; functionName: string; direction?: 'downstream' | 'upstream' | 'both'; maxDepth?: number; format?: 'json' | 'mermaid' };
        result = await handleGetSubgraph(directory, functionName, direction, maxDepth, format);
      } else if (name === 'trace_execution_path') {
        const { directory, entryFunction, targetFunction, maxDepth = 6, maxPaths = 10 } =
          args as { directory: string; entryFunction: string; targetFunction: string; maxDepth?: number; maxPaths?: number };
        result = await handleTraceExecutionPath(directory, entryFunction, targetFunction, maxDepth, maxPaths);
      } else if (name === 'get_mapping') {
        const { directory, domain, orphansOnly } = args as { directory: string; domain?: string; orphansOnly?: boolean };
        result = await handleGetMapping(directory, domain, orphansOnly);
      } else if (name === 'analyze_impact') {
        const { directory, symbol, depth = 2 } =
          args as { directory: string; symbol: string; depth?: number };
        result = await handleAnalyzeImpact(directory, symbol, depth);
      } else if (name === 'get_low_risk_refactor_candidates') {
        const { directory, limit = 5, filePattern } =
          args as { directory: string; limit?: number; filePattern?: string };
        result = await handleGetLowRiskRefactorCandidates(directory, limit, filePattern);
      } else if (name === 'get_leaf_functions') {
        const { directory, limit = 20, filePattern, sortBy = 'fanIn' } =
          args as { directory: string; limit?: number; filePattern?: string; sortBy?: 'fanIn' | 'name' | 'file' };
        result = await handleGetLeafFunctions(directory, limit, filePattern, sortBy);
      } else if (name === 'get_critical_hubs') {
        const { directory, limit = 10, minFanIn = 3 } =
          args as { directory: string; limit?: number; minFanIn?: number };
        result = await handleGetCriticalHubs(directory, limit, minFanIn);
      } else if (name === 'get_duplicate_report') {
        const { directory } = args as { directory: string };
        result = await handleGetDuplicateReport(directory);
      } else if (name === 'get_function_skeleton') {
        const { directory, filePath } = args as { directory: string; filePath: string };
        result = await handleGetFunctionSkeleton(directory, filePath);
      } else if (name === 'get_god_functions') {
        const { directory, filePath, fanOutThreshold = 8 } =
          args as { directory: string; filePath?: string; fanOutThreshold?: number };
        result = await handleGetGodFunctions(directory, filePath, fanOutThreshold);
      } else if (name === 'check_spec_drift') {
        const { directory, base = 'auto', files = [], domains = [], failOn = 'warning', maxFiles = DEFAULT_DRIFT_MAX_FILES } =
          args as { directory: string; base?: string; files?: string[]; domains?: string[]; failOn?: 'error' | 'warning' | 'info'; maxFiles?: number };
        result = await handleCheckSpecDrift(directory, base, files, domains, failOn, maxFiles);
      } else if (name === 'search_code') {
        const { directory, query, limit = 10, language, minFanIn } =
          args as { directory: string; query: string; limit?: number; language?: string; minFanIn?: number };
        result = await handleSearchCode(directory, query, limit, language, minFanIn);
      } else if (name === 'suggest_insertion_points') {
        const { directory, description, limit = 5, language } =
          args as { directory: string; description: string; limit?: number; language?: string };
        result = await handleSuggestInsertionPoints(directory, description, limit, language);
      } else if (name === 'search_specs') {
        const { directory, query, limit = 10, domain, section } =
          args as { directory: string; query: string; limit?: number; domain?: string; section?: string };
        result = await handleSearchSpecs(directory, query, limit, domain, section);
      } else if (name === 'search_unified') {
        const { directory, query, limit = 10, language, domain, section } =
          args as { directory: string; query: string; limit?: number; language?: string; domain?: string; section?: string };
        result = await handleUnifiedSearch(directory, query, limit, language, domain, section);
      } else if (name === 'list_spec_domains') {
        const { directory } = args as { directory: string };
        result = await handleListSpecDomains(directory);
      } else if (name === 'get_spec') {
        const { directory, domain } = args as { directory: string; domain: string };
        result = await handleGetSpec(directory, domain);
      } else if (name === 'get_function_body') {
        const { directory, filePath, functionName } =
          args as { directory: string; filePath: string; functionName: string };
        result = await handleGetFunctionBody(directory, filePath, functionName);
      } else if (name === 'get_file_dependencies') {
        const { directory, filePath, direction = 'both' } =
          args as { directory: string; filePath: string; direction?: 'imports' | 'importedBy' | 'both' };
        result = await handleGetFileDependencies(directory, filePath, direction);
      } else if (name === 'generate_change_proposal') {
        const { directory, description, slug, storyContent } =
          args as { directory: string; description: string; slug: string; storyContent?: string };
        result = await handleGenerateChangeProposal(directory, description, slug, storyContent);
      } else if (name === 'annotate_story') {
        const { directory, storyFilePath, description } =
          args as { directory: string; storyFilePath: string; description: string };
        result = await handleAnnotateStory(directory, storyFilePath, description);
      } else if (name === 'get_decisions') {
        const { directory, query } = args as { directory: string; query?: string };
        result = await handleGetDecisions(directory, query);
      } else if (name === 'get_route_inventory') {
        const { directory } = args as { directory: string };
        result = await handleGetRouteInventory(directory);
      } else if (name === 'get_middleware_inventory') {
        const { directory } = args as { directory: string };
        result = await handleGetMiddlewareInventory(directory);
      } else if (name === 'get_schema_inventory') {
        const { directory } = args as { directory: string };
        result = await handleGetSchemaInventory(directory);
      } else if (name === 'get_ui_components') {
        const { directory } = args as { directory: string };
        result = await handleGetUIComponents(directory);
      } else if (name === 'get_env_vars') {
        const { directory } = args as { directory: string };
        result = await handleGetEnvVars(directory);
      } else if (name === 'get_external_packages') {
        const { directory } = args as { directory: string };
        result = await handleGetExternalPackages(directory);
      } else if (name === 'audit_spec_coverage') {
        const { directory, maxUncovered = 50, hubThreshold = 5 } =
          args as { directory: string; maxUncovered?: number; hubThreshold?: number };
        result = await handleAuditSpecCoverage(directory, maxUncovered, hubThreshold);
      } else if (name === 'generate_tests') {
        const { directory, domains, framework, useLlm, dryRun } =
          args as {
            directory: string;
            domains?: string[];
            framework?: string;
            useLlm?: boolean;
            dryRun?: boolean;
          };
        result = await handleGenerateTests({ directory, domains, framework, useLlm, dryRun });
      } else if (name === 'get_test_coverage') {
        const { directory, domains, minCoverage } =
          args as { directory: string; domains?: string[]; minCoverage?: number };
        result = await handleGetTestCoverage({ directory, domains, minCoverage });
      } else if (name === 'get_minimal_context') {
        const { directory, functionName, filePath } =
          args as { directory: string; functionName: string; filePath?: string };
        result = await handleGetMinimalContext(directory, functionName, filePath);
      } else if (name === 'get_cluster') {
        const { directory, functionName } = args as { directory: string; functionName: string };
        result = await handleGetCluster(directory, functionName);
      } else if (name === 'detect_changes') {
        const { directory, base } = args as { directory: string; base?: string };
        result = await handleDetectChanges(directory, base);
      } else if (name === 'record_decision') {
        const { directory, title, rationale, consequences, affectedFiles, supersedes, scope } =
          args as { directory: string; title: string; rationale: string; consequences?: string; affectedFiles?: string[]; supersedes?: string; scope?: import('../../types/index.js').DecisionScope };
        result = await handleRecordDecision(directory, title, rationale, consequences, affectedFiles, supersedes, scope);
      } else if (name === 'list_decisions') {
        const { directory, status } = args as { directory: string; status?: string };
        result = await handleListDecisions(directory, status);
      } else if (name === 'approve_decision') {
        const { directory, id, note } = args as { directory: string; id: string; note?: string };
        result = await handleApproveDecision(directory, id, note);
      } else if (name === 'reject_decision') {
        const { directory, id, note } = args as { directory: string; id: string; note?: string };
        result = await handleRejectDecision(directory, id, note);
      } else if (name === 'sync_decisions') {
        const { directory, dryRun = false, id } = args as { directory: string; dryRun?: boolean; id?: string };
        result = await handleSyncDecisions(directory, dryRun, id);
      } else {
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }

      emit(directory, 'mcp', {
        event: 'tool_call', tool: name, ms: Date.now() - _t0, agent: agentName, agent_version: agentVersion,
        panic_level: tracker?.panicLevel ?? 0,
        panic_score: tracker?.panicScore ?? 0,
      });

      const text =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      const signal = tracker ? getFreshnessSignal(tracker) : null;

      // Both freshness and panic signals are separate content items — never
      // concatenated into the result body — so structured outputs (JSON, patches)
      // are not corrupted. Panic signal always appended (after result).
      const content: Array<{ type: 'text'; text: string }> = [];
      if (signal?.prepend) content.push({ type: 'text', text: signal.text });
      content.push({ type: 'text', text });
      if (signal && !signal.prepend) content.push({ type: 'text', text: signal.text });

      if (tracker && (panicPolicy === 'advisory' || panicPolicy === 'experimental_blocking')) {
        const panicState = trackerToPanicState(tracker, agentName);
        const panicText = getPanicSignalText(panicState);
        if (panicText) {
          content.push({ type: 'text', text: panicText });
          tracker.interventionCountSinceStable++;
          writePanicState(directory, trackerToPanicState(tracker, agentName));
          emit(directory, 'panic', {
            event: 'panic_signal_injected',
            panic_level: tracker.panicLevel,
            panic_score: tracker.panicScore,
            intervention_count: tracker.interventionCountSinceStable,
            directive_mode: tracker.interventionCountSinceStable >= 3,
            tool: name,
            agent: agentName,
          });
        }
      }

      return { content };
    } catch (err) {
      emit(directory, 'mcp', { event: 'tool_error', tool: name, ms: Date.now() - _t0, agent: agentName, error: sanitizeMcpError(err) });
      return {
        content: [{ type: 'text', text: `Tool error: ${sanitizeMcpError(err)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (options.watch) {
    const { resolve } = await import('node:path');
    const { McpWatcher } = await import('../../core/services/mcp-watcher.js');
    const debounceMs = parseInt(options.watchDebounce ?? '400', 10);
    const watcher = new McpWatcher({
      rootPath: resolve(options.watch),
      debounceMs: isNaN(debounceMs) ? 400 : debounceMs,
    });
    await watcher.start();
    const cleanup = () => watcher.stop().then(() => process.exit(0));
    process.on('SIGINT',  cleanup);
    process.on('SIGTERM', cleanup);
  }
}

// ============================================================================
// COMMAND EXPORT
// ============================================================================

export const mcpCommand = new Command('mcp')
  .description('Start openlore as an MCP server (stdio transport, for Cline/Claude Code)')
  .option('--watch <directory>', 'Watch a project directory and incrementally re-index signatures on file changes')
  .option('--watch-auto', 'Auto-detect the project directory from the first tool call and start watching', true)
  .option('--watch-debounce <ms>', 'Debounce delay in ms before re-indexing after a file change (default: 400)', '400')
  .option('--minimal', 'Expose only core 5 tools (orient, search_code, record_decision, detect_changes, check_spec_drift). Pair with alwaysLoad: true in Claude Code for always-visible core tools.')
  .action((options: McpServerOptions) => startMcpServer(options));
