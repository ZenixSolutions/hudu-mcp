/**
 * Environment configuration.
 *
 * The behaviour worth protecting here is that a misconfigured install is fixed
 * in one pass: `loadConfig` reports every problem at once rather than one
 * variable per restart. Capability flags are environment-only (Invariant 4 in
 * CLAUDE.md), so their parsing is a security control, not a convenience.
 */

import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_PAGE_SIZE,
  HUDU_DOCUMENTED_RATE_LIMIT_PER_MINUTE,
  loadConfig,
  MAX_PAGE_SIZE,
  normaliseBaseUrl,
} from '../../src/config.js';
import { TEST_API_KEY } from '../helpers/fixtures.js';

const validEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HUDU_BASE_URL: 'https://hudu.test.invalid',
  HUDU_API_KEY: TEST_API_KEY,
  ...extra,
});

describe('loadConfig — required variables', () => {
  it('names every problem at once when nothing is set', () => {
    let thrown: unknown;
    try {
      loadConfig({});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as ConfigError).message;
    expect(message, 'a one-problem-at-a-time error costs a restart per variable').toContain(
      'HUDU_BASE_URL',
    );
    expect(message).toContain('HUDU_API_KEY');
    expect(message).toContain('Invalid configuration');
  });

  it('lists both a bad URL and a missing key in a single error', () => {
    let message = '';
    try {
      loadConfig({ HUDU_BASE_URL: 'not-a-url' });
    } catch (error) {
      message = (error as ConfigError).message;
    }
    expect(message).toMatch(/absolute URL/);
    expect(message).toMatch(/HUDU_API_KEY must not be empty/);
  });

  it('tells the operator where to get an API key', () => {
    expect(() => loadConfig({})).toThrow(/Basic Information -> API Keys/);
  });

  it('rejects a non-http scheme', () => {
    expect(() => loadConfig(validEnv({ HUDU_BASE_URL: 'ftp://hudu.test.invalid' }))).toThrow(
      ConfigError,
    );
  });

  it('rejects a whitespace-only API key', () => {
    expect(() => loadConfig(validEnv({ HUDU_API_KEY: '   ' }))).toThrow(/HUDU_API_KEY/);
  });

  it('accepts a minimal valid environment', () => {
    const config = loadConfig(validEnv(), '1.2.3');
    expect(config.baseUrl).toBe('https://hudu.test.invalid');
    expect(config.apiKey).toBe(TEST_API_KEY);
    expect(config.userAgent).toContain('hudu-mcp/1.2.3');
  });

  it('applies documented defaults', () => {
    const config = loadConfig(validEnv());
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.maxConcurrency).toBe(4);
    expect(config.rateLimitPerMinute).toBe(120);
    expect(config.maxRetries).toBe(3);
    expect(config.readOnly).toBe(false);
    expect(config.allowDestructive).toBe(false);
    expect(config.allowPasswordReveal).toBe(false);
    expect(config.allowPasswordWrite).toBe(false);
    expect(config.allowExports).toBe(false);
  });
});

describe('normaliseBaseUrl', () => {
  it.each([
    ['https://hudu.example.com', 'https://hudu.example.com'],
    ['https://hudu.example.com/', 'https://hudu.example.com'],
    ['https://hudu.example.com///', 'https://hudu.example.com'],
    ['  https://hudu.example.com  ', 'https://hudu.example.com'],
    ['https://hudu.example.com/api/v1', 'https://hudu.example.com'],
    ['https://hudu.example.com/api/v1/', 'https://hudu.example.com'],
    ['https://hudu.example.com/API/V1', 'https://hudu.example.com'],
    ['http://hudu.example.com:8080/api/v1', 'http://hudu.example.com:8080'],
  ])('normalises %s', (input, expected) => {
    expect(normaliseBaseUrl(input)).toBe(expected);
  });

  it('leaves a path that merely mentions api elsewhere alone', () => {
    expect(normaliseBaseUrl('https://hudu.example.com/hudu')).toBe('https://hudu.example.com/hudu');
  });

  it('is applied by loadConfig, so the client never doubles the prefix', () => {
    const config = loadConfig(validEnv({ HUDU_BASE_URL: 'https://hudu.test.invalid/api/v1/' }));
    expect(config.baseUrl).toBe('https://hudu.test.invalid');
  });
});

describe('boolean environment parsing', () => {
  const flags = [
    ['HUDU_READ_ONLY', 'readOnly'],
    ['HUDU_ALLOW_DESTRUCTIVE', 'allowDestructive'],
    ['HUDU_ALLOW_PASSWORD_REVEAL', 'allowPasswordReveal'],
    ['HUDU_ALLOW_PASSWORD_WRITE', 'allowPasswordWrite'],
    ['HUDU_ALLOW_EXPORTS', 'allowExports'],
  ] as const;

  const truthy = ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', 'ON', ' true '];
  const falsy = ['0', 'false', 'no', 'off', '', '   ', '2', 'y', 'enabled', 'null', 'undefined'];

  it.each(flags)('%s accepts the documented truthy values for %s', (variable, key) => {
    for (const value of truthy) {
      expect(loadConfig(validEnv({ [variable]: value }))[key], `${variable}=${value}`).toBe(true);
    }
  });

  it.each(flags)('%s treats anything else as false for %s', (variable, key) => {
    for (const value of falsy) {
      expect(loadConfig(validEnv({ [variable]: value }))[key], `${variable}=${value}`).toBe(false);
    }
  });

  it.each(flags)('%s is false when unset (%s)', (_variable, key) => {
    expect(loadConfig(validEnv())[key]).toBe(false);
  });
});

describe('numeric environment parsing', () => {
  it('reads integers', () => {
    const config = loadConfig(
      validEnv({
        HUDU_REQUEST_TIMEOUT_MS: '5000',
        HUDU_MAX_CONCURRENCY: '8',
        HUDU_RATE_LIMIT_PER_MINUTE: '300',
        HUDU_MAX_RETRIES: '0',
      }),
    );
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.maxConcurrency).toBe(8);
    expect(config.rateLimitPerMinute).toBe(300);
    expect(config.maxRetries).toBe(0);
  });

  it('truncates a fractional value rather than passing it through', () => {
    expect(loadConfig(validEnv({ HUDU_MAX_CONCURRENCY: '4.9' })).maxConcurrency).toBe(4);
  });

  it('falls back to the default for an empty value', () => {
    expect(loadConfig(validEnv({ HUDU_MAX_RETRIES: '' })).maxRetries).toBe(3);
  });

  it('rejects a non-numeric value instead of silently defaulting', () => {
    expect(() => loadConfig(validEnv({ HUDU_MAX_CONCURRENCY: 'lots' }))).toThrow(ConfigError);
  });

  it('refuses a rate limit above what Hudu documents', () => {
    expect(() =>
      loadConfig(
        validEnv({
          HUDU_RATE_LIMIT_PER_MINUTE: String(HUDU_DOCUMENTED_RATE_LIMIT_PER_MINUTE + 1),
        }),
      ),
    ).toThrow(ConfigError);
  });

  it.each([
    ['HUDU_REQUEST_TIMEOUT_MS', '0'],
    ['HUDU_MAX_CONCURRENCY', '0'],
    ['HUDU_MAX_CONCURRENCY', '33'],
    ['HUDU_RATE_LIMIT_PER_MINUTE', '0'],
    ['HUDU_MAX_RETRIES', '-1'],
    ['HUDU_MAX_RETRIES', '11'],
  ])('rejects %s=%s', (variable, value) => {
    expect(() => loadConfig(validEnv({ [variable]: value }))).toThrow(ConfigError);
  });
});

describe('mutually exclusive capability flags', () => {
  it('rejects read-only and allow-destructive together', () => {
    expect(() =>
      loadConfig(validEnv({ HUDU_READ_ONLY: '1', HUDU_ALLOW_DESTRUCTIVE: '1' })),
    ).toThrow(ConfigError);
  });

  it('explains which one to unset rather than silently picking', () => {
    expect(() =>
      loadConfig(validEnv({ HUDU_READ_ONLY: 'true', HUDU_ALLOW_DESTRUCTIVE: 'yes' })),
    ).toThrow(/unset one of them/);
  });

  it('allows read-only with password reveal, which is a Read operation', () => {
    const config = loadConfig(validEnv({ HUDU_READ_ONLY: '1', HUDU_ALLOW_PASSWORD_REVEAL: '1' }));
    expect(config.readOnly).toBe(true);
    expect(config.allowPasswordReveal).toBe(true);
  });

  // The two password gates are independent by design: documenting a new
  // credential without being able to read existing ones is a legitimate
  // workflow, so neither is inferred from the other and neither is rejected
  // alongside the other.
  it('parses the two password gates independently', () => {
    const write = loadConfig(validEnv({ HUDU_ALLOW_PASSWORD_WRITE: '1' }));
    expect(write.allowPasswordWrite).toBe(true);
    expect(write.allowPasswordReveal).toBe(false);

    const reveal = loadConfig(validEnv({ HUDU_ALLOW_PASSWORD_REVEAL: '1' }));
    expect(reveal.allowPasswordReveal).toBe(true);
    expect(reveal.allowPasswordWrite, 'reading must not imply writing').toBe(false);
  });
});

describe('published constants', () => {
  it('matches what the Hudu contract documents', () => {
    expect(HUDU_DOCUMENTED_RATE_LIMIT_PER_MINUTE).toBe(300);
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    // Hudu publishes no maximum page size (spec-defects.md D12); this is a
    // client-side clamp rather than a documented ceiling.
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});
