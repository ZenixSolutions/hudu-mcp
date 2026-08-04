/**
 * Regressions for behaviour measured against a live Hudu 2.34.2 instance.
 *
 * Everything asserted here contradicts `docs/reference/api-docs.json` and is
 * recorded in `docs/reference/spec-defects.md` section F. The contract tests in
 * `tests/contract/` observe the live API and are opt-in; these are mocked, run
 * in CI, and fail if the code is ever moved back to what the document says.
 *
 * The envelope cases carry the most weight. A wrong `listKey` does not throw —
 * `unwrapList` returns an empty array — and an agent reads an empty list as
 * "there are none of these", so a broken tool looks like an empty tenant. A
 * wrong `recordKey` is quieter still: the tool returns `{"company": {...}}`
 * where a company was asked for, and every field lookup on it silently misses.
 */

import { describe, expect, it } from 'vitest';

import { unwrapList, unwrapRecord } from '../../src/api/envelope.js';
import { errorFromResponse } from '../../src/api/errors.js';
import { assetLayoutsSpec, assetsListSpec } from '../../src/tools/assets.js';
import { companiesSpec } from '../../src/tools/companies.js';
import { articlesSpec, foldersSpec, proceduresSpec } from '../../src/tools/content.js';
import { usersSpec } from '../../src/tools/admin.js';
import { matchersSpec, relationsSpec } from '../../src/tools/monitoring.js';
import type { ResourceSpec } from '../../src/tools/resource.js';
import { testServer, toolText } from '../helpers/fixtures.js';

/* -------------------------------------------------------------------------- */
/* F1: list envelopes                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every list endpoint observed to wrap its array, with the tool that reads it.
 *
 * Six of these tools declared no `listKey` at all and returned empty in
 * production. The table is written from the observation, not from the specs, so
 * that a spec regressing to `undefined` fails here.
 */
const WRAPPED_LISTS: readonly {
  readonly tool: string;
  readonly key: string;
  readonly args?: Record<string, unknown>;
}[] = [
  { tool: 'hudu_list_companies', key: 'companies' },
  { tool: 'hudu_list_asset_layouts', key: 'asset_layouts' },
  { tool: 'hudu_list_articles', key: 'articles' },
  { tool: 'hudu_list_folders', key: 'folders' },
  { tool: 'hudu_list_relations', key: 'relations' },
  { tool: 'hudu_list_users', key: 'users' },
  { tool: 'hudu_list_assets', key: 'assets' },
  { tool: 'hudu_list_company_assets', key: 'assets', args: { company_id: 3 } },
  { tool: 'hudu_list_procedures', key: 'procedures' },
  { tool: 'hudu_list_public_photos', key: 'public_photos' },
  { tool: 'hudu_list_matchers', key: 'matchers', args: { integration_id: 5 } },
];

describe('F1: wrapped list responses unwrap to records, not to an empty list', () => {
  for (const { tool, key, args } of WRAPPED_LISTS) {
    it(`${tool} reads the "${key}" envelope`, async () => {
      const records = [
        { id: 1, name: 'first' },
        { id: 2, name: 'second' },
      ];
      const server = testServer({ json: { [key]: records } });

      const result = (await server.call(tool, args ?? {})).structuredContent ?? {};

      expect(
        result['items'],
        `${tool} returned nothing from a body wrapped under "${key}". An empty list here is ` +
          'not an error a caller can see — it reads as an empty Hudu instance.',
      ).toEqual(records);
      expect(result['count']).toBe(2);
    });
  }
});

/**
 * The declared key, asserted against the observation directly.
 *
 * `unwrapList` falls back to "the only array-valued property" when no key is
 * declared, which happens to rescue a single-array body — so the behavioural
 * test above would pass on a spec that declares nothing. This one would not.
 * The fallback is a safety net for drift, not a substitute for knowing the key.
 */
const SPECS_WITH_LIST_KEY: readonly (readonly [ResourceSpec, string])[] = [
  [companiesSpec, 'companies'],
  [assetLayoutsSpec, 'asset_layouts'],
  [articlesSpec, 'articles'],
  [foldersSpec, 'folders'],
  [relationsSpec, 'relations'],
  [usersSpec, 'users'],
  [assetsListSpec, 'assets'],
  [proceduresSpec, 'procedures'],
  [matchersSpec, 'matchers'],
];

describe('F1: each ResourceSpec declares the envelope key that was observed', () => {
  for (const [spec, key] of SPECS_WITH_LIST_KEY) {
    it(`${spec.basePath} declares listKey "${key}"`, () => {
      expect(spec.listKey).toBe(key);
    });
  }

  it('prefers the declared key over an incidental array elsewhere on the body', () => {
    // Synthetic, and deliberately so: it demonstrates what the fallback cannot
    // do. With two array-valued keys and no declared key, `unwrapList` refuses
    // to guess and throws; with the key declared, it reads the right one.
    const body = { companies: [{ id: 1 }], errors: [] };

    expect(unwrapList(body, 'companies', 'GET /companies')).toEqual([{ id: 1 }]);
    expect(() => unwrapList(body, undefined, 'GET /companies')).toThrow();
  });

  it('still tolerates a bare array, which most Hudu collections return', () => {
    expect(unwrapList([{ id: 1 }], 'companies', 'GET /companies')).toEqual([{ id: 1 }]);
  });

  it('still promotes a single object when the declared key is absent (defect B1)', () => {
    // B1 predicted `GET /asset_layouts` returning one bare object. The live run
    // found a wrapped array instead, but declaring the key must not remove the
    // tolerance — an endpoint that changes shape should not report zero records.
    expect(unwrapList({ id: 4 }, 'asset_layouts', 'GET /asset_layouts')).toEqual([{ id: 4 }]);
  });
});

/* -------------------------------------------------------------------------- */
/* F2: single-record envelopes                                                 */
/* -------------------------------------------------------------------------- */

const WRAPPED_RECORDS: readonly {
  readonly tool: string;
  readonly key: string;
  readonly args: Record<string, unknown>;
}[] = [
  { tool: 'hudu_get_company', key: 'company', args: { id: 1 } },
  { tool: 'hudu_get_asset', key: 'asset', args: { company_id: 3, id: 1 } },
  { tool: 'hudu_get_asset_layout', key: 'asset_layout', args: { id: 1 } },
  { tool: 'hudu_get_article', key: 'article', args: { id: 1 } },
  { tool: 'hudu_get_folder', key: 'folder', args: { id: 1 } },
  { tool: 'hudu_get_procedure', key: 'procedure', args: { id: 1 } },
  { tool: 'hudu_get_user', key: 'user', args: { id: 1 } },
];

describe('F2: wrapped single records unwrap to the record, not to the wrapper', () => {
  for (const { tool, key, args } of WRAPPED_RECORDS) {
    it(`${tool} reads the "${key}" envelope`, async () => {
      const record = { id: 1, name: 'Acme' };
      const server = testServer({ json: { [key]: record } });

      const result = (await server.call(tool, args)).structuredContent ?? {};

      expect(
        result,
        `${tool} returned the {"${key}": ...} wrapper rather than the record inside it. Every ` +
          'field lookup a caller makes on that object misses.',
      ).toEqual(record);
      expect(result).not.toHaveProperty(key);
    });
  }

  it('still returns an unwrapped body unchanged', () => {
    expect(unwrapRecord({ id: 1 }, 'company')).toEqual({ id: 1 });
  });
});

/* -------------------------------------------------------------------------- */
/* F3: a get can succeed and find nothing                                      */
/* -------------------------------------------------------------------------- */

describe('F3: a 200 with no record is reported as "not found", not as null', () => {
  // GET /companies/999999999 and GET /articles/999999999 both answer HTTP 200
  // with a body of `null` on 2.34.2, so this never reaches the error path.
  for (const { tool, args } of [
    { tool: 'hudu_get_company', args: { id: 999_999_999 } },
    { tool: 'hudu_get_article', args: { id: 999_999_999 } },
    { tool: 'hudu_get_asset', args: { company_id: 3, id: 999_999_999 } },
  ]) {
    it(`${tool} names the id and says the record does not exist`, async () => {
      const server = testServer({ status: 200, json: null });

      const response = await server.call(tool, args);
      const result = response.structuredContent ?? {};

      expect(response.isError, 'the request succeeded; only the record is missing').toBeUndefined();
      expect(result['found']).toBe(false);
      expect(result['record']).toBeNull();
      expect(result['id']).toBe(999_999_999);
      expect(toolText(response)).toContain('999999999');
      expect(toolText(response)).toMatch(/does not exist|No .* with id/i);
    });
  }

  it('does not fabricate a 404 for a successful call', async () => {
    const server = testServer({ status: 200, json: null });

    const response = await server.call('hudu_get_company', { id: 42 });

    expect(response.isError).toBeUndefined();
    expect(toolText(response)).not.toContain('404');
  });

  it('still returns the record when there is one', async () => {
    const server = testServer({ json: { company: { id: 42, name: 'Acme' } } });

    const result = (await server.call('hudu_get_company', { id: 42 })).structuredContent ?? {};

    expect(result).toEqual({ id: 42, name: 'Acme' });
  });
});

/* -------------------------------------------------------------------------- */
/* F5: a scope failure is 401                                                  */
/* -------------------------------------------------------------------------- */

describe('F5: 401 guidance names key scope as well as a bad key', () => {
  const guidanceFor = (status: number): string =>
    errorFromResponse({ status, statusText: '', method: 'GET', url: '' }).guidance;

  it('names scope, which is what a password-less key hits on /asset_passwords', () => {
    const guidance = guidanceFor(401);
    expect(guidance).toMatch(/scope/i);
    expect(guidance).toContain('asset_passwords');
  });

  it('still names a bad, expired or IP-blocked key, which looks identical', () => {
    expect(guidanceFor(401)).toContain('HUDU_API_KEY');
  });

  it('keeps the 403 branch but marks it unobserved', () => {
    const guidance = guidanceFor(403);
    expect(guidance).toMatch(/scope/i);
    expect(guidance).toMatch(/no 403 was observed|unconfirmed/i);
  });

  it('surfaces the scope cause through a tool call, where an operator sees it', async () => {
    const server = testServer({ status: 401, json: { error: 'unauthorized' } });

    const text = toolText(await server.call('hudu_list_passwords', {}));

    expect(text).toMatch(/scope/i);
  });
});

/* -------------------------------------------------------------------------- */
/* F6: /matchers answers 500 without integration_id                            */
/* -------------------------------------------------------------------------- */

describe('F6: hudu_list_matchers explains the 500 that a missing integration_id causes', () => {
  it('says a server error there means a missing parameter, not an outage', () => {
    const description = testServer().tool('hudu_list_matchers').description;

    expect(description).toContain('500');
    expect(description).toMatch(/an outage/i);
    expect(description).toContain('integration_id');
  });
});

/* -------------------------------------------------------------------------- */
/* F7: values the contract left undocumented                                   */
/* -------------------------------------------------------------------------- */

/** Parse one argument against a registered tool's schema. */
const accepts = (tool: string, args: Record<string, unknown>): boolean =>
  testServer().tool(tool).inputSchema[Object.keys(args)[0]!]?.safeParse(args[Object.keys(args)[0]!])
    .success === true;

describe('F7: schemas do not reject values the API demonstrably uses', () => {
  it.each(['Assigned', 'DHCP', 'Reserved', 'Unassigned'])(
    'hudu_update_ip_address accepts the observed status %s',
    (status) => {
      // These are the four capitalised values the live instance returned. The
      // previous z.enum held the six lower-case values from the schema prose
      // and would have rejected every one of them locally.
      expect(accepts('hudu_update_ip_address', { status })).toBe(true);
    },
  );

  it.each(['unassigned', 'assigned', 'reserved', 'deprecated', 'dhcp', 'slaac'])(
    'hudu_update_ip_address still accepts the documented status %s',
    (status) => {
      expect(accepts('hudu_update_ip_address', { status })).toBe(true);
    },
  );

  it('the ip status description names both the documented and the observed values', () => {
    const description = String(
      testServer().tool('hudu_update_ip_address').inputSchema['status']?.description,
    );

    expect(description).toContain('slaac');
    expect(description).toContain('DHCP');
    expect(description).toMatch(/2\.34\.2/);
  });

  it.each(['Article', 'Asset', 'AssetPassword', 'Procedure', 'IpAddress', 'Website', 'Company'])(
    'hudu_create_relation accepts the relation type %s',
    (type) => {
      // IpAddress appears in no published list and is real; the previous
      // z.enum would have refused to create a relation to one.
      expect(accepts('hudu_create_relation', { fromable_type: type })).toBe(true);
      expect(accepts('hudu_create_relation', { toable_type: type })).toBe(true);
    },
  );

  it('the relation type description names IpAddress as observed', () => {
    const description = String(
      testServer().tool('hudu_create_relation').inputSchema['fromable_type']?.description,
    );

    expect(description).toContain('IpAddress');
    expect(description).toMatch(/2\.34\.2/);
  });

  it.each(['front', 'rear', 'both'])(
    'hudu_update_rack_storage_item accepts the observed side %s',
    (side) => {
      // The body schema types `side` as an integer (B7). The instance stores
      // lower-case strings, so the integer typing is contradicted outright.
      expect(accepts('hudu_update_rack_storage_item', { side })).toBe(true);
    },
  );

  it.each(['reserved', 'used'])(
    'hudu_update_rack_storage_item accepts the observed status %s',
    (status) => {
      expect(accepts('hudu_update_rack_storage_item', { status })).toBe(true);
    },
  );

  it('sends the observed rack values through to Hudu unaltered', async () => {
    const server = testServer({ json: {} }, { allowDestructive: true });

    await server.call('hudu_update_rack_storage_item', {
      id: 1,
      side: 'both',
      status: 'reserved',
      confirm: true,
    });

    expect(JSON.parse(server.http.last().body ?? '{}')).toEqual({
      rack_storage_item: { side: 'both', status: 'reserved' },
    });
  });

  it('describes network_type with the only value observed on the instance', () => {
    const description = String(
      testServer().tool('hudu_create_network').inputSchema['network_type']?.description,
    );

    expect(description).toMatch(/observed/i);
    expect(description).toMatch(/2\.34\.2/);
  });
});
