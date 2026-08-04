/**
 * The composition layer.
 *
 * The tools in `src/tools/` map one endpoint to one tool. That is the right
 * default — it composes, and it lets a model reach anything the API exposes.
 * But an external review of 0.1.0 showed what it costs: counting how much
 * documentation a client has took seventeen paged calls, listing what expires
 * next month took a walk plus a second walk to turn ids into names, and "which
 * credential is the firewall login" had no path at all except guessing search
 * terms. Every one of those is a question an MSP technician asks daily.
 *
 * This layer answers those questions in one call. It is built *on* the tool
 * layer's client, not beside it: same pacing, same retries, same redaction, same
 * secret stripping on the way out.
 *
 * The hard part is not fanning out. It is staying honest while doing it.
 *
 * A count derived from a paginated API that publishes no total is a **lower
 * bound**, not a total. Hudu returns no `total`, no `X-Total-Count` and no
 * `Link` header (`spec-defects.md` C1), so the only way to count records is to
 * walk pages until one comes back short — and the only way to bound that walk is
 * to stop early. Whichever you do, the number you report is either exact or a
 * floor, and the caller has to be told which. An aggregate that silently
 * under-counts is worse than no aggregate: it looks authoritative, and "this
 * client has 3 assets" reads identically whether it is true or whether the walk
 * gave up at page one.
 *
 * So every count this layer produces carries its own provenance. That is the
 * same commitment `page_was_full` makes at the tool layer, one level up.
 */

import { unwrapList } from '../api/envelope.js';
import type { HuduClient } from '../api/client.js';
import { buildPath, type QueryValue } from '../api/paths.js';

/** Records fetched per page while walking. Hudu publishes no maximum (D12). */
export const WALK_PAGE_SIZE = 100;

/**
 * Pages a single walk will fetch before giving up.
 *
 * Ten pages of a hundred is a thousand records — comfortably more than any
 * per-company collection on a real instance, and a hard ceiling on what one
 * composite tool can cost. Hitting it is not an error; it is a fact about the
 * answer, and {@link Walk.complete} carries it.
 */
export const MAX_WALK_PAGES = 10;

/**
 * The result of walking a collection, with its own honesty attached.
 *
 * `complete` is the field that matters. When it is false, `count` is a floor and
 * nothing derived from `items` may be described as exhaustive.
 */
export interface Walk<T> {
  readonly items: readonly T[];
  /** Records retrieved. Exact when `complete`, otherwise a lower bound. */
  readonly count: number;
  /** True when the walk reached a short page, i.e. the end of the collection. */
  readonly complete: boolean;
  /** Pages actually fetched. */
  readonly pages: number;
  /** Plain-language statement of what `count` means for this walk. */
  readonly note: string;
}

/** Format a count so it can never be read as exact when it is not. */
export function describeCount(walk: Walk<unknown>, noun: string): string {
  return walk.complete ? `${walk.count} ${noun}` : `at least ${walk.count} ${noun}`;
}

/**
 * Walk a paginated collection to the end, or to {@link MAX_WALK_PAGES}.
 *
 * Pages are fetched in sequence rather than in parallel, deliberately: page N+1
 * is only worth requesting if page N came back full, and speculatively fetching
 * pages that turn out not to exist spends a documented 300-requests-per-minute
 * budget on nothing. Fan-out belongs across *different* collections, which
 * {@link gather} does.
 */
export async function walkAll<T>(
  client: HuduClient,
  path: string,
  query: Record<string, QueryValue>,
  listKey: string | undefined,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<Walk<T>> {
  const maxPages = options.maxPages ?? MAX_WALK_PAGES;
  const pageSize = options.pageSize ?? WALK_PAGE_SIZE;

  const items: T[] = [];
  let pages = 0;
  let complete = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const response = await client.get<unknown>(buildPath(path), {
      ...query,
      page,
      page_size: pageSize,
    });
    pages = page;

    const batch = unwrapList<T>(response.data, listKey, `GET ${path}`);
    items.push(...batch);

    // A short page is the only end-of-collection signal this API gives.
    if (batch.length < pageSize) {
      complete = true;
      break;
    }
  }

  return {
    items,
    count: items.length,
    complete,
    pages,
    note: complete
      ? `Walked ${pages} page(s) to the end of the collection, so ${items.length} is exact for ` +
        'the filters used.'
      : `Stopped after ${pages} full page(s) — this client caps a single walk at ${maxPages} ` +
        `pages to bound its cost. ${items.length} is a LOWER BOUND, not a total: more records ` +
        'exist. Narrow the filters to get an exact figure, and do not report this number as a ' +
        'complete count.',
  };
}

/**
 * Walk a collection that documents no `page`/`page_size` at all (C2).
 *
 * One request, everything the endpoint returns. Complete by definition — there
 * is no second page to miss — which is why it is a separate function rather than
 * a flag on {@link walkAll}: passing paging parameters to these endpoints is not
 * a harmless no-op, `/networks` answers `400` for an undocumented parameter.
 */
export async function fetchAll<T>(
  client: HuduClient,
  path: string,
  query: Record<string, QueryValue>,
  listKey: string | undefined,
): Promise<Walk<T>> {
  const response = await client.get<unknown>(buildPath(path), query);
  const items = unwrapList<T>(response.data, listKey, `GET ${path}`);

  return {
    items,
    count: items.length,
    complete: true,
    pages: 1,
    note:
      `This Hudu endpoint has no pagination, so a single request returns everything matching: ` +
      `${items.length} is exact for the filters used.`,
  };
}

/**
 * Run several independent lookups concurrently, tolerating individual failures.
 *
 * A composite tool that dies because one of six sub-queries returned 401 is
 * worse than one that returns five answers and names the sixth as unavailable —
 * particularly here, where a scope failure on `/asset_passwords` is a
 * *configuration* fact about the key rather than an error in the request
 * (`spec-defects.md` A7/F5). The caller gets partial data plus an explicit list
 * of what could not be read.
 *
 * The client's own semaphore bounds real concurrency, so this cannot outrun the
 * rate limit no matter how many entries are passed.
 */
export async function gather<T extends Record<string, () => Promise<unknown>>>(
  tasks: T,
): Promise<{
  readonly results: { [K in keyof T]: Awaited<ReturnType<T[K]>> | undefined };
  readonly unavailable: readonly { readonly part: string; readonly reason: string }[];
}> {
  const entries = Object.entries(tasks) as [keyof T & string, () => Promise<unknown>][];

  const settled = await Promise.all(
    entries.map(async ([name, task]) => {
      try {
        return { name, value: await task(), error: undefined };
      } catch (error) {
        return { name, value: undefined, error };
      }
    }),
  );

  const results = {} as { [K in keyof T]: Awaited<ReturnType<T[K]>> | undefined };
  const unavailable: { part: string; reason: string }[] = [];

  for (const entry of settled) {
    results[entry.name] = entry.value as Awaited<ReturnType<T[keyof T]>>;
    if (entry.error !== undefined) {
      unavailable.push({ part: entry.name, reason: describeFailure(entry.error) });
    }
  }

  return { results, unavailable };
}

/**
 * Describe a thrown value without stringifying an arbitrary object.
 *
 * `String(error)` on a non-Error renders `[object Object]`, which reads to a
 * model as a reason when it is the absence of one. Naming the type instead is
 * at least true.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return `a thrown ${typeof error} carrying no message`;
}

/**
 * Build an id → display-name index from a walked collection.
 *
 * Hudu returns ids on every cross-reference and names on none of them, so a list
 * of expirations is a list of numbers until something resolves them. Doing that
 * per record would be one request each; doing it once per collection is one
 * request per page.
 */
export function indexByIdI(
  items: readonly Record<string, unknown>[],
  nameField = 'name',
): ReadonlyMap<number, string> {
  const index = new Map<number, string>();
  for (const item of items) {
    const id = item['id'];
    const name = item[nameField];
    if (typeof id === 'number' && typeof name === 'string') index.set(id, name);
  }
  return index;
}

/** Resolve an id through an index, saying so plainly when it cannot be resolved. */
export function nameFor(index: ReadonlyMap<number, string>, id: unknown): string {
  if (typeof id !== 'number') return 'unknown';
  return index.get(id) ?? `id ${id} (not in the visible list)`;
}
