#!/usr/bin/env node

/**
 * openlore CLI entry point
 *
 * Reverse-engineer OpenSpec specifications from existing codebases.
 * Philosophy: "Archaeology over Creativity" — Extract the truth of what code does.
 */

import { Command } from 'commander';
import { createRequire } from 'node:module';
import { initCommand } from './commands/init.js';
import { analyzeCommand } from './commands/analyze.js';
import { generateCommand } from './commands/generate.js';
import { verifyCommand } from './commands/verify.js';
import { driftCommand } from './commands/drift.js';
import { runCommand } from './commands/run.js';
import { mcpCommand } from './commands/mcp.js';
import { viewCommand } from './commands/view.js';
import { doctorCommand } from './commands/doctor.js';
import { setupCommand } from './commands/setup.js';
import { refreshStoriesCommand } from './commands/refresh-stories.js';
import { auditCommand } from './commands/audit.js';
import { testCommand } from './commands/test.js';
import { digestCommand } from './commands/digest.js';
import { decisionsCommand } from './commands/decisions.js';
import { telemetryCommand } from './commands/telemetry.js';
import { panicCheckCommand } from './commands/panic-check.js';
import { configureLogger } from '../utils/logger.js';

// Read version from package.json at runtime so it never drifts from the published version
const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const program = new Command();

// Hook to configure logger before any command runs
program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.opts();

  configureLogger({
    quiet: opts.quiet ?? false,
    verbose: opts.verbose ?? false,
    noColor: opts.color === false,
    timestamps: process.env.CI === 'true' || opts.color === false,
  });

  // Warn when SSL verification is disabled — it's a security trade-off
  if (opts.insecure) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    // Only print if we're not in quiet mode
    if (!opts.quiet) {
      process.stderr.write(
        '\x1b[33m[warn]\x1b[0m --insecure: SSL certificate verification is disabled. ' +
        'Only use this on trusted networks.\n'
      );
    }
  }
});

program
  .name('openlore')
  .description(
    'Reverse-engineer OpenSpec specifications from existing codebases.\n\n' +
      'Philosophy: "Archaeology over Creativity" — We extract the truth of what\n' +
      'code does, grounded in static analysis, not LLM hallucinations.'
  )
  .version(version)
  .option('-q, --quiet', 'Minimal output (errors only)', false)
  .option('-v, --verbose', 'Show debug information', false)
  .option('--no-color', 'Disable colored output (also enables timestamps)')
  .option('--config <path>', 'Path to config file', '.openlore/config.json')
  .option(
    '--api-base <url>',
    'Custom LLM API base URL (for local/enterprise OpenAI-compatible servers)'
  )
  .option('--insecure', 'Disable SSL certificate verification (for internal/self-signed certs)')
  .option('--timeout <ms>', 'LLM request timeout in milliseconds (default: 120000)', parseInt)
  .addHelpText(
    'after',
    `
Workflow:
  1. openlore init                    Detect project type, create config
  2. openlore analyze                 Scan codebase, build dependency graph
  3. openlore analyze --ai-configs    Generate context files (CLAUDE.md, .cursorrules…)
  4. openlore setup                   Install workflow skills (Vibe, Cline, GSD)
  5. openlore view                    Review visually the dependency graph
  6. openlore generate                Create OpenSpec files using LLM
  7. openlore verify                  Validate specs against source code
  8. openlore drift                   Detect when code outpaces specs
  9. openlore test                    Generate spec-driven tests or check coverage
  10. openlore digest                  Plain-English summary of specs for human review

Quick start:
  $ cd your-project
  $ openlore init
  $ openlore analyze --ai-configs
  $ openlore setup
  $ openlore generate

Or run the full pipeline at once:
  $ openlore run

Troubleshoot your setup:
  $ openlore doctor

Output integrates with OpenSpec ecosystem:
  openspec/
  ├── config.yaml
  ├── specs/
  │   ├── overview/spec.md
  │   ├── architecture/spec.md
  │   └── {domain}/spec.md
  └── decisions/              (with --adr flag)
      ├── index.md
      └── adr-NNNN-*.md

Learn more: https://github.com/Fission-AI/OpenSpec
`
  );

// Register subcommands
program.addCommand(initCommand);
program.addCommand(analyzeCommand);
program.addCommand(generateCommand);
program.addCommand(verifyCommand);
program.addCommand(driftCommand);
program.addCommand(runCommand);
program.addCommand(mcpCommand);
program.addCommand(viewCommand);
program.addCommand(doctorCommand);
program.addCommand(setupCommand);
program.addCommand(refreshStoriesCommand);
program.addCommand(auditCommand);
program.addCommand(testCommand);
program.addCommand(digestCommand);
program.addCommand(decisionsCommand);
program.addCommand(telemetryCommand);
program.addCommand(panicCheckCommand);

program.parse();
