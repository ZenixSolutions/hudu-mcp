/**
 * Tools driven end to end through `executeTool`, against a fake fetch.
 *
 * `buildServer` is a factory precisely so this is possible in-process: no
 * subprocess, no socket, no live Hudu. The tools here are exercised the same
 * way the SDK callback exercises them, so gating, stripping, budgeting and
 * error translation are all in the path.
 */

import { describe, expect, it } from 'vitest';

import { assetPasswordFixture, testServer, toolJson, toolText } from '../helpers/fixtures.js';

describe('list tools', () => {
  it('sends page and page_size on a paginated resource', async () => {
    const server = testServer({ json: [{ id: 1, name: 'Acme' }] });

    await server.call('hudu_list_companies', { page: 2, page_size: 50 });

    const request = server.http.last();
    expect(request.path).toBe('/api/v1/companies');
    expect(request.search).toContain('page=2');
    expect(request.search).toContain('page_size=50');
  });

  it('does not send page or page_size on an unpaginated resource', async () => {
    // /networks documents neither parameter (spec-defects.md C2). Sending them
    // would imply a paging model the endpoint does not have.
    const server = testServer({ json: [{ id: 1, name: 'LAN' }] });

    await server.call('hudu_list_networks', { company_id: 3 });

    const request = server.http.last();
    expect(request.path).toBe('/api/v1/networks');
    expect(request.search, 'an unpaginated endpoint must not be sent page').not.toContain('page');
    expect(request.search).toContain('company_id=3');
  });

  it.each([
    'hudu_list_networks',
    'hudu_list_ip_addresses',
    'hudu_list_rack_storages',
    'hudu_list_rack_storage_items',
    'hudu_list_uploads',
  ])('%s sends no paging parameters at all', async (name) => {
    const server = testServer({ json: [] });
    await server.call(name, {});
    expect(server.http.last().search).not.toMatch(/\bpage/);
  });

  it('reports an unpaginated result as complete rather than as a full first page', async () => {
    const server = testServer({ json: [{ id: 1 }, { id: 2 }] });

    const result = toolJson(await server.call('hudu_list_networks', {})) as Record<string, unknown>;

    expect(result['page_was_full']).toBe(false);
    expect(result['next_page']).toBeNull();
    expect(String(result['pagination_note'])).toContain('does not support pagination');
  });

  it('sends page but not page_size on /asset_layouts (defect C3)', async () => {
    const server = testServer({ json: [] });

    await server.call('hudu_list_asset_layouts', { page: 3 });

    expect(server.http.last().search).toContain('page=3');
    expect(server.http.last().search).not.toContain('page_size');
  });

  it('drops undefined filters instead of sending empty parameters', async () => {
    const server = testServer({ json: [] });

    await server.call('hudu_list_companies', { name: undefined, city: 'York' });

    expect(server.http.last().search).toBe('?city=York&page=1&page_size=25');
  });

  it('keeps a false filter, which is a meaningful Hudu value', async () => {
    const server = testServer({ json: [] });

    await server.call('hudu_list_companies', { archived: false });

    expect(server.http.last().search).toContain('archived=false');
  });

  it('projects to the requested fields and ignores unknown ones', async () => {
    const server = testServer({ json: [{ id: 1, name: 'Acme', city: 'York', notes: 'long' }] });

    const result = toolJson(
      await server.call('hudu_list_companies', { fields: ['id', 'name', 'nope'] }),
    ) as { items: Record<string, unknown>[] };

    expect(result.items).toEqual([{ id: 1, name: 'Acme' }]);
  });

  it('reports a full page as possibly having more', async () => {
    const items = Array.from({ length: 25 }, (_unused, index) => ({ id: index }));
    const server = testServer({ json: items });

    const result = toolJson(await server.call('hudu_list_companies', {})) as Record<
      string,
      unknown
    >;

    expect(result['page_was_full']).toBe(true);
    expect(result['next_page']).toBe(2);
  });

  it('renders markdown when asked', async () => {
    const server = testServer({ json: [{ id: 1, name: 'Acme' }] });

    const text = toolText(
      await server.call('hudu_list_companies', { response_format: 'markdown' }),
    );

    expect(text).toContain('# Companies');
    expect(text).toContain('## Acme (id 1)');
  });

  it('handles an enveloped list response', async () => {
    const server = testServer({ json: { assets: [{ id: 1, name: 'FW' }] } });

    const result = toolJson(await server.call('hudu_list_assets', {})) as {
      items: Record<string, unknown>[];
    };

    expect(result.items).toEqual([{ id: 1, name: 'FW' }]);
  });

  it('handles /asset_layouts returning one object instead of a list (defect B1)', async () => {
    const server = testServer({ json: { id: 4, name: 'Server' } });

    const result = toolJson(await server.call('hudu_list_asset_layouts', {})) as {
      items: Record<string, unknown>[];
      count: number;
    };

    expect(result.items).toEqual([{ id: 4, name: 'Server' }]);
    expect(result.count).toBe(1);
  });

  it('handles an empty body as an empty list', async () => {
    const server = testServer({ status: 200, text: '' });

    const result = toolJson(await server.call('hudu_list_companies', {})) as { items: unknown[] };

    expect(result.items).toEqual([]);
  });
});

describe('get tools', () => {
  it('percent-encodes the id into the path', async () => {
    const server = testServer({ json: { id: 42, name: 'Acme' } });

    await server.call('hudu_get_company', { id: 42 });

    expect(server.http.last().path).toBe('/api/v1/companies/42');
  });

  it('reports a 200 with no record as "not found" rather than as a null record', async () => {
    // GET /companies/{id} answers HTTP 200 with a body of `null` for an id that
    // does not exist (spec-defects.md F3), so this never reaches the error path.
    // A bare `null` here reads to a model as "the record is empty".
    const server = testServer({ status: 200, text: '' });

    const response = await server.call('hudu_get_company', { id: 1 });
    const result = response.structuredContent ?? {};

    expect(response.isError, 'a 200 with no record is an answer, not a failure').toBeUndefined();
    expect(result['found']).toBe(false);
    expect(result['id']).toBe(1);
    expect(result['record']).toBeNull();
    expect(toolText(response)).toContain('No company with id 1 exists on this Hudu instance');
  });

  it('reports a 200 with a null-valued envelope as "not found"', async () => {
    // The wrapped form of the same answer: `{"company": null}` must not be
    // handed back as a record whose sole field is empty.
    const server = testServer({ status: 200, json: { company: null } });

    const result = (await server.call('hudu_get_company', { id: 2 })).structuredContent ?? {};

    expect(result['found']).toBe(false);
    expect(result['id']).toBe(2);
  });

  it('turns a 404 into guidance instead of an exception', async () => {
    const server = testServer({ status: 404, json: { error: 'Not found' } });

    const response = await server.call('hudu_get_company', { id: 9999 });

    expect(response.isError).toBe(true);
    expect(toolText(response)).toContain('What to do:');
    expect(toolText(response)).toContain('No such record');
  });
});

describe('write tools', () => {
  it('wraps the create body under the documented key', async () => {
    const server = testServer({ status: 201, json: { company: { id: 1, name: 'Acme' } } });

    await server.call('hudu_create_company', { name: 'Acme', city: 'York' });

    expect(server.http.last().method).toBe('POST');
    expect(JSON.parse(server.http.last().body ?? '{}')).toEqual({
      company: { name: 'Acme', city: 'York' },
    });
  });

  it('omits the id and confirm arguments from an update body', async () => {
    const server = testServer({ json: { company: { id: 1 } } });

    await server.call('hudu_update_company', { id: 1, city: 'Leeds', confirm: true });

    expect(server.http.last().path).toBe('/api/v1/companies/1');
    expect(JSON.parse(server.http.last().body ?? '{}')).toEqual({ company: { city: 'Leeds' } });
  });

  it('archives through the dedicated sub-path', async () => {
    const server = testServer({ json: {} });

    await server.call('hudu_archive_company', { id: 5, archived: true });

    expect(server.http.last().method).toBe('PUT');
    expect(server.http.last().path).toBe('/api/v1/companies/5/archive');
  });

  it('unarchives through the dedicated sub-path', async () => {
    const server = testServer({ json: {} });

    await server.call('hudu_archive_company', { id: 5, archived: false });

    expect(server.http.last().path).toBe('/api/v1/companies/5/unarchive');
  });
});

describe('delete tools', () => {
  it('treats a 204 with no body as a successful delete', async () => {
    const server = testServer({ status: 204 }, { allowDestructive: true });

    const response = await server.call('hudu_delete_company', { id: 1, confirm: true });

    expect(response.isError).toBeUndefined();
    const result = response.structuredContent ?? {};
    expect(result['deleted']).toBe(true);
    expect(result['status']).toBe(204);
    expect(result).not.toHaveProperty('response');
    // The notice is prepended to the text so a model sees the impact first.
    expect(toolText(response)).toContain('cannot be undone');
  });

  it('treats DELETE /networks/{id} answering 200 with a message as success (defect B8)', async () => {
    const server = testServer(
      { status: 200, json: { message: 'Network deleted successfully' } },
      { allowDestructive: true },
    );

    const response = await server.call('hudu_delete_network', { id: 1, confirm: true });

    expect(response.isError).toBeUndefined();
    const result = response.structuredContent ?? {};
    expect(result['deleted']).toBe(true);
    expect(result['status']).toBe(200);
    expect(result['response']).toEqual({ message: 'Network deleted successfully' });
    expect(toolText(response)).toContain('cannot be undone');
  });
});

describe('error surfaces', () => {
  it('reports an HTML login page as guidance, not a parse crash', async () => {
    const server = testServer({
      status: 200,
      text: '<!DOCTYPE html><html><body>Sign in to continue</body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const response = await server.call('hudu_get_api_info', {});

    expect(response.isError).toBe(true);
    const text = toolText(response);
    expect(text).toContain('not valid JSON');
    expect(text).toContain('SSO');
    expect(text).toContain('proxy');
    expect(text).not.toContain('Unexpected token');
  });

  it('reports a 401 with configuration guidance rather than argument advice', async () => {
    const server = testServer({ status: 401, json: { error: 'unauthorized' } });

    const text = toolText(await server.call('hudu_get_api_info', {}));

    expect(text).toContain('HUDU_API_KEY');
    expect(text).toContain('cannot be fixed by changing tool arguments');
  });

  it('reports a 403 as a key-scope problem needing a new key', async () => {
    const server = testServer({ status: 403, json: { error: 'forbidden' } });

    const text = toolText(await server.call('hudu_list_passwords', {}));

    expect(text).toContain('scope');
    expect(text).toContain('new key is required');
  });

  it('reports a 429 after exhausting retries', async () => {
    const server = testServer({ status: 429, json: {} }, { maxRetries: 1 });

    const text = toolText(await server.call('hudu_list_companies', {}));

    expect(text).toContain('Rate limited');
    expect(server.http.requests).toHaveLength(2);
  });
});

describe('structured content', () => {
  it('returns both text and structured content for a list', async () => {
    const server = testServer({ json: [assetPasswordFixture()] });

    const response = await server.call('hudu_list_passwords', {});

    expect(response.structuredContent).toBeDefined();
    expect(response.structuredContent?.['items']).toBeInstanceOf(Array);
    expect(JSON.parse(toolText(response))).toEqual(response.structuredContent);
  });

  it('wraps a non-object result so structured content is always an object', async () => {
    // hudu_get_api_info returns the body as-is, so an empty one is a bare null.
    const server = testServer({ status: 200, text: '' });

    const response = await server.call('hudu_get_api_info', {});

    expect(response.structuredContent).toEqual({ result: null });
  });
});
