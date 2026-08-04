/**
 * Output shaping and token budgeting.
 *
 * Tool output is the model's whole view of Hudu. Two failure modes matter and
 * both are avoidable here: dumping a raw pretty-printed payload burns context
 * that the task needs, and truncating without saying so makes a partial answer
 * look complete.
 */

import { DEFAULT_PAGE_SIZE } from '../config.js';

/** Soft ceiling on a single tool response, in characters. */
export const CHARACTER_LIMIT = 25_000;

export const ResponseFormat = {
  Markdown: 'markdown',
  Json: 'json',
} as const;

export type ResponseFormat = (typeof ResponseFormat)[keyof typeof ResponseFormat];

/**
 * Pagination metadata for a list result.
 *
 * Deliberately missing: `total`, `total_count` and `has_more`.
 *
 * Hudu's list endpoints return a bare array. There is no envelope, no total,
 * and no link header — so a total would have to be invented, and `has_more`
 * cannot be known without issuing the next request. Reporting `has_more: false`
 * on a guess would make an agent describe a partial inventory as the whole
 * thing, which is worse than reporting nothing. What we can say honestly is
 * whether the page came back full, which is the actual signal that more may
 * exist.
 */
export interface PageInfo {
  readonly page: number;
  readonly page_size: number;
  readonly count: number;
  /** True when `count === page_size`, i.e. another page may exist. */
  readonly page_was_full: boolean;
  readonly next_page: number | null;
  /** Plain-language statement of what is and is not known. */
  readonly pagination_note: string;
}

export function pageInfo(page: number, pageSize: number, count: number): PageInfo {
  const full = count === pageSize && count > 0;
  return {
    page,
    page_size: pageSize,
    count,
    page_was_full: full,
    next_page: full ? page + 1 : null,
    pagination_note: full
      ? `This page is full (${count} of a requested ${pageSize}), so more records probably ` +
        `exist. Request page ${page + 1} to continue. The Hudu API returns no total count, ` +
        'so the number of remaining records is not knowable without paging through.'
      : `Returned ${count} record(s) against a page size of ${pageSize}. A partial page means ` +
        'this is the last page for the current filters.',
  };
}

/**
 * Page info for an endpoint that has no pagination at all.
 *
 * Several Hudu collections — networks, IP addresses, racks, rack items, uploads
 * — document neither `page` nor `page_size`. Reusing {@link pageInfo} there
 * would report `page_was_full: true` and `next_page: 2` for any non-empty
 * result, sending an agent to fetch a page that does not exist and, worse,
 * implying the first response was partial when it was the entire collection.
 */
export function unpaginatedInfo(count: number): PageInfo {
  return {
    page: 1,
    page_size: count,
    count,
    page_was_full: false,
    next_page: null,
    pagination_note:
      `Returned ${count} record(s). This Hudu endpoint does not support pagination at all — ` +
      'there is no page or page_size parameter and no further page to request, so this is the ' +
      'complete set for the filters given. If the response is marked truncated, that is a ' +
      'client-side output-budget cut and the only way to see the rest is to narrow the filters.',
  };
}

export interface ListEnvelope<T> extends PageInfo {
  readonly items: readonly T[];
  readonly truncated?: boolean;
  readonly truncation_note?: string;
}

/**
 * Drop items until the serialised payload fits the character budget.
 *
 * Halving rather than trimming one at a time: a single oversized record would
 * otherwise cost one serialisation pass per item removed.
 */
export function applyCharacterBudget<T>(
  envelope: ListEnvelope<T>,
  limit = CHARACTER_LIMIT,
): ListEnvelope<T> {
  let items = envelope.items;
  let serialised = JSON.stringify({ ...envelope, items });

  if (serialised.length <= limit) return envelope;

  const original = items.length;
  while (items.length > 1 && serialised.length > limit) {
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    serialised = JSON.stringify({ ...envelope, items });
  }

  return {
    ...envelope,
    items,
    count: items.length,
    truncated: true,
    truncation_note:
      `Response truncated from ${original} to ${items.length} record(s) to stay within the ` +
      `${limit}-character response budget. This is a client-side cut, not the end of the ` +
      'data: lower page_size, add filters, or request specific ids to see the rest.',
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Project each record down to a field subset.
 *
 * Unknown field names are ignored rather than rejected: the Hudu schema varies
 * by version and by asset layout, and failing a whole call because one
 * requested field is absent on this instance trades a useful partial answer for
 * an error.
 */
export function projectFields<T>(items: readonly T[], fields: readonly string[] | undefined): T[] {
  if (!fields || fields.length === 0) return [...items];
  const wanted = new Set(fields);
  return items.map((item) => {
    if (!isPlainObject(item)) return item;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      if (wanted.has(key)) output[key] = value;
    }
    return output as T;
  });
}

/** Longest single value rendered into Markdown before it is cut. */
export const VALUE_DISPLAY_LIMIT = 300;

/**
 * Marker left where a value was cut short.
 *
 * A bare ellipsis is not enough. Markdown rendering shortens *every* value to
 * {@link VALUE_DISPLAY_LIMIT} characters, so `hudu_get_article` in Markdown
 * returns the first three hundred characters of a runbook and nothing says the
 * rest exists. That is the same failure Invariant 5 forbids for pagination —
 * a partial answer that reads as a complete one — so the cut is named, and
 * {@link VALUE_TRUNCATION_NOTE} is appended whenever one happened.
 */
export const VALUE_TRUNCATION_MARKER = '…[value truncated]';

export const VALUE_TRUNCATION_NOTE =
  `One or more values above end in ${VALUE_TRUNCATION_MARKER}: Markdown rendering shortens any ` +
  `single value to ${VALUE_DISPLAY_LIMIT} characters. Those values are incomplete. Re-request ` +
  'with response_format: "json" to read them in full, and do not summarise a truncated value ' +
  'as if it were the whole thing.';

const withTruncationNote = (lines: readonly string[]): string => {
  const body = lines.join('\n');
  return body.includes(VALUE_TRUNCATION_MARKER) ? `${body}\n\n${VALUE_TRUNCATION_NOTE}` : body;
};

const humanise = (key: string): string =>
  key.replace(/_/g, ' ').replace(/^./, (character) => character.toUpperCase());

/**
 * Render any value as short display text.
 *
 * Every branch is explicit because the input is genuinely `unknown` — Hudu
 * asset fields hold whatever the layout defines. A bare `String(value)` here
 * would print `[object Object]` into a tool result, which reads to a model as
 * real data rather than as a rendering failure.
 */
export const toDisplayText = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return shorten(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'object') return shorten(JSON.stringify(value));
  return `[${typeof value}]`;
};

const shorten = (text: string): string =>
  text.length > VALUE_DISPLAY_LIMIT
    ? `${text.slice(0, VALUE_DISPLAY_LIMIT)}${VALUE_TRUNCATION_MARKER}`
    : text;

const scalarToText = toDisplayText;

/** Render a list envelope as Markdown for human-facing clients. */
export function renderListMarkdown<T>(
  title: string,
  envelope: ListEnvelope<T>,
  titleField = 'name',
): string {
  const lines: string[] = [`# ${title}`, ''];
  lines.push(
    `Page ${envelope.page} · ${envelope.count} record(s) · page size ${envelope.page_size}`,
  );
  lines.push('');

  if (envelope.count === 0) {
    lines.push('_No records matched._');
    lines.push('');
    lines.push(envelope.pagination_note);
    return withTruncationNote(lines);
  }

  for (const item of envelope.items) {
    if (!isPlainObject(item)) {
      lines.push(`- ${scalarToText(item)}`);
      continue;
    }
    const heading = item[titleField] ?? item['name'] ?? item['title'] ?? item['id'];
    const identifier = item['id'] === undefined ? '' : ` (id ${scalarToText(item['id'])})`;
    lines.push(`## ${scalarToText(heading)}${identifier}`);
    for (const [key, value] of Object.entries(item)) {
      if (key === titleField || key === 'id') continue;
      if (value === null || value === undefined || value === '') continue;
      lines.push(`- **${humanise(key)}**: ${scalarToText(value)}`);
    }
    lines.push('');
  }

  lines.push(envelope.pagination_note);
  if (envelope.truncation_note) lines.push('', envelope.truncation_note);
  return withTruncationNote(lines);
}

/** Render a single record as Markdown. */
export function renderRecordMarkdown(title: string, record: unknown): string {
  if (!isPlainObject(record)) return withTruncationNote([`# ${title}`, '', scalarToText(record)]);
  const lines: string[] = [`# ${title}`, ''];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === '') continue;
    lines.push(`- **${humanise(key)}**: ${scalarToText(value)}`);
  }
  return withTruncationNote(lines);
}

export { DEFAULT_PAGE_SIZE };
