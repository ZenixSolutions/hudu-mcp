#!/usr/bin/env node
/**
 * Executable entry point.
 *
 * This file is deliberately thin: parse arguments, build a server, hand it to a
 * transport. It holds no domain logic, so importing the package never starts a
 * listener as a side effect.
 *
 * `--check` is the one place this file makes a request. That is not domain
 * logic sneaking in — it issues one call through the same client every tool
 * uses and reports the outcome — and it belongs to the CLI because the question
 * it answers ("is this deployment usable?") is asked before any MCP client
 * exists to ask it.
 */

import { HuduClient } from './api/client.js';
import { buildPath } from './api/paths.js';
import { ConfigError, loadConfig } from './config.js';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { toAgentError } from './tools/define.js';
import { runStdio } from './transport/stdio.js';

const USAGE = `${SERVER_NAME} ${SERVER_VERSION}

An MCP server for the Hudu IT documentation REST API.

Usage:
  hudu-mcp [options]

Options:
  --help, -h        Show this message and exit
  --version, -v     Print the version and exit
  --list-tools      Print the tools that would be registered, then exit
  --check           Call GET /api_info with the configured key. Exits non-zero if
                    Hudu is unreachable or rejects the key
  --offline         With --check only: validate configuration without any request

Required environment:
  HUDU_BASE_URL     Your Hudu instance URL, e.g. https://hudu.example.com
  HUDU_API_KEY      An API key from Hudu Admin -> Basic Information -> API Keys

Optional environment:
  HUDU_READ_ONLY=1              Register only Read tools
  HUDU_ALLOW_DESTRUCTIVE=1      Register delete and purge tools
  HUDU_ALLOW_PASSWORD_REVEAL=1  Register the single-record password reveal tool
  HUDU_ALLOW_PASSWORD_WRITE=1   Register the password create/update/archive tools
  HUDU_ALLOW_EXPORTS=1          Register the bulk export tools
  HUDU_RATE_LIMIT_PER_MINUTE    Client-side request ceiling (default 120, max 300)
  HUDU_MAX_CONCURRENCY          Simultaneous requests (default 4)
  HUDU_REQUEST_TIMEOUT_MS       Per-request timeout (default 30000)
  HUDU_MAX_RETRIES              Retries for transient failures (default 3)

Security defaults are restrictive on purpose. Stored passwords and TOTP secrets
are withheld from every response unless HUDU_ALLOW_PASSWORD_REVEAL is set,
password records cannot be created, changed or archived unless
HUDU_ALLOW_PASSWORD_WRITE is set, and deletions are unavailable unless
HUDU_ALLOW_DESTRUCTIVE is set.

https://github.com/ZenixSolutions/hudu-mcp
`;

/**
 * Exit code for a configuration that parsed but could not be used.
 *
 * `EX_CONFIG` (78) already means "the environment is wrong"; this is the
 * separate case where the environment is well-formed and Hudu still refused or
 * could not be reached, which an operator fixes in a different place — the key,
 * the network, the instance — and a supervisor may want to retry rather than
 * treat as permanent.
 */
const EX_UNAVAILABLE = 69;

interface CheckOutcome {
  readonly ok: boolean;
  readonly message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The pre-flight check.
 *
 * Two modes, and the wording of each says which one ran. The default issues a
 * real `GET /api_info` — the one endpoint that needs no ids and no scope beyond
 * a working key — because a check that only inspects the environment cannot
 * tell a live key from a revoked one, and reporting a dead key as "valid" sends
 * the operator looking for the fault everywhere except where it is. Nine empty
 * lists from a rotated key look exactly like a broken filter.
 *
 * `--offline` keeps the syntax-only behaviour for a container build with no
 * network, and says plainly that nothing was verified.
 *
 * Neither mode prints the API key: the success line names only the base URL,
 * and the failure line is produced by {@link toAgentError}, which scrubs
 * registered secrets and translates a `HuduApiError` into its guidance rather
 * than dumping it.
 */
async function runCheck(env: NodeJS.ProcessEnv, offline: boolean): Promise<CheckOutcome> {
  const config = loadConfig(env, SERVER_VERSION);

  if (offline) {
    return {
      ok: true,
      message:
        'hudu-mcp: --check --offline: configuration is well-formed. No request was sent, so ' +
        'the API key, the instance URL and network reachability are all unverified — an ' +
        'expired, revoked or mistyped key passes this check. Run --check without --offline to ' +
        'test them against Hudu.',
    };
  }

  const client = new HuduClient(config);

  try {
    const response = await client.get<unknown>(buildPath('/api_info'));
    const version = isRecord(response.data) ? response.data['version'] : undefined;
    const reached =
      typeof version === 'string' && version !== ''
        ? `reached Hudu ${version}`
        : 'reached Hudu, which reported no version string';

    return {
      ok: true,
      message:
        `hudu-mcp: --check: ${reached} at ${config.baseUrl}. GET /api_info succeeded, so the ` +
        'base URL, the API key and network reachability are all confirmed. Key scope is not: ' +
        'a key that passes here can still be scoped away from passwords, destructive actions ' +
        'or exports, and those scopes are fixed at key creation.',
    };
  } catch (error) {
    return { ok: false, message: `hudu-mcp: --check failed.\n${toAgentError(error)}` };
  }
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  if (argv.includes('--check')) {
    const outcome = await runCheck(process.env, argv.includes('--offline'));
    const stream = outcome.ok ? process.stdout : process.stderr;
    // Exit from the write callback rather than after it. Stdout is a pipe when
    // this is run from a supervisor or a test, and a pipe is asynchronous on
    // POSIX, so exiting on the next line would truncate the message. Exiting at
    // all is deliberate: `fetch` leaves a pooled keep-alive socket open, which
    // would otherwise hold the process for seconds after the answer is known.
    stream.write(`${outcome.message}\n`, () => {
      process.exit(outcome.ok ? 0 : EX_UNAVAILABLE);
    });
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

  await runStdio(buildServer());
}

/**
 * The single failure path.
 *
 * A `ConfigError` means the environment is wrong and keeps EX_CONFIG, so a
 * supervisor can still tell a misconfiguration from a crash. Everything else is
 * a fault in this program.
 */
function fatal(error: unknown): never {
  if (error instanceof ConfigError) {
    process.stderr.write(`hudu-mcp: ${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(
    `hudu-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

main(process.argv.slice(2)).catch(fatal);
