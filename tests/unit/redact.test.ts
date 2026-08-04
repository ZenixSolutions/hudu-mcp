/**
 * Credential redaction.
 *
 * Constitution Article VIII: secrets must never be committed, logged, echoed,
 * exposed in errors, or included in examples. This suite is the check on the
 * last three.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearRegisteredSecrets,
  REDACTED,
  redact,
  redactHeaders,
  redactUrl,
  registerSecret,
  scrubSecrets,
} from '../../src/api/redact.js';
import { TEST_API_KEY } from '../helpers/fixtures.js';

beforeEach(() => {
  clearRegisteredSecrets();
  registerSecret(TEST_API_KEY);
});

afterEach(() => {
  clearRegisteredSecrets();
});

describe('registerSecret', () => {
  it('ignores a value too short to be a key, which would match ordinary text', () => {
    registerSecret('abc');
    expect(scrubSecrets('abc def abcdef')).toBe('abc def abcdef');
  });

  it('ignores undefined', () => {
    expect(() => {
      registerSecret(undefined);
    }).not.toThrow();
  });
});

describe('scrubSecrets', () => {
  it('replaces every occurrence, not just the first', () => {
    const text = `key=${TEST_API_KEY} and again ${TEST_API_KEY}`;
    const scrubbed = scrubSecrets(text);
    expect(scrubbed).not.toContain(TEST_API_KEY);
    expect(scrubbed).toBe(`key=${REDACTED} and again ${REDACTED}`);
  });

  it('scrubs a secret embedded mid-token', () => {
    expect(scrubSecrets(`Bearer ${TEST_API_KEY}xyz`)).toBe(`Bearer ${REDACTED}xyz`);
  });

  it('treats a registered secret as a literal, not a pattern', () => {
    clearRegisteredSecrets();
    registerSecret('a.b*c+d(e)');
    expect(scrubSecrets('a.b*c+d(e)')).toBe(REDACTED);
    expect(scrubSecrets('axbxcxdxe')).toBe('axbxcxdxe');
  });

  it('leaves unrelated text alone', () => {
    expect(scrubSecrets('nothing to see here')).toBe('nothing to see here');
  });
});

describe('redact', () => {
  it('scrubs a bare string', () => {
    expect(redact(`token ${TEST_API_KEY}`)).toBe(`token ${REDACTED}`);
  });

  it('passes non-string scalars through untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
  });

  it('replaces sensitive keys wholesale, whatever their value', () => {
    const output = redact({
      password: 'hunter2',
      otp_secret: 'SEED',
      api_key: 'anything',
      apiKey: 'anything',
      token: 'anything',
      access_token: 'anything',
      client_secret: 'anything',
      Authorization: 'Bearer x',
      name: 'kept',
    }) as Record<string, unknown>;

    expect(output).toEqual({
      password: REDACTED,
      otp_secret: REDACTED,
      api_key: REDACTED,
      apiKey: REDACTED,
      token: REDACTED,
      access_token: REDACTED,
      client_secret: REDACTED,
      Authorization: REDACTED,
      name: 'kept',
    });
  });

  it('scrubs a registered secret nested deep inside an object', () => {
    const output = redact({
      a: { b: { c: { note: `configured with ${TEST_API_KEY}` } } },
    });
    expect(JSON.stringify(output)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(output)).toContain(REDACTED);
  });

  it('scrubs secrets inside arrays and arrays of objects', () => {
    const output = redact([TEST_API_KEY, { note: TEST_API_KEY }, [[TEST_API_KEY]]]);
    expect(JSON.stringify(output)).not.toContain(TEST_API_KEY);
  });

  it('scrubs Error.message and Error.stack', () => {
    const error = new Error(`request failed with ${TEST_API_KEY}`);
    error.stack = `Error: leaked ${TEST_API_KEY}\n    at somewhere (${TEST_API_KEY})`;

    const output = redact(error) as { name: string; message: string; stack: string };

    expect(output.name).toBe('Error');
    expect(output.message).not.toContain(TEST_API_KEY);
    expect(output.stack).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(output)).not.toContain(TEST_API_KEY);
  });

  it('scrubs a nested cause chain', () => {
    const root = new Error(`root cause holding ${TEST_API_KEY}`);
    const middle = new Error('middle', { cause: root });
    const top = new Error('top', { cause: middle });

    expect(JSON.stringify(redact(top))).not.toContain(TEST_API_KEY);
  });

  it('does not hang on a cyclic object graph', () => {
    const node: Record<string, unknown> = { note: TEST_API_KEY };
    node['self'] = node;

    const output = redact(node) as Record<string, unknown>;

    expect(output['note']).toBe(REDACTED);
    expect(output['self']).toBe('[Circular]');
  });

  it('does not hang on a cyclic error cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(() => JSON.stringify(redact(b))).not.toThrow();
  });

  it('does not hang on a cyclic array', () => {
    const list: unknown[] = [1];
    list.push(list);
    expect(redact(list)).toEqual([1, '[Circular]']);
  });
});

describe('redactHeaders', () => {
  const cases = ['x-api-key', 'authorization', 'cookie', 'set-cookie', 'proxy-authorization'];

  it.each(cases)('replaces the %s header value', (name) => {
    const headers = new Headers({ [name]: TEST_API_KEY, accept: 'application/json' });
    const output = redactHeaders(headers);
    expect(output[name]).toBe(REDACTED);
    expect(output['accept']).toBe('application/json');
  });

  it.each(cases)('replaces %s regardless of case', (name) => {
    const output = redactHeaders({ [name.toUpperCase()]: 'secret-value' });
    expect(output[name.toUpperCase()]).toBe(REDACTED);
  });

  it('never emits an authorization-style header from an x-api-key request', () => {
    const output = redactHeaders(new Headers({ 'x-api-key': TEST_API_KEY }));
    expect(JSON.stringify(output)).not.toContain(TEST_API_KEY);
  });

  it('scrubs a registered secret out of a non-sensitive header', () => {
    const output = redactHeaders({ 'user-agent': `hudu-mcp (${TEST_API_KEY})` });
    expect(output['user-agent']).toBe(`hudu-mcp (${REDACTED})`);
  });
});

describe('redactUrl', () => {
  it.each(['api_key', 'apikey', 'token', 'access_token', 'password', 'secret'])(
    'replaces the %s query parameter',
    (key) => {
      const output = redactUrl(`https://hudu.test.invalid/api/v1/companies?${key}=${TEST_API_KEY}`);
      expect(output).not.toContain(TEST_API_KEY);
      expect(output).toContain(encodeURIComponent(REDACTED));
    },
  );

  it('keeps ordinary query parameters intact', () => {
    expect(redactUrl('https://hudu.test.invalid/api/v1/companies?page=2&name=Acme')).toBe(
      'https://hudu.test.invalid/api/v1/companies?page=2&name=Acme',
    );
  });

  it('strips userinfo credentials from the authority', () => {
    const output = redactUrl('https://someone:hunter2@hudu.test.invalid/api/v1/companies');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('someone');
    expect(output).toBe('https://hudu.test.invalid/api/v1/companies');
  });

  it('strips a username-only authority', () => {
    expect(redactUrl('https://someone@hudu.test.invalid/x')).toBe('https://hudu.test.invalid/x');
  });

  it('scrubs a registered secret that appears in the path', () => {
    const output = redactUrl(`https://hudu.test.invalid/api/v1/${TEST_API_KEY}`);
    expect(output).not.toContain(TEST_API_KEY);
  });

  it('falls back to scrubbing when the value is not a parseable URL', () => {
    expect(redactUrl(`not a url ${TEST_API_KEY}`)).toBe(`not a url ${REDACTED}`);
  });
});
