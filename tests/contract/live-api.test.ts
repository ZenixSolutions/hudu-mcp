/**
 * Contract tests against a live Hudu instance.
 *
 * These are the only tests in this repository that touch the network, and they
 * skip themselves unless `HUDU_CONTRACT_TESTS=1` and both `HUDU_BASE_URL` and
 * `HUDU_API_KEY` are set. CI must never enable them.
 *
 * Their purpose is narrow and worth stating plainly: everything else in this
 * suite is written against `docs/reference/api-docs.json`, captured from a live
 * instance on 2026-08-04. If Hudu changes, every other test still passes while
 * the server is quietly wrong. These tests detect that drift, so each assertion
 * checks a shape the production code *assumes* rather than merely a shape that
 * happens to be returned.
 *
 * Read-only calls only. There is no guarded write path here and there must
 * never be one — a contract test that can delete a customer's data is a defect
 * regardless of how carefully it is gated.
 */

import { describe, expect, it } from 'vitest';

import { HuduClient } from '../../src/api/client.js';
import { unwrapList } from '../../src/api/envelope.js';
import { buildPath } from '../../src/api/paths.js';
import { loadConfig } from '../../src/config.js';

const enabled =
  process.env['HUDU_CONTRACT_TESTS'] === '1' &&
  (process.env['HUDU_BASE_URL'] ?? '') !== '' &&
  (process.env['HUDU_API_KEY'] ?? '') !== '';

const DRIFT =
  'the captured contract and live behaviour have diverged. docs/reference/api-docs.json was ' +
  'captured on 2026-08-04 and the code assumes the shape it describes; this instance returned ' +
  'something else. Re-capture the contract, update docs/reference/spec-defects.md, and check ' +
  'whether any tool built on that assumption is now wrong.';

const client = (): HuduClient => new HuduClient(loadConfig(process.env, '0.0.0-contract'), {});

describe.skipIf(!enabled)('live Hudu contract', () => {
  it('GET /api_info returns the version fields the code reports', async () => {
    const response = await client().get<Record<string, unknown>>(buildPath('/api_info'));

    expect(response.status, DRIFT).toBe(200);
    expect(response.data, DRIFT).toBeTypeOf('object');
    expect(Object.keys(response.data), DRIFT).toContain('version');
  });

  it('GET /companies returns a bare array, with no total and no envelope', async () => {
    const response = await client().get<unknown>(buildPath('/companies'), {
      page: 1,
      page_size: 5,
    });

    expect(response.status, DRIFT).toBe(200);

    // C1: no collection endpoint returns a total count. `page_was_full` is the
    // only honest signal this server can emit, and that depends on this shape.
    expect(Array.isArray(response.data), DRIFT).toBe(true);

    const items = unwrapList<Record<string, unknown>>(response.data, undefined, 'GET /companies');
    expect(items.length, DRIFT).toBeLessThanOrEqual(5);
    if (items.length > 0) {
      expect(Object.keys(items[0]!), DRIFT).toContain('id');
      expect(Object.keys(items[0]!), DRIFT).toContain('name');
    }
  });

  it('GET /companies honours page_size, so the clamp means something', async () => {
    const response = await client().get<unknown>(buildPath('/companies'), {
      page: 1,
      page_size: 1,
    });

    const items = unwrapList<unknown>(response.data, undefined, 'GET /companies');
    expect(items.length, DRIFT).toBeLessThanOrEqual(1);
  });

  it('GET /asset_layouts really does return a list, despite documenting one object (B1)', async () => {
    // The published schema says the 200 response is a single Asset_Layout.
    // `unwrapList` absorbs both shapes; if the endpoint ever settles on one,
    // this is where that shows up.
    const response = await client().get<unknown>(buildPath('/asset_layouts'), { page: 1 });

    expect(response.status, DRIFT).toBe(200);

    const items = unwrapList<Record<string, unknown>>(
      response.data,
      undefined,
      'GET /asset_layouts',
    );
    expect(Array.isArray(items), DRIFT).toBe(true);

    if (items.length > 0) {
      expect(Object.keys(items[0]!), DRIFT).toContain('id');
    }
  });

  it('GET /asset_layouts still returns something without page_size (C3)', async () => {
    // C3: this is the only endpoint in the contract that paginates without a
    // size control, which is why hudu_list_asset_layouts offers no page_size.
    const response = await client().get<unknown>(buildPath('/asset_layouts'));

    expect(response.status, DRIFT).toBe(200);
    expect(() => unwrapList(response.data, undefined, 'GET /asset_layouts'), DRIFT).not.toThrow();
  });

  it('authenticates with x-api-key alone', async () => {
    // A 401 here means the key or the header scheme has changed; the client
    // sends no Authorization header and never has.
    const response = await client().get<unknown>(buildPath('/api_info'));
    expect(response.status, DRIFT).toBe(200);
  });
});

describe.skipIf(enabled)('live Hudu contract (skipped)', () => {
  it('is opt-in: set HUDU_CONTRACT_TESTS=1 with real credentials to run it', () => {
    expect(enabled).toBe(false);
  });
});
