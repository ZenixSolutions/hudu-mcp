/**
 * What a list result claims about itself, end to end.
 *
 * Two ways this server can be confidently wrong, both found by an external
 * usability review of 0.1.0 and both fixed by disclosure rather than by
 * capability:
 *
 * 1. A truncated response whose head still described the untruncated one.
 *    `hudu_list_rack_storages` answered `page_size: 21`, `count: 5`,
 *    `page_was_full: false` and a note calling the set complete, with the
 *    correcting `truncated: true` twenty-seven kilobytes below, after `items`.
 *    Clients clip long tool results, so the claim was read and the correction
 *    was not.
 *
 * 2. `hudu_list_companies` omitting archived companies while reporting the page
 *    honestly. The instance held 27 companies, the tool returned 22, and 64
 *    assets pointed at company ids that no page of this tool will ever mention.
 *
 * These run through `executeTool`, so the character budget, stripping and
 * rendering are all in the path — the same code the SDK callback drives.
 */

import { describe, expect, it } from 'vitest';

import { testServer, toolJson, toolText } from '../helpers/fixtures.js';

/** Enough bulk to blow the 25,000-character budget several times over. */
const bulkyRecords = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: index + 1,
    name: `Record ${index + 1}`,
    notes: 'n'.repeat(2000),
  }));

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

describe('a truncated list corrects itself before it can be believed', () => {
  it('puts the truncation metadata ahead of items in key order', async () => {
    const server = testServer({ json: bulkyRecords(40) });

    const result = asRecord(toolJson(await server.call('hudu_list_companies', {})));
    const keys = Object.keys(result);

    expect(result['truncated'], 'this fixture must actually truncate').toBe(true);
    expect(keys.at(-1), 'items last, so nothing hides behind it').toBe('items');
    for (const field of ['truncated', 'truncation_note', 'records_on_page', 'pagination_note']) {
      expect(keys.indexOf(field), `${field} must precede items`).toBeLessThan(
        keys.indexOf('items'),
      );
    }
  });

  it('carries truncated: true in every serialised prefix that carries the note', async () => {
    const server = testServer({ json: bulkyRecords(40) });

    const text = toolText(await server.call('hudu_list_companies', {}));
    const prefix = text.slice(0, text.indexOf('"items"'));

    expect(prefix).toContain('"truncated": true');
    expect(prefix, 'a clipped read must still meet the correction').toContain('partial answer');
  });

  it('states the emitted count in the note and claims nothing complete', async () => {
    const server = testServer({ json: bulkyRecords(40) });

    const result = asRecord(toolJson(await server.call('hudu_list_companies', {})));
    const note = String(result['pagination_note']);

    expect(note).toContain(`${String(result['count'])} of the 40`);
    expect(result['count']).toBe((result['items'] as unknown[]).length);
    expect(result['records_on_page']).toBe(40);
    expect(note, 'a truncated page is not complete').not.toMatch(/complete/i);
    expect(note, 'a truncated page is not "the last page"').not.toContain('last page');
  });

  it('tells an unpaginated caller that records were dropped and filters are the only way back', async () => {
    // /networks documents neither page nor page_size (spec-defects.md C2), so
    // there is no page to fetch and no page_size to lower: the dropped records
    // are reachable only by narrowing the filters, and this must say so.
    const server = testServer({ json: bulkyRecords(40) });

    const result = asRecord(toolJson(await server.call('hudu_list_networks', {})));
    const note = String(result['pagination_note']);

    expect(result['truncated']).toBe(true);
    expect(result['pagination_supported']).toBe(false);
    expect(note).toMatch(/dropped/);
    expect(note).toContain('narrowing the filters is the only way');
    expect(note, 'the pre-truncation note called this the complete set').not.toMatch(/complete/i);
    expect(String(result['truncation_note'])).not.toContain('page_size');
  });

  it('warns above the records in markdown as well', async () => {
    const server = testServer({ json: bulkyRecords(40) });

    const text = toolText(
      await server.call('hudu_list_companies', { response_format: 'markdown' }),
    );

    expect(text.indexOf('**Truncated.**')).toBeLessThan(text.indexOf('## Record 1'));
  });

  it('still invents no totals while truncating', async () => {
    const server = testServer({ json: bulkyRecords(40) });

    const text = toolText(await server.call('hudu_list_companies', {}));

    for (const forbidden of ['"total"', '"total_count"', '"has_more"']) {
      expect(text, 'the Hudu API returns no total for any collection (C1)').not.toContain(
        forbidden,
      );
    }
  });
});

describe('hudu_list_companies discloses what it cannot show', () => {
  const ARCHIVED_MARKERS = ['Archived companies are missing', 'hudu_get_company'];

  it('says in its description that archived companies are excluded', () => {
    const description = testServer().tool('hudu_list_companies').description;

    for (const marker of ARCHIVED_MARKERS) expect(description).toContain(marker);
    expect(
      description,
      'no parameter fixes this, and saying so stops a fix being invented',
    ).toMatch(/no parameter to include archived/i);
  });

  it('offers no archived argument, because Hudu ignores one on this endpoint', () => {
    // `?archived=true` and `?archived=false` both returned the same 22 records
    // on 2.34.2, and /companies ignores unrecognised query parameters instead of
    // rejecting them the way /networks does. An argument here would look like a
    // working filter and do nothing.
    expect(Object.keys(testServer().tool('hudu_list_companies').inputSchema)).not.toContain(
      'archived',
    );
  });

  it('repeats the caveat in the note a caller reads before believing the list', async () => {
    const server = testServer({ json: [{ id: 1, name: 'Acme' }] });

    const result = asRecord(toolJson(await server.call('hudu_list_companies', {})));

    expect(String(result['pagination_note'])).toContain('Archived companies are missing');
    expect(String(result['completeness_caveat'])).toContain('hudu_get_company');
  });

  it('keeps the caveat when the same result is truncated', async () => {
    const server = testServer({ json: bulkyRecords(40) });

    const result = asRecord(toolJson(await server.call('hudu_list_companies', {})));

    expect(result['truncated']).toBe(true);
    expect(String(result['pagination_note'])).toContain('Archived companies are missing');
  });

  it('leaves other list tools alone', async () => {
    const server = testServer({ json: [{ id: 1, name: 'LAN' }] });

    const result = asRecord(toolJson(await server.call('hudu_list_networks', {})));

    expect(result['completeness_caveat']).toBeUndefined();
    expect(String(result['pagination_note'])).not.toContain('Archived companies');
  });

  it('carries the caveat into markdown, which renders the note', async () => {
    const server = testServer({ json: [{ id: 1, name: 'Acme' }] });

    const text = toolText(
      await server.call('hudu_list_companies', { response_format: 'markdown' }),
    );

    expect(text).toContain('Archived companies are missing');
  });
});
