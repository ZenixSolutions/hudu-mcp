#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * This file is deliberately thin: parse arguments, build a server, hand it to a
 * transport. It contains no domain logic, so importing the package never starts
 * a listener as a side effect.
 */

import { ConfigError, loadConfig } from './config.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { runStdio } from './transport/stdio.js';

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

An MCP server for the Hudu IT documentation REST API.

Usage:
  hudu-mcp [options]

Options:
  --help, -h        Show this message and exit
  --version, -v     Print the version and exit
  --list-tools      Print the tools that would be registered, then exit
  --check           Validate configuration and exit non-zero if it is unusable

Required environment:
  HUDU_BASE_URL     Your Hudu instance URL, e.g. https://hudu.example.com
  HUDU_API_KEY      An API key from Hudu Admin -> Basic Information -> API Keys

Optional environment:
  HUDU_READ_ONLY=1              Register only Read tools
  HUDU_ALLOW_DESTRUCTIVE=1      Register delete and purge tools
  HUDU_ALLOW_PASSWORD_REVEAL=1  Register the single-record password reveal tool
  HUDU_ALLOW_EXPORTS=1          Register the bulk export tools
  HUDU_RATE_LIMIT_PER_MINUTE    Client-side request ceiling (default 120, max 300)
  HUDU_MAX_CONCURRENCY          Simultaneous requests (default 4)
  HUDU_REQUEST_TIMEOUT_MS       Per-request timeout (default 30000)
  HUDU_MAX_RETRIES              Retries for transient failures (default 3)

Security defaults are restrictive on purpose. Stored passwords and TOTP secrets
are withheld from every response unless HUDU_ALLOW_PASSWORD_REVEAL is set, and
deletions are unavailable unless HUDU_ALLOW_DESTRUCTIVE is set.

https://github.com/ZenixSolutions/hudu-mcp
`;

function main(argv: readonly string[]): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  if (argv.includes('--check')) {
    loadConfig(process.env, SERVER_VERSION);
    process.stdout.write('hudu-mcp: configuration is valid.\n');
    return;
  }

  if (argv.includes('--list-tools')) {
    const built = buildServer();
    const lines = built.tools.map(
      (tool) => `${tool.name.padEnd(34)} ${tool.operationClass.padEnd(12)} ${tool.title}`,
    );
    process.stdout.write(`${lines.join('\n')}\n\nRegistered: ${built.tools.length}\n`);
    if (built.withheld.length > 0) {
      const withheld = built.withheld.map((item) => `  ${item.name}: ${item.reason}`).join('\n');
      process.stdout.write(`Withheld: ${built.withheld.length}\n${withheld}\n`);
    }
    return;
  }

  void runStdio(buildServer()).catch((error: unknown) => {
    process.stderr.write(
      `hudu-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`hudu-mcp: ${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(
    `hudu-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
