/**
 * The compiled executable, run as a user would run it.
 *
 * These are the only tests that spawn the built artefact. What they cover is
 * the first thirty seconds of someone's experience with the package: `--help`
 * and `--version` must work before any configuration exists, and `--check` must
 * fail loudly and usefully when it does not.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = resolve(REPO_ROOT, 'dist/index.js');

/**
 * An environment with every Hudu variable removed.
 *
 * Inherited configuration would make `--check` pass for the wrong reason, and
 * would risk a developer's real credentials influencing the result.
 */
function envWithout(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('HUDU_')) env[key] = value;
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

beforeAll(() => {
  if (!existsSync(ENTRY)) {
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
  }
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

  it('exits 0 when the configuration is complete', () => {
    const env = envWithout();
    env['HUDU_BASE_URL'] = 'https://hudu.test.invalid';
    env['HUDU_API_KEY'] = 'test-key-0000000000';

    const result = run(['--check'], env);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('configuration is valid');
  });

  it('rejects a contradictory configuration', () => {
    const env = envWithout();
    env['HUDU_BASE_URL'] = 'https://hudu.test.invalid';
    env['HUDU_API_KEY'] = 'test-key-0000000000';
    env['HUDU_READ_ONLY'] = '1';
    env['HUDU_ALLOW_DESTRUCTIVE'] = '1';

    const result = run(['--check'], env);

    expect(result.status).toBe(78);
    expect(result.stderr).toContain('unset one of them');
  });

  it('never echoes the API key back', () => {
    const env = envWithout();
    env['HUDU_BASE_URL'] = 'https://hudu.test.invalid';
    env['HUDU_API_KEY'] = 'test-key-0000000000';

    const result = run(['--check'], env);

    expect(`${result.stdout}${result.stderr}`).not.toContain('test-key-0000000000');
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
