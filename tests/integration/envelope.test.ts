/**
 * Response envelope normalisation.
 *
 * Hudu is not consistent about how it returns a collection: most list endpoints
 * return a bare array, a minority wrap it in a single-key object, and
 * `GET /asset_layouts` documents a single object where the endpoint returns a
 * list (docs/reference/spec-defects.md B1). `unwrapList` absorbs all of it,
 * because a hard failure here reaches the model as an unexplainable empty
 * result.
 */

import { describe, expect, it } from 'vitest';

import { unwrapList, unwrapRecord } from '../../src/api/envelope.js';
import { HuduApiError } from '../../src/api/errors.js';

describe('unwrapList', () => {
  it('passes a bare array through — the common Hudu shape', () => {
    expect(unwrapList([{ id: 1 }, { id: 2 }], undefined, 'GET /companies')).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it('unwraps an enveloped array under its documented key', () => {
    expect(unwrapList({ assets: [{ id: 1 }] }, 'assets', 'GET /assets')).toEqual([{ id: 1 }]);
  });

  it.each([
    ['assets', 'GET /assets'],
    ['matchers', 'GET /matchers'],
    ['procedures', 'GET /procedures'],
    ['public_photos', 'GET /public_photos'],
  ])('unwraps the %s envelope', (key, context) => {
    expect(unwrapList({ [key]: [{ id: 9 }] }, key, context)).toEqual([{ id: 9 }]);
  });

  it('accepts a single object where a list was documented (defect B1)', () => {
    // GET /asset_layouts documents its 200 response as one Asset_Layout object
    // where the endpoint in fact returns a collection. One record is a
    // legitimate result, not an error.
    const single = { id: 4, name: 'Server' };
    expect(unwrapList(single, undefined, 'GET /asset_layouts')).toEqual([single]);
  });

  it('returns an empty list for an empty body', () => {
    expect(unwrapList(undefined, undefined, 'GET /companies')).toEqual([]);
    expect(unwrapList(null, undefined, 'GET /companies')).toEqual([]);
    expect(unwrapList([], undefined, 'GET /companies')).toEqual([]);
    expect(unwrapList({}, undefined, 'GET /companies')).toEqual([]);
  });

  it('returns an empty list when the documented envelope holds an empty array', () => {
    expect(unwrapList({ assets: [] }, 'assets', 'GET /assets')).toEqual([]);
    expect(unwrapList({ assets: null }, 'assets', 'GET /assets')).toEqual([]);
  });

  it('falls back to the only array-valued property when no key is documented', () => {
    expect(unwrapList({ data: [{ id: 1 }] }, undefined, 'GET /x')).toEqual([{ id: 1 }]);
  });

  it('refuses to guess between two candidate arrays', () => {
    expect(() => unwrapList({ a: [1], b: [2] }, undefined, 'GET /x')).toThrow(HuduApiError);
  });

  it('points an unrecognised shape at the issue tracker rather than failing silently', () => {
    const error = (() => {
      try {
        unwrapList({ a: [1], b: [2] }, undefined, 'GET /x');
        return undefined;
      } catch (caught) {
        return caught as HuduApiError;
      }
    })();

    expect(error?.kind).toBe('protocol');
    expect(error?.guidance).toContain('hudu-mcp/issues');
    expect(error?.message).toContain('GET /x');
  });

  it('prefers the documented key over an incidental array elsewhere', () => {
    expect(unwrapList({ assets: [{ id: 1 }], tags: [{ id: 2 }] }, 'assets', 'GET /assets')).toEqual(
      [{ id: 1 }],
    );
  });
});

describe('unwrapRecord', () => {
  it('returns a bare record unchanged', () => {
    expect(unwrapRecord({ id: 1, name: 'Acme' }, undefined)).toEqual({ id: 1, name: 'Acme' });
  });

  it('unwraps a record under its documented key', () => {
    expect(unwrapRecord({ company: { id: 1 } }, 'company')).toEqual({ id: 1 });
  });

  it('falls back to the whole body when the documented key is absent', () => {
    expect(unwrapRecord({ id: 1 }, 'company')).toEqual({ id: 1 });
  });

  it('returns undefined for an empty body', () => {
    expect(unwrapRecord(undefined, undefined)).toBeUndefined();
    expect(unwrapRecord(null, 'company')).toBeUndefined();
  });
});
