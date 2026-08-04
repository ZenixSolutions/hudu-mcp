/**
 * Overview workflows: one company at a glance, and the instance-wide ranking of
 * which companies are thinly documented.
 *
 * Both exist because of a measured failure of one-endpoint-one-tool. An external
 * reviewer driving 0.1.0 against a live instance asked "find a company whose
 * documentation looks thin" and had no tool for it: they paged all 1,619 assets
 * and 40 articles with `fields: ["id","company_id"]` and tallied the ids
 * themselves. Seventeen calls to learn what Hudu's own dashboard shows. Their
 * conclusion was that a per-company summary of assets, articles, passwords and
 * networks makes it one call, and that is what these two tools are.
 *
 * The counting is the easy part. Staying honest while counting is not, and three
 * separate things can make a number here a lie:
 *
 * 1. **A count is a lower bound unless the walk reached the end.** Hudu
 *    publishes no total, no `X-Total-Count` and no `Link` header (spec-defects
 *    C1), so a walk stops either at a short page or at its own page cap, and
 *    only the first case yields an exact figure. Every count below therefore
 *    carries `exact` as a boolean *and* renders itself as "12 asset(s)" or "at
 *    least 12 asset(s)" in prose, because a model that quotes a number without
 *    reading the footnote is the normal case rather than the unlucky one. "This
 *    client has 3 assets, documentation is thin" reads identically whether it is
 *    true or whether a walk gave up.
 *
 * 2. **A collection that could not be read is not an empty collection.** A key
 *    created without password access answers `401` on `/asset_passwords`
 *    (spec-defects A7/F5) — a fact about the key, not an error in the request.
 *    An unreadable collection reports `available: false` and carries **no
 *    `count` key at all**, because a `0` there would be indistinguishable from a
 *    company with no stored credentials, and that is the worst single defect
 *    either of these tools could ship.
 *
 * 3. **`GET /companies` cannot see archived companies.** It returned 22 where
 *    the instance held 27, and 64 assets pointed at company ids no page of that
 *    endpoint will ever mention. So the gap ranking cannot rank an archived
 *    company, and an asset's `company_id` may resolve to nothing — which
 *    {@link nameFor} renders as "id N (not in the visible list)" rather than
 *    quietly dropping.
 */

import { z } from 'zod';

import type { HuduClient } from '../api/client.js';
import { unwrapRecord } from '../api/envelope.js';
import { HuduApiError } from '../api/errors.js';
import { buildPath } from '../api/paths.js';
import { projectFields, ResponseFormat } from '../presentation/format.js';
import { OperationClass } from '../security/classification.js';
import {
  defineTool,
  responseFormatArg,
  type ToolDefinition,
  type ToolResult,
} from '../tools/define.js';
import {
  describeCount,
  fetchAll,
  gather,
  indexByIdI,
  nameFor,
  type Walk,
  walkAll,
} from './compose.js';

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The one sentence both tools must never let a caller skip.
 *
 * Repeated in the payload rather than referenced from the description: a model
 * summarising a result reads the result, not the tool list it came from.
 */
const LOWER_BOUND_RULE =
  'Hudu publishes no total for any collection, so every count here comes from walking pages ' +
  'until one came back short. A count with `exact: true` is the real figure; a count with ' +
  '`exact: false` is a LOWER BOUND — the walk hit its page cap and more records exist. Never ' +
  'quote an inexact count as a total, and never describe a company as thinly documented on one.';

/**
 * Stated on every result, because it bounds what the answer can be about.
 *
 * Same defect the list tools disclose as `completeness_caveat`, restated here
 * because these tools aggregate rather than list and would otherwise present a
 * complete-looking picture of a partially visible instance.
 */
const ARCHIVED_INVISIBLE =
  'Archived companies are missing from GET /companies and Hudu publishes no parameter to ' +
  'include them — sending `archived` has no effect there. So a company id seen on an asset, ' +
  'article, password or network may not appear in any company list, and the instance may hold ' +
  'more companies than are counted here. hudu_get_company does return an archived company, so ' +
  'resolve an unfamiliar id with it rather than concluding the company does not exist.';

/** Company fields worth carrying. Deliberately excludes the HTML `notes` blob. */
const COMPANY_FIELDS = [
  'id',
  'name',
  'nickname',
  'company_type',
  'city',
  'state',
  'country_name',
  'phone_number',
  'website',
  'id_number',
  'parent_company_id',
  'parent_company_name',
  'archived',
  'url',
  'created_at',
  'updated_at',
] as const;

/**
 * Pages of candidates a `search` resolution will read before giving up.
 *
 * Two, not ten. A search that matches more than two hundred companies is not a
 * resolution attempt, and reading eight more pages of it would spend requests to
 * make an ambiguity report longer.
 */
const SEARCH_MAX_PAGES = 2;

/** Candidates listed back on an ambiguous search before the list is cut. */
const CANDIDATE_LIMIT = 25;

/**
 * Pages the instance-wide walks in {@link gapsTool} may read.
 *
 * Higher than the shared default of ten, and chosen from the case that motivated
 * the tool: the reviewer's instance held 1,619 assets, which is seventeen pages.
 * A cap of ten would have made every count on that instance a lower bound and
 * the ranking useless on exactly the estate it was built for. Twenty-five pages
 * is 2,500 records per collection and at most fifty-odd requests for the whole
 * tool — well inside the documented 300-per-minute budget, and still a hard
 * ceiling rather than an unbounded crawl.
 */
const GAPS_MAX_PAGES = 25;

/** Unresolvable company ids reported individually before the list is cut. */
const UNRESOLVED_LIMIT = 25;

/* -------------------------------------------------------------------------- */
/* Counts that carry their own provenance                                      */
/* -------------------------------------------------------------------------- */

/**
 * One collection's contribution to an overview.
 *
 * `count` and `exact` are optional *together* and are absent exactly when
 * `available` is false. That is the shape doing the work: a caller cannot read a
 * missing key as zero the way it can read `count: 0`, and every renderer below
 * has to branch on `available` before it can print a number.
 */
export interface CountReport {
  readonly collection: string;
  /** False when the collection could not be read. There is then no count at all. */
  readonly available: boolean;
  /** Records found. Absent — never zero — when `available` is false. */
  readonly count?: number;
  /** True when the walk reached the end. False means `count` is a lower bound. */
  readonly exact?: boolean;
  /** The count in words, carrying the lower-bound distinction into prose. */
  readonly description: string;
  /** Where the number came from and what bounds it. */
  readonly provenance: string;
  /** Why the collection could not be read. Present only when `available` is false. */
  readonly reason?: string;
}

const countedReport = (
  collection: string,
  noun: string,
  walk: Walk<unknown>,
  provenance?: string,
): CountReport => ({
  collection,
  available: true,
  count: walk.count,
  exact: walk.complete,
  description: describeCount(walk, noun),
  provenance: provenance === undefined ? walk.note : `${provenance} ${walk.note}`,
});

/**
 * A count derived by filtering an unfiltered walk client-side.
 *
 * `GET /websites` documents no `company_id` parameter (the contract lists only
 * `page`, `name`, `page_size`, `slug`, `search` and `updated_at`), so the only
 * way to count one company's monitored sites is to walk the instance list and
 * match on the `company_id` each record carries. That makes an incomplete walk
 * far more dangerous here than elsewhere: a company's sites may sit entirely in
 * the pages that were never fetched, so **zero matches on an incomplete walk is
 * not evidence of zero sites** — which is why `exact` tracks the walk rather
 * than the match count.
 */
const filteredReport = (
  collection: string,
  noun: string,
  matched: number,
  walk: Walk<unknown>,
  endpointNote: string,
): CountReport => ({
  collection,
  available: true,
  count: matched,
  exact: walk.complete,
  description: walk.complete ? `${matched} ${noun}` : `at least ${matched} ${noun}`,
  provenance:
    `${endpointNote} ${matched} of the ${walk.count} record(s) read carry this company_id. ` +
    walk.note +
    (walk.complete
      ? ''
      : ' Because the walk stopped early, records for this company may sit in pages that were ' +
        'never fetched: a zero here would not mean the company has none.'),
});

const unreadableReport = (collection: string, reason: string): CountReport => ({
  collection,
  available: false,
  description: `${collection}: could not be read, so the number is unknown — it is not zero`,
  provenance:
    'This collection is reported as unavailable rather than as empty. A failed read and an ' +
    'empty collection are different answers, and only one of them is a documentation gap.',
  reason,
});

/** Pages a walk actually cost, tolerating a walk that never happened. */
const pagesOf = (walk: { readonly pages: number } | undefined): number => walk?.pages ?? 0;

/**
 * Restate a sub-query failure as the fact it usually is.
 *
 * {@link gather} reports a failed part by its error message, and the raw message
 * for the commonest failure here — `401` on `/asset_passwords` — says
 * "unauthorised", which reads as a broken request. It is not: Hudu scopes
 * password access at key creation and answers `401`, not `403`, for a key
 * without it (spec-defects A7/F5). Rewriting the message before it reaches
 * `gather` is what lets the tool say "could not be read: password scope" instead
 * of implying the caller did something wrong.
 */
function explainFailure(part: string, error: unknown): unknown {
  if (!(error instanceof HuduApiError)) return error;

  if (part === 'passwords' && (error.status === 401 || error.status === 403)) {
    return new HuduApiError(
      'password scope: this API key cannot read /asset_passwords. Hudu answers 401 there for a ' +
        'key created without password access, which is a fact about the key rather than about ' +
        'this company. The number of stored credentials is unknown and it is not zero.',
      { kind: 'permission', status: error.status, guidance: error.guidance },
    );
  }

  return error;
}

/** Run a sub-query, rewriting its failure into something a reader can act on. */
async function explained<T>(part: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw explainFailure(part, error);
  }
}

/** Index the reasons {@link gather} collected, by part name. */
const reasonsByPart = (
  unavailable: readonly { readonly part: string; readonly reason: string }[],
): ReadonlyMap<string, string> => new Map(unavailable.map((entry) => [entry.part, entry.reason]));

/**
 * Build a report from a walk that may not have happened.
 *
 * The two arguments are mutually exclusive in practice — `gather` either gives
 * a value or a reason — and this is the single place that decides which shape a
 * collection gets, so no call site can accidentally emit a zero for a failure.
 */
const reportFor = (
  collection: string,
  noun: string,
  walk: Walk<unknown> | undefined,
  reason: string | undefined,
): CountReport =>
  walk === undefined
    ? unreadableReport(collection, reason ?? 'The sub-query returned nothing and no reason.')
    : countedReport(collection, noun, walk);

/* -------------------------------------------------------------------------- */
/* Argument handling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A caller error, raised in the shape `executeTool` already knows how to render.
 *
 * `HuduApiError` with no status and no URL: nothing reached Hudu, and the
 * message is the whole point — `toAgentError` turns it into "Error: … What to
 * do: …", which is what every other failure in this server looks like.
 */
const argumentError = (message: string, guidance: string): HuduApiError =>
  new HuduApiError(message, { kind: 'validation', guidance });

/* -------------------------------------------------------------------------- */
/* hudu_company_overview                                                       */
/* -------------------------------------------------------------------------- */

interface Resolution {
  readonly id: number;
  /** Present when a `search` already returned the record, so it is not refetched. */
  readonly record: Record<string, unknown> | undefined;
  readonly requests: number;
}

/** `GET /companies/{id}` — the one company read that also returns archived records. */
async function fetchCompanyRecord(
  client: HuduClient,
  id: number,
): Promise<Record<string, unknown> | undefined> {
  const response = await client.get<unknown>(buildPath('/companies/{id}', { id }));
  return unwrapRecord(response.data, 'company');
}

/** Report an ambiguous search rather than picking a candidate. */
function ambiguousResult(search: string, matches: Walk<Record<string, unknown>>): ToolResult {
  const candidates = matches.items.slice(0, CANDIDATE_LIMIT).map((company) => ({
    company_id: company['id'],
    name: company['name'],
    nickname: company['nickname'],
    city: company['city'],
    company_type: company['company_type'],
  }));

  return {
    data: {
      resolved: false,
      reason: 'ambiguous_search',
      search,
      matches: describeCount(matches, 'match(es)'),
      match_count: matches.count,
      match_count_exact: matches.complete,
      candidates_shown: candidates.length,
      candidates,
      what_to_do:
        'Ask the user which company they mean, or call again with `company_id` set to one of ' +
        'the ids above. No collection was counted for any of them: picking the first match and ' +
        'reporting its documentation as the answer is the failure this branch exists to prevent.',
      archived_companies: ARCHIVED_INVISIBLE,
    },
    notice:
      `${matches.count} companies match "${search}"` +
      (matches.complete ? '' : ' (at least — the candidate search stopped at its page cap)') +
      '. Nothing was counted; choose one and call again with company_id.',
  };
}

/** Report a search that matched nothing, without implying the company is absent. */
function noMatchResult(search: string): ToolResult {
  return {
    data: {
      resolved: false,
      reason: 'no_match',
      search,
      match_count: 0,
      what_to_do:
        'Try a shorter fragment — `search` matches as a substring, so "cont" finds "Contoso" ' +
        'where a full name with a typo finds nothing. If the company may be archived it will ' +
        'never appear here whatever you search for: archived companies are reachable only by id ' +
        'through hudu_get_company.',
      archived_companies: ARCHIVED_INVISIBLE,
    },
    notice: `No company matched "${search}", so no counts were gathered.`,
  };
}

/** Resolve the arguments to a single company id, or return the reason it could not be. */
async function resolveCompany(
  client: HuduClient,
  args: Record<string, unknown>,
): Promise<Resolution | ToolResult> {
  const companyId = args['company_id'] as number | undefined;
  const search = args['search'] as string | undefined;

  if (companyId === undefined && search === undefined) {
    throw argumentError(
      'hudu_company_overview needs a company to look at: pass either company_id or search.',
      'Pass `company_id` when you already hold the numeric id. Pass `search` with a name ' +
        'fragment when you do not — it is resolved first, and an ambiguous match comes back as a ' +
        'candidate list rather than a guess.',
    );
  }

  if (companyId !== undefined && search !== undefined) {
    throw argumentError(
      'hudu_company_overview takes company_id or search, not both.',
      'Drop one. Accepting both would mean silently ignoring whichever lost, and a filter that ' +
        'is discarded without saying so is worse than one that fails.',
    );
  }

  if (companyId !== undefined) return { id: companyId, record: undefined, requests: 0 };

  const matches = await walkAll<Record<string, unknown>>(
    client,
    '/companies',
    { search },
    'companies',
    { maxPages: SEARCH_MAX_PAGES },
  );

  if (matches.count === 0) return noMatchResult(search ?? '');
  if (matches.count > 1) return ambiguousResult(search ?? '', matches);

  const record = matches.items[0];
  const id = record?.['id'];
  if (record === undefined || typeof id !== 'number') {
    throw argumentError(
      `The company matching "${search ?? ''}" came back without a usable numeric id.`,
      'Call hudu_list_companies with the same search to see what the record looks like, then ' +
        'call this tool again with company_id.',
    );
  }

  return { id, record, requests: matches.pages };
}

/**
 * The "what looks missing" reading, which is the signal the reviewer wanted.
 *
 * Every rule is gated on the count being *exact*. An observation drawn from a
 * lower bound would be the original defect wearing a different hat: "no articles"
 * derived from a walk that stopped early is a statement about this client's
 * pagination, not about its documentation.
 */
function observationsFor(
  reports: readonly CountReport[],
  company: Record<string, unknown> | undefined,
  companyMissing: boolean,
): string[] {
  const by = new Map(reports.map((report) => [report.collection, report]));
  const known = (name: string): number | undefined => {
    const report = by.get(name);
    return report?.available === true && report.exact === true ? report.count : undefined;
  };

  const notes: string[] = [];

  if (companyMissing) {
    notes.push(
      'Hudu returned no company record for this id. Some endpoints answer 200 with an empty ' +
        'body for an id that does not exist, so this may not be a company at all — read the ' +
        'counts below as "what each collection returns when filtered by an id nothing matches", ' +
        'not as a documentation gap.',
    );
  }

  if (company?.['archived'] === true) {
    notes.push(
      'This company is archived. It will never appear in hudu_list_companies or in the ' +
        'hudu_documentation_gaps ranking, and its documentation is reachable only by id.',
    );
  }

  const assets = known('assets');
  const articles = known('articles');

  if (assets !== undefined && assets > 0 && articles === 0) {
    notes.push(
      `${assets} asset(s) are documented and there is not a single knowledge-base article. ` +
        'That is the clearest thin-documentation signal in Hudu: the hardware is recorded and ' +
        'nothing explains how it is run.',
    );
  }

  if (known('networks') === 0) {
    notes.push('No network is documented for this company, so its IP plan is not in Hudu at all.');
  }

  if (known('passwords') === 0) {
    notes.push(
      'No credentials are stored against this company. Confirm that is deliberate rather than ' +
        'undocumented access.',
    );
  }

  const unreadable = reports
    .filter((report) => !report.available)
    .map((report) => report.collection);
  if (unreadable.length > 0) {
    notes.push(
      `Not every collection could be read (${unreadable.join(', ')}), so this is a partial ` +
        'picture. An unreadable collection is not an empty one and must not be reported as a gap.',
    );
  }

  if (notes.length === 0 && !companyMissing) {
    notes.push(
      'Nothing obviously missing: every collection this tool can see either holds records or ' +
        'is not the kind of absence worth flagging.',
    );
  }

  return notes;
}

interface OverviewPayload {
  readonly resolved: true;
  readonly company_id: number;
  readonly counts_are_lower_bounds: boolean;
  readonly what_the_counts_mean: string;
  readonly unreadable_collections: readonly {
    readonly collection: string;
    readonly reason: string;
  }[];
  readonly company: Record<string, unknown> | null;
  readonly company_record_note?: string;
  readonly counts: readonly CountReport[];
  readonly summary: string;
  readonly observations: readonly string[];
  readonly requests_made: number;
  readonly archived_companies: string;
}

const isOverviewPayload = (value: unknown): value is OverviewPayload =>
  typeof value === 'object' && value !== null && 'counts' in value;

/** Render an overview for a human reader, from the already-stripped payload. */
function renderOverview(data: unknown): string {
  if (!isOverviewPayload(data)) return JSON.stringify(data, null, 2);

  const name =
    typeof data.company?.['name'] === 'string' ? data.company['name'] : 'Unknown company';
  const lines = [`# ${name} (company ${data.company_id})`, '', data.summary, ''];

  if (data.counts_are_lower_bounds) {
    lines.push(`**Some counts are lower bounds.** ${LOWER_BOUND_RULE}`, '');
  }

  lines.push('## Counts', '');
  for (const report of data.counts) {
    lines.push(
      report.available
        ? `- **${report.collection}**: ${report.description}`
        : `- **${report.collection}**: could not be read — ${report.reason ?? 'no reason given'}`,
    );
  }

  lines.push('', '## What looks missing', '');
  for (const note of data.observations) lines.push(`- ${note}`);

  lines.push('', `_${data.requests_made} request(s) to Hudu._`, '', data.archived_companies);
  return lines.join('\n');
}

const companyOverviewTool = defineTool({
  name: 'hudu_company_overview',
  title: 'Company Documentation Overview',
  description:
    'Everything Hudu holds for one company, counted in a single call: assets, articles, ' +
    'passwords (metadata only, never a secret), monitored websites, networks, racks and ' +
    'expirations, plus the company record and a short reading of what looks undocumented.\n\n' +
    'Takes `company_id`, or a `search` fragment which is resolved first — a search that matches ' +
    'several companies comes back as a candidate list rather than a guess.\n\n' +
    'Read the counts as they describe themselves. Hudu publishes no totals, so each one is ' +
    'either exact or a floor: `exact: false` means "at least this many" because the walk hit ' +
    'its page cap. A collection that could not be read — a key without password scope gets 401 ' +
    'on /asset_passwords — reports `available: false` and carries no count at all. Do not read ' +
    'that as zero credentials, and do not call a company thinly documented on an inexact count.\n\n' +
    'Use the atomic hudu_list_* tools instead when you need the records themselves, a filter ' +
    'this tool does not offer, or a single collection.',
  inputSchema: {
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Numeric Hudu company id. Give this or `search`, not both.'),
    search: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Name fragment to resolve to a company first. Matches as a substring; several matches ' +
          'return the candidates instead of an overview.',
      ),
    ...responseFormatArg,
  },
  operationClass: OperationClass.Read,
  handler: async (args, { client }): Promise<ToolResult> => {
    const resolution = await resolveCompany(client, args);
    if (!('id' in resolution)) return resolution;

    const { id } = resolution;
    const preloaded = resolution.record;

    const { results, unavailable } = await gather({
      company: async (): Promise<Record<string, unknown> | undefined> =>
        preloaded ?? (await fetchCompanyRecord(client, id)),
      assets: async () =>
        explained('assets', () =>
          walkAll<Record<string, unknown>>(client, '/assets', { company_id: id }, 'assets'),
        ),
      articles: async () =>
        explained('articles', () =>
          walkAll<Record<string, unknown>>(client, '/articles', { company_id: id }, 'articles'),
        ),
      passwords: async () =>
        explained('passwords', () =>
          walkAll<Record<string, unknown>>(
            client,
            '/asset_passwords',
            { company_id: id },
            'asset_passwords',
          ),
        ),
      websites: async () => {
        // No company filter is documented on /websites, so the instance list is
        // walked and matched client-side. See `filteredReport`.
        const walk = await explained('websites', () =>
          walkAll<Record<string, unknown>>(client, '/websites', {}, undefined),
        );
        return {
          walk,
          matched: walk.items.filter((site) => site['company_id'] === id).length,
        };
      },
      networks: async () =>
        explained('networks', () =>
          fetchAll<Record<string, unknown>>(client, '/networks', { company_id: id }, undefined),
        ),
      racks: async () =>
        explained('racks', () =>
          fetchAll<Record<string, unknown>>(
            client,
            '/rack_storages',
            { company_id: id },
            undefined,
          ),
        ),
      expirations: async () =>
        explained('expirations', () =>
          walkAll<Record<string, unknown>>(client, '/expirations', { company_id: id }, undefined),
        ),
    });

    const reasons = reasonsByPart(unavailable);
    const websites = results.websites;

    const counts: CountReport[] = [
      reportFor('assets', 'asset(s)', results.assets, reasons.get('assets')),
      reportFor('articles', 'article(s)', results.articles, reasons.get('articles')),
      reportFor('passwords', 'password record(s)', results.passwords, reasons.get('passwords')),
      websites === undefined
        ? unreadableReport(
            'websites',
            reasons.get('websites') ?? 'The sub-query returned nothing and no reason.',
          )
        : filteredReport(
            'websites',
            'monitored website(s)',
            websites.matched,
            websites.walk,
            'GET /websites documents no company_id filter, so the instance-wide list was walked ' +
              'and matched on the company_id each record carries.',
          ),
      reportFor('networks', 'network(s)', results.networks, reasons.get('networks')),
      reportFor('racks', 'rack(s)', results.racks, reasons.get('racks')),
      reportFor('expirations', 'expiration(s)', results.expirations, reasons.get('expirations')),
    ];

    const companyRecord = results.company;
    const companyUnreadable = reasons.get('company');
    const companyMissing = companyRecord === undefined && companyUnreadable === undefined;

    const lowerBounds = counts.filter((report) => report.exact === false);
    const unreadable = counts.filter((report) => !report.available);

    // A floor rather than a tally, and the same reason as everything else here:
    // a sub-query that failed reports no pages, so each unreadable collection is
    // counted as the one request it must have made at minimum.
    const requests =
      resolution.requests +
      (preloaded === undefined ? 1 : 0) +
      unreadable.length +
      pagesOf(results.assets) +
      pagesOf(results.articles) +
      pagesOf(results.passwords) +
      pagesOf(websites?.walk) +
      pagesOf(results.networks) +
      pagesOf(results.racks) +
      pagesOf(results.expirations);

    const readable = counts.filter((report) => report.available);
    const summary =
      `${typeof companyRecord?.['name'] === 'string' ? companyRecord['name'] : `Company ${id}`}: ` +
      readable.map((report) => report.description).join(', ') +
      (unreadable.length === 0
        ? '.'
        : `. Could not be read: ${unreadable.map((report) => report.collection).join(', ')}.`);

    const payload: OverviewPayload = {
      resolved: true,
      company_id: id,
      counts_are_lower_bounds: lowerBounds.length > 0,
      what_the_counts_mean: LOWER_BOUND_RULE,
      unreadable_collections: unreadable.map((report) => ({
        collection: report.collection,
        reason: report.reason ?? 'unknown',
      })),
      company:
        companyRecord === undefined
          ? null
          : (projectFields([companyRecord], [...COMPANY_FIELDS])[0] ?? companyRecord),
      ...(companyUnreadable === undefined
        ? companyMissing
          ? {
              company_record_note:
                `GET /companies/${id} returned no record. Hudu answers 200 with an empty body ` +
                'for a company id that does not exist, so this is an answer rather than a ' +
                'failure — the id is probably wrong.',
            }
          : {}
        : {
            company_record_note:
              `The company record itself could not be read: ${companyUnreadable} The counts ` +
              'below were still gathered.',
          }),
      counts,
      summary,
      observations: observationsFor(counts, companyRecord, companyMissing),
      requests_made: requests,
      archived_companies: ARCHIVED_INVISIBLE,
    };

    const noticeParts: string[] = [];
    if (lowerBounds.length > 0) {
      noticeParts.push(
        `${lowerBounds.length} of these counts (${lowerBounds
          .map((report) => report.collection)
          .join(', ')}) are LOWER BOUNDS, not totals — the walk hit its page cap. Say "at least" ` +
          'when you report them.',
      );
    }
    if (unreadable.length > 0) {
      noticeParts.push(
        `${unreadable.length} collection(s) could not be read (${unreadable
          .map((report) => report.collection)
          .join(', ')}). That is unknown, not zero.`,
      );
    }

    return {
      data: payload,
      ...(noticeParts.length > 0 ? { notice: noticeParts.join(' ') } : {}),
      markdown:
        args['response_format'] === ResponseFormat.Markdown
          ? (data): string => renderOverview(data)
          : undefined,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* hudu_documentation_gaps                                                     */
/* -------------------------------------------------------------------------- */

/** Count records per `company_id`, keeping the ones that carry none separately. */
function tallyByCompany(items: readonly Record<string, unknown>[]): {
  readonly byCompany: ReadonlyMap<number, number>;
  readonly withoutCompany: number;
} {
  const byCompany = new Map<number, number>();
  let withoutCompany = 0;

  for (const item of items) {
    const id = item['company_id'];
    if (typeof id !== 'number') {
      withoutCompany += 1;
      continue;
    }
    byCompany.set(id, (byCompany.get(id) ?? 0) + 1);
  }

  return { byCompany, withoutCompany };
}

const countPhrase = (count: number, exact: boolean, noun: string): string =>
  exact ? `${count} ${noun}` : `at least ${count} ${noun}`;

interface GapRow {
  readonly company_id: number;
  readonly name: string;
  readonly assets: number;
  readonly articles: number;
  readonly total: number;
  readonly counts_are_lower_bounds: boolean;
  readonly description: string;
}

interface GapsPayload {
  readonly ranking_reliable: boolean;
  readonly counts_are_lower_bounds: boolean;
  readonly what_the_counts_mean: string;
  readonly archived_companies: string;
  readonly unreadable_collections: readonly {
    readonly collection: string;
    readonly reason: string;
  }[];
  readonly scope: readonly CountReport[];
  readonly companies_ranked: readonly GapRow[];
  readonly companies_shown: number;
  readonly companies_considered: number;
  readonly articles_without_a_company: number;
  readonly unresolved_company_ids: readonly {
    readonly company_id: number;
    readonly resolves_to: string;
    readonly assets: number;
    readonly articles: number;
  }[];
  readonly unresolved_company_ids_omitted: number;
  readonly requests_made: number;
}

const isGapsPayload = (value: unknown): value is GapsPayload =>
  typeof value === 'object' && value !== null && 'companies_ranked' in value;

function renderGaps(data: unknown): string {
  if (!isGapsPayload(data)) return JSON.stringify(data, null, 2);

  const lines = ['# Documentation gaps', ''];
  if (!data.ranking_reliable) {
    lines.push(`**This ranking is not reliable.** ${LOWER_BOUND_RULE}`, '');
  }
  lines.push(
    `${data.companies_shown} of ${data.companies_considered} visible companies, thinnest first.`,
    '',
  );
  for (const row of data.companies_ranked) {
    lines.push(`- **${row.name}** (id ${row.company_id}): ${row.description}`);
  }

  if (data.unresolved_company_ids.length > 0) {
    lines.push('', '## Documentation belonging to companies this list cannot name', '');
    for (const entry of data.unresolved_company_ids) {
      lines.push(`- ${entry.resolves_to}: ${entry.assets} asset(s), ${entry.articles} article(s)`);
    }
  }

  lines.push('', `_${data.requests_made} request(s) to Hudu._`, '', data.archived_companies);
  return lines.join('\n');
}

const gapsTool = defineTool({
  name: 'hudu_documentation_gaps',
  title: 'Rank Companies by Documentation Gaps',
  description:
    'Ranks the companies on this instance by how little documentation they hold — fewest assets ' +
    'plus articles first — and returns the per-company counts behind the ranking.\n\n' +
    'Hudu has no aggregate endpoint, so this walks /assets and /articles once each and tallies ' +
    'company_id client-side. Expect tens of requests on a large instance: it pays in one call ' +
    'what a manual tally pays page by page.\n\n' +
    'Two limits decide whether the ranking can be believed, and both are reported. If either ' +
    'walk hits its page cap, every count is a lower bound and `ranking_reliable` is false — a ' +
    'company can then look thin purely because its records were never read. And archived ' +
    'companies are invisible to GET /companies, so they are never ranked; their documentation ' +
    'shows up only as `unresolved_company_ids`.\n\n' +
    'Use hudu_company_overview for one named company. Use this only for "which of our clients ' +
    'are under-documented?".',
  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('How many of the thinnest companies to return. Default 10.'),
    ...responseFormatArg,
  },
  operationClass: OperationClass.Read,
  handler: async (args, { client }): Promise<ToolResult> => {
    const limit = (args['limit'] as number | undefined) ?? 10;

    // Outside `gather`, and deliberately: assets and articles are each optional
    // to the answer, but without the company list there is no ranking to make
    // partial. A failure here is a failure of the tool.
    const companies = await walkAll<Record<string, unknown>>(client, '/companies', {}, 'companies');

    const { results, unavailable } = await gather({
      assets: () =>
        walkAll<Record<string, unknown>>(client, '/assets', {}, 'assets', {
          maxPages: GAPS_MAX_PAGES,
        }),
      articles: () =>
        walkAll<Record<string, unknown>>(client, '/articles', {}, 'articles', {
          maxPages: GAPS_MAX_PAGES,
        }),
    });

    const reasons = reasonsByPart(unavailable);
    const assetWalk = results.assets;
    const articleWalk = results.articles;

    const assetTally = tallyByCompany(assetWalk?.items ?? []);
    const articleTally = tallyByCompany(articleWalk?.items ?? []);

    const assetsExact = assetWalk?.complete === true;
    const articlesExact = articleWalk?.complete === true;
    const rowsExact = assetsExact && articlesExact && companies.complete;

    const index = indexByIdI(companies.items);

    const rows: GapRow[] = [];
    for (const company of companies.items) {
      const id = company['id'];
      if (typeof id !== 'number') continue;
      const assets = assetTally.byCompany.get(id) ?? 0;
      const articles = articleTally.byCompany.get(id) ?? 0;
      rows.push({
        company_id: id,
        name: nameFor(index, id),
        assets,
        articles,
        total: assets + articles,
        counts_are_lower_bounds: !rowsExact,
        description:
          `${countPhrase(assets, assetsExact, 'asset(s)')}, ` +
          countPhrase(articles, articlesExact, 'article(s)'),
      });
    }

    rows.sort((left, right) => left.total - right.total || left.name.localeCompare(right.name));

    // Ids that carry documentation but match no visible company. Almost always
    // archived companies (spec-defects: 22 visible of 27, 64 assets orphaned),
    // and the only trace of them this tool can show at all.
    const orphanIds = new Set<number>();
    for (const id of assetTally.byCompany.keys()) if (!index.has(id)) orphanIds.add(id);
    for (const id of articleTally.byCompany.keys()) if (!index.has(id)) orphanIds.add(id);

    const orphans = [...orphanIds]
      .sort((left, right) => left - right)
      .map((id) => ({
        company_id: id,
        resolves_to: nameFor(index, id),
        assets: assetTally.byCompany.get(id) ?? 0,
        articles: articleTally.byCompany.get(id) ?? 0,
      }));

    const scope: CountReport[] = [
      countedReport(
        'companies (visible)',
        'company record(s)',
        companies,
        'Walked GET /companies, which lists unarchived companies only.',
      ),
      reportFor('assets (instance-wide)', 'asset(s)', assetWalk, reasons.get('assets')),
      reportFor('articles (instance-wide)', 'article(s)', articleWalk, reasons.get('articles')),
    ];

    const unreadable = scope.filter((report) => !report.available);
    const lowerBound = !rowsExact;

    const payload: GapsPayload = {
      ranking_reliable: rowsExact && unreadable.length === 0,
      counts_are_lower_bounds: lowerBound,
      what_the_counts_mean: LOWER_BOUND_RULE,
      archived_companies: ARCHIVED_INVISIBLE,
      unreadable_collections: unreadable.map((report) => ({
        collection: report.collection,
        reason: report.reason ?? 'unknown',
      })),
      scope,
      companies_ranked: rows.slice(0, limit),
      companies_shown: Math.min(limit, rows.length),
      companies_considered: rows.length,
      articles_without_a_company: articleTally.withoutCompany,
      unresolved_company_ids: orphans.slice(0, UNRESOLVED_LIMIT),
      unresolved_company_ids_omitted: Math.max(0, orphans.length - UNRESOLVED_LIMIT),
      // A floor: a walk that failed reports no pages, so an unreadable
      // collection is counted as the single request it must at least have made.
      requests_made:
        companies.pages + unreadable.length + pagesOf(assetWalk) + pagesOf(articleWalk),
    };

    const noticeParts: string[] = [];
    if (lowerBound) {
      noticeParts.push(
        'This ranking is NOT reliable: at least one walk stopped at its page cap, so every ' +
          'count below is a lower bound and a company may look thin only because its records ' +
          'were never read.',
      );
    }
    if (unreadable.length > 0) {
      noticeParts.push(
        `${unreadable.length} collection(s) could not be read (${unreadable
          .map((report) => report.collection)
          .join(', ')}); those records are missing from every row, which is unknown rather than ` +
          'zero.',
      );
    }
    if (orphans.length > 0) {
      noticeParts.push(
        `${orphans.length} company id(s) carry documentation but appear in no company list — ` +
          'almost certainly archived companies, which cannot be ranked here.',
      );
    }

    return {
      data: payload,
      ...(noticeParts.length > 0 ? { notice: noticeParts.join(' ') } : {}),
      markdown:
        args['response_format'] === ResponseFormat.Markdown
          ? (data): string => renderGaps(data)
          : undefined,
    };
  },
});

export function overviewTools(): ToolDefinition[] {
  return [companyOverviewTool, gapsTool];
}
