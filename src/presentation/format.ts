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
 *
 * One naming decision is worth stating outright, because the two numbers used
 * to blur together under truncation: **`count` is always the number of records
 * in `items`**, and nothing else. Before the character budget runs that is also
 * the number Hudu returned for the page; after it runs the two differ, and the
 * page figure is reported separately as `records_on_page` rather than left
 * hiding inside `count`. `page_size` is the *requested* page size and never
 * changes, so `page_was_full: true` alongside a smaller `count` is not a
 * contradiction — it means the page was full and this response does not carry
 * all of it.
 */
export interface PageInfo {
  readonly page: number;
  readonly page_size: number;
  /** Number of records in `items`. Never the number Hudu returned for the page. */
  readonly count: number;
  /** True when the page came back full, i.e. another page may exist. */
  readonly page_was_full: boolean;
  readonly next_page: number | null;
  /** False when the endpoint documents no `page` parameter at all. */
  readonly pagination_supported: boolean;
  /**
   * False when the endpoint pages but documents no `page_size`.
   *
   * `GET /asset_layouts` is the only such endpoint in the captured contract, and
   * it matters exactly once: in the truncation remedies. Advising a caller to
   * lower a `page_size` that the endpoint rejects sends them to fix the response
   * in the one way that cannot work.
   */
  readonly page_size_supported: boolean;
  /** Plain-language statement of what is and is not known. */
  readonly pagination_note: string;
}

export function pageInfo(
  page: number,
  pageSize: number,
  count: number,
  options: { pageSizeSupported?: boolean } = {},
): PageInfo {
  const pageSizeSupported = options.pageSizeSupported !== false;

  // Without a requested size there is nothing to compare the count against, so
  // whether the page came back full is simply unknown. Erring towards "another
  // page may exist" is the safe direction: the cost of an extra request that
  // returns nothing is one call, and the cost of the other error is an agent
  // reporting a partial inventory as the whole thing.
  const full = pageSizeSupported ? count === pageSize && count > 0 : count > 0;

  return {
    page,
    page_size: pageSize,
    count,
    page_was_full: full,
    next_page: full ? page + 1 : null,
    pagination_supported: true,
    page_size_supported: pageSizeSupported,
    pagination_note: !pageSizeSupported
      ? `Returned ${count} record(s) on page ${page}. This Hudu endpoint documents \`page\` but ` +
        'no `page_size`, so no page size was requested and the server chose its own — the ' +
        `page_size above reports the ${count} record(s) this page actually held, not a size this ` +
        'client asked for, and there is no page_size parameter to lower. Whether the page came ' +
        'back full is therefore not knowable from this response' +
        (count > 0
          ? `: request page ${page + 1} to find out, and read an empty page as the end of the ` +
            'data.'
          : '. An empty page means there is nothing further to read.')
      : full
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
    pagination_supported: false,
    page_size_supported: false,
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
  /**
   * How many records Hudu returned for this page, present only when fewer were
   * emitted. `count` is the number in `items`; this is the number the page held.
   */
  readonly records_on_page?: number;
  readonly truncation_note?: string;
  /**
   * A standing limit on what this list can contain at all, independent of paging.
   *
   * Set by {@link withCompletenessCaveat}. It is also appended to
   * `pagination_note`, because that is the field a caller reads before deciding
   * a list is the whole picture — and it is carried as its own key so that
   * regenerating the note under truncation cannot silently drop it.
   */
  readonly completeness_caveat?: string;
}

/**
 * Append a standing caveat about what a list can never contain.
 *
 * `pagination_note` answers "is there another page?", and for most resources
 * that is the whole question. For a few it is not: `GET /companies` omits
 * archived companies and offers no parameter to include them, so a note saying
 * "this is the last page for the current filters" is true about the paging and
 * misleading about the universe. The caveat rides on the note rather than
 * beside it so that a caller reading only that field still sees it.
 */
export function withCompletenessCaveat<T>(
  envelope: ListEnvelope<T>,
  caveat: string,
): ListEnvelope<T> {
  const { items, ...meta } = envelope;
  return {
    ...meta,
    pagination_note: `${meta.pagination_note} ${caveat}`,
    completeness_caveat: caveat,
    items,
  };
}

/**
 * Restate a pagination note in terms of what was actually emitted.
 *
 * The note is generated before the character budget runs, so after a cut it
 * describes a response that was never sent — Hudu's figure for the page, plus,
 * on a partial page, the claim that the set is complete. Left alone that turns
 * the truncation notice into a contradiction of the metadata above it, and a
 * reader who believes the note reports a partial inventory as whole.
 */
function truncatedPaginationNote<T>(
  envelope: ListEnvelope<T>,
  onPage: number,
  emitted: number,
): string {
  const dropped = onPage - emitted;
  const core =
    `${emitted} of the ${onPage} record(s) Hudu returned are in \`items\`; ${dropped} were ` +
    "dropped to fit this client's output budget, so this is a partial answer.";

  const body = envelope.pagination_supported
    ? `Page ${envelope.page}: ${core} ` +
      (envelope.page_was_full
        ? `The page itself came back full (${onPage} of a requested ${envelope.page_size}), so ` +
          `more records probably exist beyond it — but page ${envelope.next_page ?? envelope.page + 1} ` +
          `resumes after all ${onPage} records on this page, not after the ${emitted} shown here, ` +
          `so paging on alone will never show the ${dropped} dropped record(s). `
        : `No further page follows this one, so the ${dropped} dropped record(s) are not ` +
          'reachable by paging at all. ') +
      (envelope.page_size_supported
        ? 'Re-request with a smaller page_size, narrower filters, or a shorter `fields` list to '
        : 'This endpoint documents no page_size, so there is none to lower: re-request with ' +
          'narrower filters or a shorter `fields` list to ') +
      'see them. The Hudu API returns no total count, so what lies beyond this page is not ' +
      'knowable without paging through.'
    : `${core} This Hudu endpoint does not support pagination at all — there is no page or ` +
      'page_size parameter and no further page to request — so narrowing the filters is the ' +
      `only way to see the ${dropped} dropped record(s), and where the endpoint offers no ` +
      'narrow enough filter they cannot be reached at all. Do not describe this response as a ' +
      'full inventory.';

  return envelope.completeness_caveat === undefined
    ? body
    : `${body} ${envelope.completeness_caveat}`;
}

const truncationNote = <T>(
  envelope: ListEnvelope<T>,
  onPage: number,
  emitted: number,
  limit: number,
): string =>
  `Response truncated from ${onPage} to ${emitted} record(s) to stay within the ${limit}-` +
  'character response budget. This is a client-side cut, not the end of the data: ' +
  (envelope.pagination_supported
    ? envelope.page_size_supported
      ? 'lower page_size, add filters, or request specific ids to see the rest.'
      : 'this endpoint documents no page_size, so add filters or request specific ids to see ' +
        'the rest.'
    : 'this endpoint has no pagination, so narrowing the filters is the only way to reach the ' +
      `${onPage - emitted} record(s) that were dropped.`);

/**
 * Assemble a truncated envelope.
 *
 * Key order here is part of the contract, not an accident. `truncated`,
 * `records_on_page` and `truncation_note` are placed *before* `items` because
 * clients clip long tool results, and a correction that sits twenty kilobytes
 * below the claim it contradicts is not a correction. A clipped read must be
 * able to see that the response is partial before it sees the records that make
 * it look whole.
 */
function truncatedEnvelope<T>(
  envelope: ListEnvelope<T>,
  items: readonly T[],
  onPage: number,
  limit: number,
): ListEnvelope<T> {
  const emitted = items.length;
  // `items` is pulled out and re-added last so that everything below stays
  // ahead of it; `count` and `pagination_note` keep their original positions
  // because assigning an existing key does not move it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { items: _items, ...meta } = envelope;

  return {
    ...meta,
    count: emitted,
    pagination_note: truncatedPaginationNote(envelope, onPage, emitted),
    truncated: true,
    records_on_page: onPage,
    truncation_note: truncationNote(envelope, onPage, emitted, limit),
    items,
  };
}

/**
 * Drop items until the serialised payload fits the character budget.
 *
 * Halving rather than trimming one at a time: a single oversized record would
 * otherwise cost one serialisation pass per item removed.
 *
 * The loop measures the envelope it is actually going to return, notes and all,
 * rather than the one it started from. Measuring the input and then adding a
 * few hundred characters of explanation to the output is how a budget gets
 * quietly overshot by exactly the text that was supposed to make the cut safe.
 */
export function applyCharacterBudget<T>(
  envelope: ListEnvelope<T>,
  limit = CHARACTER_LIMIT,
): ListEnvelope<T> {
  let items = envelope.items;

  if (JSON.stringify({ ...envelope, items }).length <= limit) return envelope;

  const onPage = items.length;
  let truncated = truncatedEnvelope(envelope, items, onPage, limit);
  while (items.length > 1 && JSON.stringify(truncated).length > limit) {
    items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    truncated = truncatedEnvelope(envelope, items, onPage, limit);
  }

  return truncated;
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
    envelope.records_on_page === undefined
      ? `Page ${envelope.page} · ${envelope.count} record(s) · page size ${envelope.page_size}`
      : `Page ${envelope.page} · ${envelope.count} of ${envelope.records_on_page} record(s) ` +
          `shown · page size ${envelope.page_size}`,
  );
  // Above the records, not below them. A reader who stops early — or a client
  // that clips the response — must meet the correction before the list that
  // looks complete without it.
  if (envelope.truncation_note) lines.push('', `**Truncated.** ${envelope.truncation_note}`);
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
