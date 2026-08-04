/**
 * Three things the resource factory has to get right about its own output.
 *
 * Each was a real defect rather than a hypothesis:
 *
 * 1. `hudu_get_asset` accepted `fields` and ignored it. Assets are read per
 *    company and the tool is hand-written, so it was missed when the generated
 *    get tools learned to project. The SDK strips undeclared arguments rather
 *    than rejecting them, so the caller saw a whole asset — layout values and
 *    all — after asking for two keys of it, and nothing said so.
 *
 * 2. The archived-companies caveat was bolted onto the generated list tool by a
 *    wrapper in `companies.ts`. It worked; it was also a per-resource special
 *    case sitting outside the generator, and the second resource needing one
 *    would have grown a second wrapper. It is now a `completenessCaveat` on the
 *    spec, so these tests drive the factory directly rather than only through
 *    the one resource that uses it today.
 *
 * 3. `GET /asset_layouts` documents `page` and no `page_size` (spec-defects.md
 *    C3), so this client sends none — and then reported `page_size: 25` anyway,
 *    which is this client's default for a parameter the request never carried.
 *    A caller told to lower a page size the endpoint does not accept has been
 *    handed a remedy that cannot work.
 *
 * These run through `executeTool`, so gating, stripping, the character budget
 * and rendering are all in the path.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE } from '../../src/config.js';
import { executeTool, prepareTool } from '../../src/tools/define.js';
import { buildListTool, type ResourceSpec } from '../../src/tools/resource.js';
import { companiesSpec } from '../../src/tools/companies.js';
import { testServer, toolJson, toolText } from '../helpers/fixtures.js';

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* 1. `fields` on the hand-written asset get                                   */
/* -------------------------------------------------------------------------- */

const LAYOUT_BLOB = Array.from({ length: 20 }, (_unused, index) => ({
  id: index + 1,
  label: `Field ${index + 1}`,
  value: 'v'.repeat(200),
  position: index + 1,
}));

const assetRecord = {
  id: 501,
  company_id: 42,
  name: 'FW01',
  asset_layout_id: 9,
  primary_serial: 'SN-0001',
  fields: LAYOUT_BLOB,
};

const cannedAsset = { json: { asset: assetRecord } };

describe('hudu_get_asset fields', () => {
  it('advertises the argument', () => {
    expect(
      Object.keys(testServer(cannedAsset).tool('hudu_get_asset').inputSchema),
      'accepting `fields` and ignoring it is the failure this closes',
    ).toContain('fields');
  });

  it('returns only the requested fields', async () => {
    const server = testServer(cannedAsset);

    const response = await server.call('hudu_get_asset', {
      company_id: 42,
      id: 501,
      fields: ['id', 'name'],
    });

    expect(toolJson(response)).toEqual({ id: 501, name: 'FW01' });
  });

  it('keeps the layout values out of the response when they were not asked for', async () => {
    const server = testServer(cannedAsset);

    const response = await server.call('hudu_get_asset', {
      company_id: 42,
      id: 501,
      fields: ['id', 'name'],
    });

    expect(toolText(response)).not.toContain('vvvv');
    expect(JSON.stringify(response.structuredContent)).not.toContain('vvvv');
  });

  it('can keep `fields` itself, which is a top-level key like any other', async () => {
    const server = testServer(cannedAsset);

    const response = await server.call('hudu_get_asset', {
      company_id: 42,
      id: 501,
      fields: ['id', 'fields'],
    });

    expect(asRecord(toolJson(response))['fields']).toEqual(LAYOUT_BLOB);
    expect(asRecord(toolJson(response))['name']).toBeUndefined();
  });

  it('projects the Markdown rendering too', async () => {
    const server = testServer(cannedAsset);

    const response = await server.call('hudu_get_asset', {
      company_id: 42,
      id: 501,
      fields: ['id', 'name'],
      response_format: 'markdown',
    });

    expect(toolText(response)).toContain('FW01');
    expect(toolText(response)).not.toContain('Primary serial');
  });

  it('returns the whole asset when `fields` is omitted', async () => {
    const server = testServer(cannedAsset);

    const response = await server.call('hudu_get_asset', { company_id: 42, id: 501 });

    expect(toolJson(response)).toEqual(assetRecord);
  });

  it('ignores unknown field names rather than failing the call', async () => {
    const server = testServer(cannedAsset);

    const response = await server.call('hudu_get_asset', {
      company_id: 42,
      id: 501,
      fields: ['id', 'not_a_field_on_this_layout'],
    });

    expect(response.isError).toBeUndefined();
    expect(toolJson(response)).toEqual({ id: 501 });
  });

  it('does not send `fields` to Hudu, which is not a documented parameter there', async () => {
    const server = testServer(cannedAsset);

    await server.call('hudu_get_asset', { company_id: 42, id: 501, fields: ['id'] });

    expect(server.http.last().search).toBe('');
  });

  it('still reports a missing asset as missing', async () => {
    const server = testServer({ status: 200, json: null });

    const response = await server.call('hudu_get_asset', {
      company_id: 42,
      id: 999,
      fields: ['id', 'name'],
    });

    expect(response.structuredContent).toMatchObject({ found: false, id: 999, company_id: 42 });
  });
});

/* -------------------------------------------------------------------------- */
/* 2. completenessCaveat, applied by the factory                               */
/* -------------------------------------------------------------------------- */

const CAVEAT = 'Test caveat: this endpoint cannot show the whole set.';

const caveatSpec: ResourceSpec = {
  key: 'widgets',
  singular: 'widget',
  title: 'Widget',
  titlePlural: 'Widgets',
  basePath: '/companies',
  summary: 'A synthetic resource, so this tests the generator and not one resource that uses it.',
  completenessCaveat: CAVEAT,
  paginated: true,
};

/** Run a tool built straight from a spec, without going through `server.ts`. */
const callSpecTool = async (
  spec: ResourceSpec,
  json: unknown,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> => {
  const server = testServer({ json });
  const response = await executeTool(prepareTool(buildListTool(spec)), args, {
    client: server.client,
    config: server.config,
  });
  return asRecord(toolJson(response));
};

describe('completenessCaveat reaches the envelope through the factory', () => {
  it('appends the caveat to pagination_note and carries it as its own key', async () => {
    const result = await callSpecTool(caveatSpec, [{ id: 1, name: 'One' }]);

    expect(result['completeness_caveat']).toBe(CAVEAT);
    expect(String(result['pagination_note'])).toContain(CAVEAT);
  });

  it('emits it on an empty result too, where "nothing matched" is most misleading', async () => {
    const result = await callSpecTool(caveatSpec, []);

    expect(result['count']).toBe(0);
    expect(result['completeness_caveat']).toBe(CAVEAT);
  });

  it('leaves a spec without one untouched', async () => {
    // Omitted rather than set to undefined: `exactOptionalPropertyTypes` makes
    // those two different specs, and the one a caller writes is this one.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { completenessCaveat: _absent, ...plainSpec } = caveatSpec;

    const result = await callSpecTool(plainSpec, [{ id: 1, name: 'One' }]);

    expect(result['completeness_caveat']).toBeUndefined();
    expect(String(result['pagination_note'])).not.toContain(CAVEAT);
  });

  it('survives truncation, which regenerates the note it rides on', async () => {
    const bulky = Array.from({ length: 40 }, (_unused, index) => ({
      id: index + 1,
      name: `Record ${index + 1}`,
      notes: 'n'.repeat(2000),
    }));

    const result = await callSpecTool(caveatSpec, bulky);

    expect(result['truncated']).toBe(true);
    expect(result['completeness_caveat']).toBe(CAVEAT);
    expect(String(result['pagination_note'])).toContain(CAVEAT);
  });

  it('is how hudu_list_companies gets its archived caveat, with no wrapper left', async () => {
    // The seam matters as much as the output: the caveat is declared on the
    // spec, so a second resource needing one does not grow a second wrapper.
    expect(companiesSpec.completenessCaveat).toBeDefined();

    const server = testServer({ json: [{ id: 1, name: 'Acme' }] });
    const result = asRecord(toolJson(await server.call('hudu_list_companies', {})));

    expect(result['completeness_caveat']).toBe(companiesSpec.completenessCaveat);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. asset_layouts must not report a page_size it never sent                   */
/* -------------------------------------------------------------------------- */

describe('a page-only endpoint reports no page_size it did not request', () => {
  const layouts = (count: number): Record<string, unknown>[] =>
    Array.from({ length: count }, (_unused, index) => ({ id: index + 1, name: `Layout ${index}` }));

  it('sends no page_size, as C3 requires', async () => {
    const server = testServer({ json: { asset_layouts: layouts(3) } });

    await server.call('hudu_list_asset_layouts', { page: 2 });

    expect(server.http.last().search).toContain('page=2');
    expect(server.http.last().search).not.toContain('page_size');
  });

  it('offers no page_size argument either', () => {
    expect(Object.keys(testServer().tool('hudu_list_asset_layouts').inputSchema)).not.toContain(
      'page_size',
    );
  });

  it('does not report this client’s default page size as though it were requested', async () => {
    const server = testServer({ json: { asset_layouts: layouts(3) } });

    const result = asRecord(toolJson(await server.call('hudu_list_asset_layouts', {})));

    expect(result['page_size']).not.toBe(DEFAULT_PAGE_SIZE);
    expect(result['page_size'], 'what came back, not what was asked for').toBe(3);
    expect(result['count']).toBe(3);
  });

  it('says in the note that no page size was requested and none can be lowered', async () => {
    const server = testServer({ json: { asset_layouts: layouts(3) } });

    const result = asRecord(toolJson(await server.call('hudu_list_asset_layouts', {})));
    const note = String(result['pagination_note']);

    expect(note).toContain('no page size was requested');
    expect(note, 'a partial page here does not prove the set is complete').not.toMatch(
      /last page|complete set/i,
    );
  });

  it('does not claim the set is finished when it cannot know', async () => {
    const server = testServer({ json: { asset_layouts: layouts(3) } });

    const result = asRecord(toolJson(await server.call('hudu_list_asset_layouts', {})));

    // Three records against an unknown server-chosen page size says nothing
    // about whether a fourth exists. Invariant 5: the unsafe direction is the
    // one that lets a partial list read as complete.
    expect(result['pagination_supported']).toBe(true);
    expect(result['next_page']).toBe(2);
  });

  it('stops offering a next page when the page came back empty', async () => {
    const server = testServer({ json: { asset_layouts: [] } });

    const result = asRecord(toolJson(await server.call('hudu_list_asset_layouts', { page: 4 })));

    expect(result['count']).toBe(0);
    expect(result['next_page']).toBeNull();
    expect(result['page_was_full']).toBe(false);
  });

  it('leaves an endpoint that does document page_size alone', async () => {
    const server = testServer({ json: { companies: [{ id: 1, name: 'Acme' }] } });

    const result = asRecord(toolJson(await server.call('hudu_list_companies', { page_size: 10 })));

    expect(result['page_size']).toBe(10);
  });
});
