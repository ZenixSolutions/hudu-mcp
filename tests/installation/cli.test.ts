/**
 * The compiled executable, run as a user would run it.
 *
 * These are the only tests that spawn the built artefact. What they cover is
 * the first thirty seconds of someone's experience with the package: `--help`
 * and `--version` must work before any configuration exists, and `--check` must
 * fail loudly and usefully when it does not.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = resolve(REPO_ROOT, 'dist/index.js');

/**
 * An environment with every Hudu variable removed, and no proxy.
 *
 * Inherited configuration would make `--check` pass for the wrong reason, and
 * would risk a developer's real credentials influencing the result. The proxy
 * variables go too: `--check` now issues a real request, and a proxy in the
 * ambient environment would decide where it lands. Every request these tests
 * provoke must reach either the loopback stub below or nothing at all.
 */
function envWithout(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('HUDU_')) continue;
    if (/^(?:https?|all|no)_proxy$/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv = envWithout()): RunResult {
  const result = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The same thing, without blocking this process.
 *
 * Mandatory for every test that stands a stub Hudu up: the stub's HTTP server
 * runs on *this* event loop, and `spawnSync` holds that loop until the child
 * exits — so the child would wait forever for a reply the parent cannot send.
 * The deadlock looks exactly like a hung binary, which is why this note is here
 * rather than in a commit message.
 */
function runAsync(args: string[], env: NodeJS.ProcessEnv = envWithout()): Promise<RunResult> {
  return new Promise<RunResult>((settle) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { cwd: REPO_ROOT, env });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      settle({ status, stdout, stderr });
    });
  });
}

/**
 * A Hudu that answers exactly what a test tells it to, on loopback.
 *
 * This is the fetch mock for a suite that cannot inject one: these tests spawn
 * the compiled binary, so the seam has to be the socket rather than the
 * `HuduClient` constructor. Nothing here leaves the machine — the address is
 * `127.0.0.1` on an ephemeral port — and `requests` is what proves whether the
 * binary contacted Hudu at all, which is the whole point of the `--offline`
 * distinction.
 */
interface StubHudu {
  readonly url: string;
  readonly requests: { method: string; path: string; apiKey: string | undefined }[];
  close(): Promise<void>;
}

async function stubHudu(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<StubHudu> {
  const requests: StubHudu['requests'] = [];
  const server: Server = createServer((request, response) => {
    const key = request.headers['x-api-key'];
    requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      apiKey: Array.isArray(key) ? key[0] : key,
    });
    respond(request, response);
  });

  await new Promise<void>((settle) => {
    server.listen(0, '127.0.0.1', settle);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((settle) => {
        server.close(() => {
          settle();
        });
      }),
  };
}

const jsonResponder =
  (status: number, body: unknown) =>
  (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

/** Configuration that is complete and syntactically valid, pointed anywhere. */
function envFor(baseUrl: string): NodeJS.ProcessEnv {
  const env = envWithout();
  env['HUDU_BASE_URL'] = baseUrl;
  env['HUDU_API_KEY'] = 'test-key-0000000000';
  // One attempt, so an unreachable-host test costs a DNS failure and not four.
  env['HUDU_MAX_RETRIES'] = '0';
  return env;
}

beforeAll(() => {
  // Always, rather than only when `dist/` is missing. `npm run validate` runs
  // the tests before the build, so a conditional build would let this suite
  // pass against the previous release's binary while the source under review
  // was never executed at all.
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
});

describe('--help', () => {
  it('exits 0 with no configuration at all', () => {
    const result = run(['--help']);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('An MCP server for the Hudu IT documentation REST API');
  });

  it('documents the required environment', () => {
    const { stdout } = run(['--help']);

    expect(stdout).toContain('HUDU_BASE_URL');
    expect(stdout).toContain('HUDU_API_KEY');
  });

  it('documents every capability gate, so the defaults are discoverable', () => {
    const { stdout } = run(['--help']);

    for (const flag of [
      'HUDU_READ_ONLY',
      'HUDU_ALLOW_DESTRUCTIVE',
      'HUDU_ALLOW_PASSWORD_REVEAL',
      'HUDU_ALLOW_PASSWORD_WRITE',
      'HUDU_ALLOW_EXPORTS',
    ]) {
      expect(stdout, `${flag} is undocumented in --help`).toContain(flag);
    }
    expect(stdout).toContain('Security defaults are restrictive on purpose');
  });

  it('accepts the short form', () => {
    expect(run(['-h']).status).toBe(0);
  });

  it('prints nothing to stderr', () => {
    expect(run(['--help']).stderr).toBe('');
  });
});

describe('--version', () => {
  it('exits 0 with no configuration at all', () => {
    const result = run(['--version']);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('accepts the short form', () => {
    const result = run(['-v']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('--check', () => {
  it('exits non-zero with a helpful message when HUDU_BASE_URL is missing', () => {
    const result = run(['--check'], envWithout());

    expect(
      result.status,
      'a missing base URL must not be reported as a valid configuration',
    ).not.toBe(0);
    expect(result.stderr).toContain('HUDU_BASE_URL');
    expect(result.stderr, 'the message must say where to get a key').toContain('API Keys');
    expect(result.stdout).not.toContain('configuration is valid');
  });

  it('names every missing variable at once rather than one per run', () => {
    const { stderr } = run(['--check'], envWithout());

    expect(stderr).toContain('HUDU_BASE_URL');
    expect(stderr).toContain('HUDU_API_KEY');
  });

  it('exits with EX_CONFIG (78) so a supervisor can tell configuration from a crash', () => {
    expect(run(['--check'], envWithout()).status).toBe(78);
  });

  it('still fails when only the API key is supplied', () => {
    const env = envWithout();
    env['HUDU_API_KEY'] = 'test-key-0000000000';

    const result = run(['--check'], env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('HUDU_BASE_URL');
  });

  it('rejects a contradictory configuration', () => {
    const env = envFor('https://hudu.test.invalid');
    env['HUDU_READ_ONLY'] = '1';
    env['HUDU_ALLOW_DESTRUCTIVE'] = '1';

    const result = run(['--check'], env);

    expect(result.status).toBe(78);
    expect(result.stderr).toContain('unset one of them');
  });

  it('calls GET /api_info with the key and reports the version it reached', async () => {
    const hudu = await stubHudu(jsonResponder(200, { version: '2.34.2', date: '2026-31-05' }));

    try {
      const result = await runAsync(['--check'], envFor(hudu.url));

      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout, 'the version reached must be reported').toContain('2.34.2');
      expect(hudu.requests).toHaveLength(1);
      expect(hudu.requests[0]?.path).toBe('/api/v1/api_info');
      expect(hudu.requests[0]?.apiKey, 'the check must authenticate as the server does').toBe(
        'test-key-0000000000',
      );
    } finally {
      await hudu.close();
    }
  });

  it('fails on a key the instance rejects, with the 401 guidance rather than a dump', async () => {
    const hudu = await stubHudu(jsonResponder(401, { error: 'Unauthorized' }));

    try {
      const result = await runAsync(['--check'], envFor(hudu.url));

      expect(result.status, 'a dead key must not pass the pre-flight').not.toBe(0);
      expect(result.stderr).toContain('--check failed');
      expect(result.stderr, 'the operator needs the translated guidance').toContain('What to do:');
      expect(result.stderr).toContain('API Keys');
      expect(result.stdout).toBe('');
    } finally {
      await hudu.close();
    }
  });

  it('fails when the instance cannot be reached at all', () => {
    const result = run(['--check'], envFor('https://hudu.test.invalid'));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not reach the Hudu instance');
    expect(result.stderr).toContain('What to do:');
  });

  it('never claims a configuration is valid without having talked to Hudu', async () => {
    const hudu = await stubHudu(jsonResponder(401, { error: 'Unauthorized' }));

    try {
      const result = await runAsync(['--check'], envFor(hudu.url));

      expect(`${result.stdout}${result.stderr}`).not.toContain('configuration is valid');
    } finally {
      await hudu.close();
    }
  });

  it('never echoes the API key back, on the failure path either', async () => {
    const hudu = await stubHudu(jsonResponder(401, { error: 'Unauthorized' }));

    try {
      const result = await runAsync(['--check'], envFor(hudu.url));

      expect(`${result.stdout}${result.stderr}`).not.toContain('test-key-0000000000');
    } finally {
      await hudu.close();
    }
  });
});

describe('--check --offline', () => {
  it('validates a complete configuration without sending a request', async () => {
    // The stub answers 401: were a request made, the check would fail, so
    // exiting 0 here can only mean nothing was sent.
    const hudu = await stubHudu(jsonResponder(401, { error: 'Unauthorized' }));

    try {
      const result = await runAsync(['--check', '--offline'], envFor(hudu.url));

      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(hudu.requests, 'offline means offline').toHaveLength(0);
    } finally {
      await hudu.close();
    }
  });

  it('says plainly that nothing was verified', () => {
    const { stdout } = run(['--check', '--offline'], envFor('https://hudu.test.invalid'));

    expect(stdout).toContain('--offline');
    expect(stdout).toContain('No request was sent');
    expect(stdout, 'the phrase belongs to the mode that contacted Hudu').not.toContain(
      'configuration is valid',
    );
  });

  it('still rejects a missing configuration with EX_CONFIG', () => {
    const result = run(['--check', '--offline'], envWithout());

    expect(result.status).toBe(78);
    expect(result.stderr).toContain('HUDU_BASE_URL');
  });
});

describe('--list-tools', () => {
  it('lists the registered tools without contacting Hudu', () => {
    const env = envWithout();
    env['HUDU_BASE_URL'] = 'https://hudu.test.invalid';
    env['HUDU_API_KEY'] = 'test-key-0000000000';

    const result = run(['--list-tools'], env);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('hudu_list_companies');
    expect(result.stdout).toMatch(/Registered: \d+/);
  });

  it('reports the withheld tools and why', () => {
    const env = envWithout();
    env['HUDU_BASE_URL'] = 'https://hudu.test.invalid';
    env['HUDU_API_KEY'] = 'test-key-0000000000';

    const { stdout } = run(['--list-tools'], env);

    expect(stdout).toContain('hudu_reveal_password');
    expect(stdout).toContain('HUDU_ALLOW_PASSWORD_REVEAL');
    expect(stdout).toMatch(/Withheld: \d+/);
  });
});
