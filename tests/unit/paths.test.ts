/**
 * URL construction.
 *
 * The first block of this file is a regression guard for a path-injection
 * surface, not a style check. Path segments are interpolated from tool
 * arguments, which are supplied by a model, which is in turn influenced by
 * whatever text it has read. If `buildPath` ever stops percent-encoding a
 * segment, an argument like `../../admin` stops being a record id and starts
 * being a different endpoint.
 */

import { describe, expect, it } from 'vitest';

import {
  API_PREFIX,
  buildPath,
  buildQuery,
  buildUrl,
  encodeSegment,
  PathBuildError,
  toQuery,
} from '../../src/api/paths.js';

const INJECTION_GUARD =
  'PATH INJECTION REGRESSION: buildPath must percent-encode every interpolated segment. ' +
  'An unencoded segment lets a model-supplied argument escape /api/v1/<resource>/ and ' +
  'address a different endpoint.';

/**
 * Hostile-but-plausible values a model could put in an id or slug argument.
 *
 * `outcome` records how each one is neutralised. Both outcomes are acceptable —
 * what must never happen is a value that is neither encoded nor refused and
 * therefore changes which endpoint is addressed.
 */
const HOSTILE_STRINGS: readonly {
  readonly label: string;
  readonly value: string;
  readonly outcome: 'encoded' | 'rejected';
}[] = [
  { label: 'relative traversal', value: '../../admin', outcome: 'encoded' },
  { label: 'bare parent segment', value: '..', outcome: 'rejected' },
  { label: 'bare current segment', value: '.', outcome: 'rejected' },
  { label: 'encoded parent segment', value: '%2e%2e', outcome: 'rejected' },
  { label: 'embedded separator', value: 'a/b', outcome: 'encoded' },
  { label: 'absolute path', value: '/etc/passwd', outcome: 'encoded' },
  { label: 'query injection', value: '?x=1', outcome: 'encoded' },
  { label: 'fragment injection', value: '#frag', outcome: 'encoded' },
  { label: 'encoded separator', value: '%2f%2fadmin', outcome: 'encoded' },
  { label: 'space', value: 'my name', outcome: 'encoded' },
  { label: 'unicode', value: 'café ☕', outcome: 'encoded' },
  { label: 'semicolon parameter', value: 'x;y=z', outcome: 'encoded' },
  { label: 'backslash', value: 'a\\b', outcome: 'encoded' },
  { label: 'newline', value: 'a\nb', outcome: 'encoded' },
  { label: 'empty string', value: '', outcome: 'rejected' },
];

const ENCODED_STRINGS = HOSTILE_STRINGS.filter((entry) => entry.outcome === 'encoded');
const REJECTED_STRINGS = HOSTILE_STRINGS.filter((entry) => entry.outcome === 'rejected');

describe('encodeSegment', () => {
  it.each(ENCODED_STRINGS)('encodes a $label so no separator survives', ({ value }) => {
    const encoded = encodeSegment(value);
    expect(encoded, INJECTION_GUARD).not.toContain('/');
    expect(encoded, INJECTION_GUARD).not.toContain('\\');
    expect(encoded, INJECTION_GUARD).not.toContain('?');
    expect(encoded, INJECTION_GUARD).not.toContain('#');
    expect(encoded, INJECTION_GUARD).not.toMatch(/\s/);
  });

  it.each(REJECTED_STRINGS)('refuses a $label outright', ({ value }) => {
    expect(() => encodeSegment(value), INJECTION_GUARD).toThrow(PathBuildError);
  });

  it.each(['.', '..', '%2e', '%2E%2e', ' .. '])(
    'refuses the dot segment %j, which the URL parser would collapse',
    (value) => {
      expect(() => encodeSegment(value), INJECTION_GUARD).toThrow(/relative path element/);
    },
  );

  it('still allows a value that merely contains dots', () => {
    expect(encodeSegment('v1.2.3')).toBe('v1.2.3');
    expect(encodeSegment('...')).toBe('...');
  });

  it('encodes an integer id unchanged', () => {
    expect(encodeSegment(42)).toBe('42');
  });

  it.each([
    { label: 'empty string', value: '' },
    { label: 'whitespace only', value: '   ' },
  ])('rejects an $label rather than building a collapsed path', ({ value }) => {
    expect(() => encodeSegment(value)).toThrow(PathBuildError);
  });

  it.each([
    { label: 'NaN', value: Number.NaN },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
    { label: '-Infinity', value: Number.NEGATIVE_INFINITY },
  ])('rejects $label rather than serialising it into the path', ({ value }) => {
    expect(() => encodeSegment(value)).toThrow(/finite number/);
  });

  it('rejects a non-integer id, because Hudu ids are integers', () => {
    expect(() => encodeSegment(1.5)).toThrow(/integers/);
  });
});

describe('buildPath', () => {
  it('interpolates a plain numeric id', () => {
    expect(buildPath('/companies/{id}/assets', { id: 42 })).toBe('/api/v1/companies/42/assets');
  });

  it('always prefixes the API base exactly once', () => {
    expect(buildPath('companies')).toBe(`${API_PREFIX}/companies`);
    expect(buildPath('/companies')).toBe(`${API_PREFIX}/companies`);
  });

  it.each(HOSTILE_STRINGS)(
    'cannot escape /api/v1/companies/ with a $label',
    ({ value, outcome }) => {
      if (outcome === 'rejected') {
        expect(() => buildPath('/companies/{id}', { id: value }), INJECTION_GUARD).toThrow(
          PathBuildError,
        );
        return;
      }

      const path = buildPath('/companies/{id}', { id: value });

      expect(path, INJECTION_GUARD).toMatch(/^\/api\/v1\/companies\/[^/?#]+$/);

      // Resolve it the way an HTTP client would. `fetch` runs the URL through
      // the WHATWG parser, which is where an unencoded segment would take
      // effect, so this is the assertion that actually models the attack.
      const resolved = new URL(path, 'https://hudu.test.invalid');
      expect(resolved.pathname, INJECTION_GUARD).toMatch(/^\/api\/v1\/companies\/.+$/);
      expect(resolved.pathname.split('/'), INJECTION_GUARD).toHaveLength(5);
      expect(resolved.search, INJECTION_GUARD).toBe('');
      expect(resolved.hash, INJECTION_GUARD).toBe('');
      expect(resolved.pathname.split('/').slice(4), INJECTION_GUARD).not.toContain('..');
    },
  );

  it('keeps a traversal attempt inside the resource even after one decode', () => {
    const path = buildPath('/companies/{id}', { id: '../../admin' });
    expect(path, INJECTION_GUARD).toBe('/api/v1/companies/..%2F..%2Fadmin');
    // One layer of decoding is what a naive proxy might do; the segment is
    // still a single segment at that point, not a traversal.
    expect(decodeURIComponent('..%2F..%2Fadmin'), INJECTION_GUARD).toBe('../../admin');
    expect(new URL(path, 'https://h.invalid').pathname, INJECTION_GUARD).toBe(
      '/api/v1/companies/..%2F..%2Fadmin',
    );
  });

  it('never lets a segment collapse the request onto the collection root', () => {
    // Regression for the case percent-encoding alone does not cover: `..` and
    // `.` survive encodeURIComponent unchanged and are then removed by the URL
    // parser, turning `GET /companies/{id}` into `GET /api/v1/`.
    for (const value of ['.', '..', '%2e', '%2e%2e', '.%2e']) {
      expect(() => buildPath('/companies/{id}', { id: value }), INJECTION_GUARD).toThrow(
        PathBuildError,
      );
    }
  });

  it.each([
    { label: 'an empty string', value: '' },
    { label: 'NaN', value: Number.NaN },
    { label: '1.5', value: 1.5 },
    { label: 'Infinity', value: Number.POSITIVE_INFINITY },
  ])('refuses to build a path from $label', ({ value }) => {
    expect(() => buildPath('/companies/{id}', { id: value }), INJECTION_GUARD).toThrow(
      PathBuildError,
    );
  });

  it('refuses a template whose parameter was not supplied', () => {
    expect(() => buildPath('/companies/{id}')).toThrow(/Missing path parameter "id"/);
  });

  it('encodes every segment of a multi-parameter template', () => {
    const path = buildPath('/companies/{company_id}/assets/{id}', {
      company_id: 'a/b',
      id: '?x=1',
    });
    expect(path, INJECTION_GUARD).toBe('/api/v1/companies/a%2Fb/assets/%3Fx%3D1');
    expect(new URL(path, 'https://h.invalid').pathname.split('/'), INJECTION_GUARD).toHaveLength(7);
  });
});

describe('buildQuery', () => {
  it('keeps false, because Hudu filters are meaningfully false', () => {
    expect(buildQuery({ archived: false })).toBe('?archived=false');
    expect(buildQuery({ draft: false, matched: false })).toBe('?draft=false&matched=false');
  });

  it('keeps true and zero', () => {
    expect(buildQuery({ archived: true, page: 0 })).toBe('?archived=true&page=0');
  });

  it('drops undefined and null rather than sending the literal words', () => {
    expect(buildQuery({ a: undefined, b: null, c: 1 })).toBe('?c=1');
  });

  it('returns an empty string when nothing survives', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery({ a: undefined, b: null })).toBe('');
  });

  it('repeats the key for an array rather than joining it', () => {
    expect(buildQuery({ asset_layout_ids: [1, 2, 3] })).toBe(
      '?asset_layout_ids=1&asset_layout_ids=2&asset_layout_ids=3',
    );
  });

  it('emits nothing for an empty array', () => {
    expect(buildQuery({ ids: [] })).toBe('');
  });

  it('percent-encodes keys and values', () => {
    expect(buildQuery({ search: 'a&b=c' })).toBe('?search=a%26b%3Dc');
  });
});

describe('toQuery', () => {
  it('keeps scalars, including false', () => {
    expect(toQuery({ a: 'x', b: 2, c: false })).toEqual({ a: 'x', b: 2, c: false });
  });

  it('drops undefined and null', () => {
    expect(toQuery({ a: undefined, b: null })).toEqual({});
  });

  it('keeps arrays of scalars', () => {
    expect(toQuery({ ids: [1, 2] })).toEqual({ ids: [1, 2] });
  });

  it('drops a plain object rather than stringifying it to [object Object]', () => {
    const result = toQuery({ nested: { a: 1 }, keep: 1 });
    expect(result).toEqual({ keep: 1 });
    expect(JSON.stringify(result)).not.toContain('object Object');
  });

  it('drops a mixed array rather than sending part of it', () => {
    expect(toQuery({ ids: [1, { a: 1 }] })).toEqual({});
  });

  it('drops functions and symbols', () => {
    expect(toQuery({ fn: () => undefined, sym: Symbol('s'), keep: 'y' })).toEqual({ keep: 'y' });
  });
});

describe('buildUrl', () => {
  it('joins base, path and query without a doubled slash', () => {
    expect(buildUrl('https://h.invalid/', '/api/v1/companies', { page: 2 })).toBe(
      'https://h.invalid/api/v1/companies?page=2',
    );
  });

  it('omits the question mark when there is no query', () => {
    expect(buildUrl('https://h.invalid', '/api/v1/companies')).toBe(
      'https://h.invalid/api/v1/companies',
    );
  });
});
