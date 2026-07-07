#!/usr/bin/env node
'use strict';

// Keep the CLI output clean: swallow only the node:sqlite experimental warning.
// (Adding a 'warning' listener doesn't suppress Node's default print, so we
// intercept process.emitWarning before node:sqlite is first used.)
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return _emitWarning(warning, ...rest);
};

// Exit cleanly when piped into a reader that closes early (e.g. `| head`).
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

const { program } = require('commander');
const pkg = require('../package.json');
const { logger } = require('../src/logger');
const { ExporterError } = require('../src/errors');

const authCmd = require('../src/commands/auth');
const listCmd = require('../src/commands/list');
const exportCmd = require('../src/commands/export');

// Wrap command actions so typed errors print a clean message (no stack).
function wrap(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof ExporterError) {
        logger.error(err.message);
      } else {
        logger.error(err && err.stack ? err.stack : String(err));
      }
      process.exitCode = 1;
    }
  };
}

// Shared auth/session options for every command.
function withAuthOpts(cmd) {
  return cmd
    .option('--session-key <key>', 'use this sessionKey instead of reading the Claude Desktop app')
    .option('--org <uuid>', 'organization id (auto-resolved if omitted)')
    .option('--user-agent <ua>', 'override the User-Agent header');
}

program
  .name('claudex')
  .description(pkg.description)
  .version(pkg.version);

withAuthOpts(program.command('auth'))
  .description('check that the Claude session can be read and used')
  .option('--offline', 'only decrypt the local session; do not hit the network')
  .action(wrap(authCmd));

withAuthOpts(program.command('list'))
  .description('list your conversations')
  .option('--json', 'output raw JSON to stdout')
  .option('--since <date>', 'only conversations updated on/after this date (e.g. 2025-01-01)')
  .option('--limit <n>', 'show at most N (most recently updated) conversations')
  .action(wrap(listCmd));

withAuthOpts(program.command('export'))
  .argument('[conversationId]', 'conversation id to export (omit and use --all for everything)')
  .description('export one conversation or --all of them')
  .option('--all', 'export every conversation')
  .option('--format <fmt>', 'json | markdown | text | all', 'markdown')
  .option('--out <dir>', 'output directory (default ./claudex)')
  .option('--zip', 'bundle output into a single .zip')
  .option('--active-branch-only', 'export only the active branch (default: all branches)')
  .option('--no-thinking', 'omit extended-thinking blocks')
  .option('--no-tools', 'omit tool calls, results, and artifacts')
  .option('--no-attachments', 'omit attachments')
  .option('--no-metadata', 'omit the metadata header and per-message timestamps')
  .option('--since <date>', 'with --all: only conversations updated on/after this date')
  .option('--limit <n>', 'with --all: export at most N (most recently updated) conversations')
  .option('--concurrency <n>', 'number of parallel fetches (default 3)')
  .action(wrap(exportCmd));

program.parseAsync(process.argv);
