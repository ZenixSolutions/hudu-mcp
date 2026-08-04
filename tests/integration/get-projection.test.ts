/**
 * `fields` on the single-record read tools.
 *
 * Until 0.1.1 the generated `hudu_get_*` tools took an id and nothing else,
 * while the list tools took `fields`. A caller who had learned `fields` from
 * `hudu_list_companies` could pass it to `hudu_get_company`, watch it be
 * accepted — the SDK strips arguments a schema does not declare rather than
 * rejecting them — and receive the entire record, including whatever
 * multi-kilobyte HTML `notes` blob it carries. Nothing in the response said the
 * argument had been dropped.
 *
 * The projection is the same `projectFields` the list tools use, so these tests
 * cover the wiring rather than the algorithm.
 */

import { describe, expect, it } from 'vitest';

import { testServer, toolJson } from '../helpers/fixtures.js';

const NOTES_BLOB = `<div>${'x'.repeat(2000)}</div>`;

const companyRecord = {
  id: 42,
  name: 'Contoso',
  company_type: 'Client',
  notes: NOTES_BLOB,
  created_at: '2026-01-01T00:00:00Z',
};

const cannedCompany = { json: { company: companyRecord } };

describe('hudu_get_company fields', () => {
  it('advertises the argument at all', () => {
    const server = testServer(cannedCompany);

    expect(
      Object.keys(server.tool('hudu_get_company').inputSchema),
      'a schema that advertises no `fields` is the honest alternative, but the tool projects',
    ).toContain('fields');
  });

  it('returns only the requested fields', async () => {
    const server = testServer(cannedCompany);

    const response = await server.call('hudu_get_company', { id: 42, fields: ['id', 'name'] });

    expect(toolJson(response)).toEqual({ id: 42, name: 'Contoso' });
  });

  it('keeps the large blob out of the response the model reads', async () => {
    const server = testServer(cannedCompany);

    const response = await server.call('hudu_get_company', { id: 42, fields: ['id', 'name'] });

    expect(response.content[0]?.text).not.toContain('xxxx');
    expect(JSON.stringify(response.structuredContent)).not.toContain('xxxx');
  });

  it('projects the Markdown rendering too, not only the JSON', async () => {
    const server = testServer(cannedCompany);

    const response = await server.call('hudu_get_company', {
      id: 42,
      fields: ['id', 'name'],
      response_format: 'markdown',
    });

    const text = response.content[0]?.text ?? '';
    expect(text).toContain('Contoso');
    expect(text).not.toContain('Company type');
  });

  it('returns the whole record when `fields` is omitted', async () => {
    const server = testServer(cannedCompany);

    const response = await server.call('hudu_get_company', { id: 42 });

    expect(toolJson(response)).toEqual(companyRecord);
  });

  it('ignores unknown field names rather than failing the call', async () => {
    const server = testServer(cannedCompany);

    const response = await server.call('hudu_get_company', {
      id: 42,
      fields: ['id', 'not_a_field_on_this_instance'],
    });

    expect(response.isError).toBeUndefined();
    expect(toolJson(response)).toEqual({ id: 42 });
  });

  it('does not send `fields` to Hudu, which would reject it as a filter', async () => {
    const server = testServer(cannedCompany);

    await server.call('hudu_get_company', { id: 42, fields: ['id'] });

    expect(server.http.last().search).toBe('');
  });

  it('leaves a missing record reported as missing', async () => {
    const server = testServer({ status: 200, json: null });

    const response = await server.call('hudu_get_company', { id: 999, fields: ['id', 'name'] });

    // Read the structured payload, not the text: the text carries the notice.
    expect(response.structuredContent).toMatchObject({ found: false, id: 999 });
  });
});

describe('fields on other generated get tools', () => {
  it('projects a network the same way', async () => {
    const server = testServer({ json: { id: 3, name: 'Head Office', notes: 'long' } });

    const response = await server.call('hudu_get_network', { id: 3, fields: ['name'] });

    expect(toolJson(response)).toEqual({ name: 'Head Office' });
  });
});
