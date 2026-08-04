/**
 * Output shaping.
 *
 * The strongest assertion in this file is a negative one: no pagination
 * envelope may carry `total`, `total_count` or `has_more`. No Hudu collection
 * endpoint returns a total, and there is no envelope, no `X-Total-Count` and no
 * `Link` header (docs/reference/spec-defects.md C1), so any of those three
 * would have to be invented — and an agent reading `has_more: false` would
 * describe a partial inventory as the whole thing. Their absence is a design
 * commitment (see the doc comment on `PageInfo`, and Invariant 5 in CLAUDE.md),
 * and this test is what stops someone helpfully adding them back.
 */

import { describe, expect, it } from 'vitest';

import {
  applyCharacterBudget,
  CHARACTER_LIMIT,
  type ListEnvelope,
  type PageInfo,
  pageInfo,
  projectFields,
  renderListMarkdown,
  renderRecordMarkdown,
  unpaginatedInfo,
} from '../../src/presentation/format.js';

const FORBIDDEN_KEYS = ['total', 'total_count', 'has_more'] as const;

const INVENTED_METADATA_GUARD =
  'INVENTED PAGINATION METADATA: the Hudu API returns no total count for any collection ' +
  '(spec-defects.md C1), so `total`, `total_count` and `has_more` cannot be derived and must ' +
  'never be emitted. An agent reading has_more:false would report a partial inventory as ' +
  'complete. See the doc comment on PageInfo and Invariant 5 in CLAUDE.md.';

const assertNoInventedMetadata = (value: object): void => {
  const keys = Object.keys(value);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(keys, INVENTED_METADATA_GUARD).not.toContain(forbidden);
  }
  const serialised = JSON.stringify(value);
  for (const forbidden of FORBIDDEN_KEYS) {
    expect(serialised, INVENTED_METADATA_GUARD).not.toContain(`"${forbidden}"`);
  }
};

describe('pageInfo', () => {
  it('marks a full page and offers the next one', () => {
    const info = pageInfo(1, 25, 25);
    expect(info.page_was_full).toBe(true);
    expect(info.next_page).toBe(2);
    expect(info.pagination_note).toContain('Request page 2');
  });

  it('marks a partial page as the last one', () => {
    const info = pageInfo(3, 25, 7);
    expect(info.page_was_full).toBe(false);
    expect(info.next_page).toBeNull();
    expect(info.pagination_note).toContain('last page');
  });

  it('treats an empty page as the end, never as a full page', () => {
    const info = pageInfo(1, 25, 0);
    expect(info.page_was_full).toBe(false);
    expect(info.next_page).toBeNull();
  });

  it('does not claim a next page when both count and page size are zero', () => {
    // count === page_size is true here, so the `count > 0` guard is what stops
    // an empty result advertising page 2.
    const info = pageInfo(1, 0, 0);
    expect(info.page_was_full).toBe(false);
    expect(info.next_page).toBeNull();
  });

  it('echoes the page and page size it was given', () => {
    const info = pageInfo(4, 10, 10);
    expect(info.page).toBe(4);
    expect(info.page_size).toBe(10);
    expect(info.count).toBe(10);
    expect(info.next_page).toBe(5);
  });

  it('says plainly that the remaining count is unknowable', () => {
    expect(pageInfo(1, 25, 25).pagination_note).toContain('no total count');
  });

  it.each([
    { label: 'full', page: 1, size: 25, count: 25 },
    { label: 'partial', page: 1, size: 25, count: 3 },
    { label: 'empty', page: 2, size: 25, count: 0 },
    { label: 'zero-size', page: 1, size: 0, count: 0 },
  ])('emits no invented metadata on a $label page', ({ page, size, count }) => {
    assertNoInventedMetadata(pageInfo(page, size, count));
  });
});

describe('unpaginatedInfo', () => {
  it.each([0, 1, 25, 10_000])('never claims a next page for %i records', (count) => {
    const info = unpaginatedInfo(count);
    expect(info.page_was_full, 'an unpaginated endpoint has no full page').toBe(false);
    expect(info.next_page, 'an unpaginated endpoint has no next page to fetch').toBeNull();
    expect(info.page).toBe(1);
    expect(info.count).toBe(count);
  });

  it('reports page_size as the whole result, since there is no page size', () => {
    expect(unpaginatedInfo(42).page_size).toBe(42);
  });

  it('states that the endpoint does not paginate at all', () => {
    const note = unpaginatedInfo(5).pagination_note;
    expect(note).toContain('does not support pagination');
    expect(note).toContain('complete set');
  });

  it.each([0, 1, 25, 10_000])('emits no invented metadata for %i records', (count) => {
    assertNoInventedMetadata(unpaginatedInfo(count));
  });

  it('never reports page_was_full true where pageInfo would have', () => {
    // The whole reason this function exists: pageInfo(1, n, n) says "full, fetch
    // page 2", which for a non-paginating endpoint is a fabricated instruction.
    const count = 12;
    expect(pageInfo(1, count, count).next_page).toBe(2);
    expect(unpaginatedInfo(count).next_page).toBeNull();
  });
});

describe('PageInfo shape', () => {
  it('exposes exactly the six honest fields', () => {
    const expected: (keyof PageInfo)[] = [
      'page',
      'page_size',
      'count',
      'page_was_full',
      'next_page',
      'pagination_note',
    ];
    expect(Object.keys(pageInfo(1, 25, 25)).sort()).toEqual([...expected].sort());
    expect(Object.keys(unpaginatedInfo(3)).sort()).toEqual([...expected].sort());
  });
});

describe('applyCharacterBudget', () => {
  const bigItem = (id: number): Record<string, unknown> => ({
    id,
    blob: 'x'.repeat(1000),
  });

  it('returns the envelope untouched when it already fits', () => {
    const envelope: ListEnvelope<Record<string, unknown>> = {
      ...pageInfo(1, 25, 2),
      items: [{ id: 1 }, { id: 2 }],
    };
    const output = applyCharacterBudget(envelope);
    expect(output).toBe(envelope);
    expect(output.truncated).toBeUndefined();
    expect(output.truncation_note).toBeUndefined();
  });

  it('truncates and always says so', () => {
    const items = Array.from({ length: 200 }, (_unused, index) => bigItem(index));
    const envelope: ListEnvelope<Record<string, unknown>> = {
      ...pageInfo(1, 200, items.length),
      items,
    };

    const output = applyCharacterBudget(envelope, 5000);

    expect(output.truncated).toBe(true);
    expect(output.truncation_note).toBeTruthy();
    expect(output.items.length).toBeLessThan(items.length);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(5000);
  });

  it('corrects count to match the items actually returned', () => {
    const items = Array.from({ length: 64 }, (_unused, index) => bigItem(index));
    const output = applyCharacterBudget({ ...pageInfo(1, 64, 64), items }, 4000);
    expect(output.count).toBe(output.items.length);
  });

  it('explains that truncation is a client-side cut, not the end of the data', () => {
    const items = Array.from({ length: 64 }, (_unused, index) => bigItem(index));
    const note =
      applyCharacterBudget({ ...pageInfo(1, 64, 64), items }, 4000).truncation_note ?? '';
    expect(note).toContain('client-side cut');
    expect(note).toContain('not the end of the data');
    expect(note).toContain('64');
  });

  it('keeps at least one record even when a single record blows the budget', () => {
    const items = [bigItem(1)];
    const output = applyCharacterBudget({ ...pageInfo(1, 1, 1), items }, 100);
    expect(output.items).toHaveLength(1);
    expect(output.truncated).toBe(true);
    expect(output.truncation_note).toBeTruthy();
  });

  it('leaves an empty list alone', () => {
    const envelope: ListEnvelope<Record<string, unknown>> = { ...pageInfo(1, 25, 0), items: [] };
    expect(applyCharacterBudget(envelope)).toBe(envelope);
  });

  it('defaults to the published character limit', () => {
    const items = Array.from({ length: 400 }, (_unused, index) => bigItem(index));
    const output = applyCharacterBudget({ ...pageInfo(1, 400, 400), items });
    expect(output.truncated).toBe(true);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  });

  it('emits no invented metadata even when truncating', () => {
    const items = Array.from({ length: 64 }, (_unused, index) => bigItem(index));
    assertNoInventedMetadata(applyCharacterBudget({ ...pageInfo(1, 64, 64), items }, 4000));
  });
});

describe('projectFields', () => {
  const items = [
    { id: 1, name: 'A', company_id: 5, notes: 'long' },
    { id: 2, name: 'B', company_id: 6, notes: 'longer' },
  ];

  it('keeps only the requested fields', () => {
    expect(projectFields(items, ['id', 'name'])).toEqual([
      { id: 1, name: 'A' },
      { id: 2, name: 'B' },
    ]);
  });

  it('ignores unknown field names rather than failing the call', () => {
    // The Hudu schema varies by version and by asset layout, so failing a whole
    // call because one requested field is absent trades a useful partial answer
    // for an error.
    expect(projectFields(items, ['id', 'not_a_field'])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('returns empty records when every requested field is unknown', () => {
    expect(projectFields(items, ['nope', 'also_nope'])).toEqual([{}, {}]);
  });

  it('returns a copy of everything when no fields are requested', () => {
    expect(projectFields(items, undefined)).toEqual(items);
    expect(projectFields(items, [])).toEqual(items);
    expect(projectFields(items, undefined)).not.toBe(items);
  });

  it('passes non-object items through untouched', () => {
    expect(projectFields(['a', 1, null], ['id'])).toEqual(['a', 1, null]);
  });

  it('does not mutate the input', () => {
    projectFields(items, ['id']);
    expect(items[0]).toEqual({ id: 1, name: 'A', company_id: 5, notes: 'long' });
  });
});

describe('markdown rendering', () => {
  it('renders a list with its pagination note', () => {
    const envelope: ListEnvelope<Record<string, unknown>> = {
      ...pageInfo(1, 25, 1),
      items: [{ id: 1, name: 'Acme', city: 'York' }],
    };
    const markdown = renderListMarkdown('Companies', envelope);
    expect(markdown).toContain('# Companies');
    expect(markdown).toContain('## Acme (id 1)');
    expect(markdown).toContain('**City**: York');
    expect(markdown).toContain(envelope.pagination_note);
  });

  it('says so when nothing matched', () => {
    const envelope: ListEnvelope<Record<string, unknown>> = { ...pageInfo(1, 25, 0), items: [] };
    expect(renderListMarkdown('Companies', envelope)).toContain('_No records matched._');
  });

  it('surfaces the truncation note in markdown too', () => {
    const envelope: ListEnvelope<Record<string, unknown>> = {
      ...pageInfo(1, 25, 1),
      items: [{ id: 1, name: 'Acme' }],
      truncated: true,
      truncation_note: 'cut short',
    };
    expect(renderListMarkdown('Companies', envelope)).toContain('cut short');
  });

  it('renders a single record and skips empty fields', () => {
    const markdown = renderRecordMarkdown('Company', {
      id: 1,
      name: 'Acme',
      nickname: null,
      notes: '',
    });
    expect(markdown).toContain('**Name**: Acme');
    expect(markdown).not.toContain('Nickname');
    expect(markdown).not.toContain('Notes');
  });
});
