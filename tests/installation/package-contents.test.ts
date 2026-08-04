/**
 * What actually ships.
 *
 * Both directions matter, and they fail in opposite ways. A `files` array that
 * is too broad publishes source, tests and — worst of all — a stray `.env`. One
 * that is too narrow publishes a package that installs cleanly and then cannot
 * start, because the entry point or a transitively imported module is missing.
 * The second failure is invisible to every other test in this repository, since
 * they all run against the working tree.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface PackResult {
  readonly files?: readonly { readonly path: string }[];
}

/**
 * Read the file list out of `npm pack --json`, whichever shape npm emits.
 *
 * npm 10 and 11 return an array of package objects; npm 12 returns an object
 * keyed by package name. This test used to index `[0]`, which under npm 12
 * silently yields no files — and "no files" reads as "the tarball is empty",
 * which is a failure this test is supposed to detect for real. It failed in the
 * release workflow and nowhere else, because only that workflow upgrades npm.
 *
 * Accepting both shapes is the fix. Guessing at npm's output format is not
 * something a packaging test should ever do quietly.
 */
function filesFromPackJson(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);

  const entries: PackResult[] = Array.isArray(parsed)
    ? (parsed as PackResult[])
    : typeof parsed === 'object' && parsed !== null
      ? Object.values(parsed as Record<string, PackResult>)
      : [];

  const first = entries[0];
  if (first === undefined) {
    throw new Error(
      `npm pack --json returned no package entry. Shape was: ${raw.slice(0, 200)}. ` +
        'npm has probably changed its output format again; update filesFromPackJson.',
    );
  }

  return (first.files ?? []).map((file) => file.path);
}

let packed: string[] = [];

beforeAll(() => {
  if (!existsSync(resolve(REPO_ROOT, 'dist/index.js'))) {
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
  }

  // `--dry-run` writes no tarball, so this leaves nothing behind.
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  packed = filesFromPackJson(raw);
  expect(packed.length, 'npm pack reported no files at all').toBeGreaterThan(0);
});

describe('the tarball contains what the package needs to run', () => {
  it('ships the executable entry point named in bin', () => {
    expect(packed, 'the bin target is missing; the package installs and cannot start').toContain(
      'dist/index.js',
    );
  });

  it('ships the module entry point named in exports', () => {
    expect(packed).toContain('dist/server.js');
    expect(packed).toContain('dist/server.d.ts');
  });

  it('ships every compiled module, not just the entry points', () => {
    // A too-narrow `files` array is caught here: every directory under src/ has
    // to have a compiled counterpart in the tarball or the entry point cannot
    // resolve its imports.
    for (const expected of [
      'dist/config.js',
      'dist/api/client.js',
      'dist/api/errors.js',
      'dist/api/envelope.js',
      'dist/api/paths.js',
      'dist/api/rate-limit.js',
      'dist/api/redact.js',
      'dist/presentation/format.js',
      'dist/security/classification.js',
      'dist/security/secrets.js',
      'dist/tools/define.js',
      'dist/tools/index.js',
      'dist/tools/resource.js',
      'dist/transport/stdio.js',
    ]) {
      expect(packed, `${expected} is missing from the tarball`).toContain(expected);
    }
  });

  it('ships a compiled counterpart for every source module', () => {
    const sources = sourceModules();
    expect(
      sources.length,
      'no source modules were discovered; the check would be vacuous',
    ).toBeGreaterThan(10);

    const compiled = new Set(packed.filter((path) => path.endsWith('.js')));
    const missing = sources
      .map((source) => `dist/${source.replace(/\.ts$/, '.js')}`)
      .filter((expected) => !compiled.has(expected));

    expect(missing, 'these source modules have no compiled file in the tarball').toEqual([]);
  });

  it('ships package.json, which npm always includes', () => {
    expect(packed).toContain('package.json');
  });
});

describe('the tarball excludes what must not ship', () => {
  it('excludes source maps', () => {
    const maps = packed.filter((path) => path.endsWith('.map'));
    expect(maps, 'source maps bloat the package and expose the original source').toEqual([]);
  });

  it('excludes the TypeScript sources', () => {
    const sources = packed.filter((path) => path.startsWith('src/'));
    expect(sources).toEqual([]);
  });

  it('excludes the tests', () => {
    expect(packed.filter((path) => path.startsWith('tests/'))).toEqual([]);
    expect(packed.filter((path) => path.includes('.test.'))).toEqual([]);
  });

  it('excludes the docs directory, including the captured API contract', () => {
    expect(packed.filter((path) => path.startsWith('docs/'))).toEqual([]);
  });

  it('excludes every .env file, including the example', () => {
    const envFiles = packed.filter((path) => path.split('/').pop()?.startsWith('.env') === true);
    expect(envFiles, 'an env file in a published package is a credential-leak vector').toEqual([]);
  });

  it('excludes build and tooling configuration', () => {
    for (const unwanted of [
      'tsconfig.json',
      'tsconfig.build.json',
      'vitest.config.ts',
      'eslint.config.js',
      '.prettierrc.json',
      'package-lock.json',
    ]) {
      expect(packed, `${unwanted} does not belong in the published package`).not.toContain(
        unwanted,
      );
    }
  });

  it('excludes CI configuration and scripts', () => {
    expect(packed.filter((path) => path.startsWith('.github/'))).toEqual([]);
    expect(packed.filter((path) => path.startsWith('scripts/'))).toEqual([]);
  });

  it('excludes node_modules and coverage output', () => {
    expect(packed.filter((path) => path.startsWith('node_modules/'))).toEqual([]);
    expect(packed.filter((path) => path.startsWith('coverage/'))).toEqual([]);
  });

  it('contains nothing outside dist/ but the documented root files', () => {
    const allowedRoot = new Set(['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    const unexpected = packed.filter((path) => !path.startsWith('dist/') && !allowedRoot.has(path));
    expect(unexpected, 'unexpected files in the published package').toEqual([]);
  });
});

/** Source modules, relative to `src/`, discovered by walking the working tree. */
function sourceModules(base = resolve(REPO_ROOT, 'src'), prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...sourceModules(resolve(base, entry.name), relative));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(relative);
    }
  }
  return found;
}

describe('the reported version matches the published one', () => {
  it('SERVER_VERSION equals the version in package.json', async () => {
    // Three audiences read this constant — the MCP handshake, `--version`, and
    // the User-Agent — and nothing about the build fails when it drifts from
    // package.json. It drifted once, silently, between 0.1.0 and 0.2.0.
    const { SERVER_VERSION } = await import('../../src/server.js');
    const declared = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };

    expect(
      SERVER_VERSION,
      'src/server.ts SERVER_VERSION and package.json version must match; bump both',
    ).toBe(declared.version);
  });
});
