/**
 * The composite overview tools, driven end to end.
 *
 * These tools exist to collapse a seventeen-call manual tally into one call, and
 * the whole risk of doing that is that an aggregate looks authoritative. So what
 * is asserted here is not mainly the arithmetic — it is the four ways a count
 * from this API can be a lie, each of which was observed on a real instance:
 *
 * 1. A walk that stopped at its page cap produces a floor, not a total.
 * 2. A `401` on `/asset_passwords` is a fact about the API key, and reporting it
 *    as zero credentials would be the worst defect these tools could carry.
 * 3. A `search` that matches several companies must not silently become one.
 * 4. A `company_id` that resolves to nothing must say so, because
 *    `GET /companies` cannot see archived companies at all.
 *
 * Everything runs through `executeTool`, so secret stripping, notices and
 * rendering are all in the path — the same code the SDK callback drives.
 *
 * The fake fetch here routes on the URL rather than replaying a script in order.
 * `gather` fans out concurrently, so request order is an implementation detail
 * of the semaphore and a positional script would assert it by accident.
 */

import { describe, expect, it } from 'vitest';

import { HuduClient } from '../../src/api/client.js';
import { executeTool, prepareTool, type McpToolResponse } from '../../src/tools/define.js';
import { overviewTools } from '../../src/workflows/overview.js';
import { fakeClock, testConfig, toolText } from '../helpers/fixtures.js';

/* -------------------------------------------------------------------------- */
/* A routing fake                                                              */
/* -------------------------------------------------------------------------- */

interface Reply {
  readonly status?: number;
  readonly json?: unknown;
}

type Route = (query: URLSearchParams) => Reply;

interface Routed {
  readonly fetch: typeof globalThis.fetch;
  /** Every path requested, in call order. */
  readonly paths: string[];
  /** How many times a path was requested. */
  count(path: string): number;
}

/** Route by API path; anything unrouted answers an empty collection. */
function routedFetch(routes: Record<string, Route>): Routed {
  const paths: string[] = [];

  const impl = (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const path = url.pathname.replace('/api/v1', '');
    paths.push(path);

    const route = routes[path];
    const reply = route ? route(url.searchParams) : { json: [] };

    return Promise.resolve(
      new Response(JSON.stringify(reply.json ?? []), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return {
    fetch: impl,
    paths,
    count: (path: string) => paths.filter((seen) => seen === path).length,
  };
}

/** Records shaped only as far as these tools read them. */
const records = (count: number, companyId: number, from = 1): Record<string, unknown>[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: from + index,
    name: `Record ${from + index}`,
    company_id: companyId,
  }));

/** A page-serving route: `page` and `page_size` decide what comes back. */
const pagedRoute =
  (items: readonly Record<string, unknown>[], key?: string): Route =>
  (query) => {
    const page = Number(query.get('page') ?? '1');
    const size = Number(query.get('page_size') ?? '100');
    const slice = items.slice((page - 1) * size, page * size);
    return { json: key === undefined ? slice : { [key]: slice } };
  };

function callTool(
  name: string,
  args: Record<string, unknown>,
  routes: Record<string, Route>,
): { response: Promise<McpToolResponse>; http: Routed } {
  const config = testConfig();
  const http = routedFetch(routes);
  const client = new HuduClient(config, { fetch: http.fetch, clock: fakeClock() });
  const definition = overviewTools().find((tool) => tool.name === name);
  if (!definition) throw new Error(`${name} is not exported by overviewTools()`);

  return { response: executeTool(prepareTool(definition), args, { client, config }), http };
}

const overview = (
  args: Record<string, unknown>,
  routes: Record<string, Route> = {},
): Promise<McpToolResponse> => callTool('hudu_company_overview', args, routes).response;

const gaps = (
  args: Record<string, unknown>,
  routes: Record<string, Route> = {},
): Promise<McpToolResponse> => callTool('hudu_documentation_gaps', args, routes).response;

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

/**
 * The structured payload, read from `structuredContent` rather than parsed back
 * out of the text.
 *
 * Both of these tools prepend a notice whenever a count is a lower bound or a
 * collection could not be read — which is most of this file — so the text
 * channel is deliberately not valid JSON. `structuredContent` is the same
 * already-stripped object the model receives alongside it.
 */
const payloadOf = (response: McpToolResponse): Record<string, unknown> => {
  const structured = response.structuredContent;
  if (structured === undefined) {
    throw new Error(`no structured payload; the tool errored: ${toolText(response)}`);
  }
  return structured;
};

const countFor = (payload: unknown, collection: string): Record<string, unknown> => {
  const reports = asRecord(payload)['counts'] as Record<string, unknown>[];
  const found = reports.find((report) => report['collection'] === collection);
  if (!found) throw new Error(`no count report for ${collection}`);
  return found;
};

const COMPANY_ROUTE: Route = () => ({ json: { company: { id: 7, name: 'Contoso' } } });

/* -------------------------------------------------------------------------- */
/* The surface                                                                 */
/* -------------------------------------------------------------------------- */

describe('what overviewTools() offers', () => {
  it('exports exactly the two composite read tools', () => {
    const tools = overviewTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'hudu_company_overview',
      'hudu_documentation_gaps',
    ]);
    for (const tool of tools) {
      expect(tool.operationClass, `${tool.name} only reads`).toBe('Read');
      expect(tool.requiresPasswordReveal, `${tool.name} must not open a gate`).toBeUndefined();
      expect(tool.requiresPasswordWrite).toBeUndefined();
      expect(tool.requiresExportFlag).toBeUndefined();
    }
  });

  it('tells the model what an inexact count means before it ever sees one', () => {
    for (const tool of overviewTools()) {
      expect(tool.description, tool.name).toMatch(/lower bound|at least/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 1. An incomplete walk is a floor, and says so                               */
/* -------------------------------------------------------------------------- */

describe('a count from a walk that did not finish', () => {
  /** Ten full pages of a hundred: the shared walk cap, never reaching a short page. */
  const overflowing = records(1000, 7);

  it('reports "at least" and sets exact: false', async () => {
    const payload = payloadOf(
      await overview(
        { company_id: 7 },
        { '/companies/7': COMPANY_ROUTE, '/assets': pagedRoute(overflowing, 'assets') },
      ),
    );

    const assets = countFor(payload, 'assets');
    expect(assets['count']).toBe(1000);
    expect(assets['exact'], 'the walk never reached a short page').toBe(false);
    expect(assets['description']).toBe('at least 1000 asset(s)');
    expect(asRecord(payload)['counts_are_lower_bounds']).toBe(true);
  });

  it('never lets the bare number stand alone in the model-visible text', async () => {
    const text = toolText(
      await overview(
        { company_id: 7 },
        { '/companies/7': COMPANY_ROUTE, '/assets': pagedRoute(overflowing, 'assets') },
      ),
    );

    // The notice is prepended, so a reader meets the caveat before the payload.
    const notice = text.slice(0, text.indexOf('{'));
    expect(notice).toMatch(/LOWER BOUNDS/);
    expect(notice).toContain('assets');
    expect(text).toContain('at least 1000 asset(s)');
  });

  it('marks a complete walk exact, so the flag is a distinction and not decoration', async () => {
    const payload = payloadOf(
      await overview(
        { company_id: 7 },
        { '/companies/7': COMPANY_ROUTE, '/assets': pagedRoute(records(12, 7), 'assets') },
      ),
    );

    const assets = countFor(payload, 'assets');
    expect(assets['exact']).toBe(true);
    expect(assets['description']).toBe('12 asset(s)');
    expect(asRecord(payload)['counts_are_lower_bounds']).toBe(false);
    expect(toolText(await overview({ company_id: 7 }, {}))).not.toContain('at least');
  });

  /**
   * `/websites` documents no `company_id` filter, so the count is a client-side
   * match over an instance-wide walk. That makes zero matches on an unfinished
   * walk meaningless — the company's sites may be in the pages never fetched —
   * and the flag has to track the walk rather than the match count.
   */
  it('will not call a client-side filtered zero exact when the walk stopped early', async () => {
    const payload = payloadOf(
      await overview(
        { company_id: 7 },
        { '/companies/7': COMPANY_ROUTE, '/websites': pagedRoute(records(1000, 99)) },
      ),
    );

    const websites = countFor(payload, 'websites');
    expect(websites['count']).toBe(0);
    expect(websites['exact'], 'zero of an unfinished walk proves nothing').toBe(false);
    expect(websites['description']).toBe('at least 0 monitored website(s)');
    expect(String(websites['provenance'])).toMatch(/would not mean the company has none/);
  });

  it('draws no "what looks missing" conclusion from an inexact count', async () => {
    const payload = payloadOf(
      await overview(
        { company_id: 7 },
        {
          '/companies/7': COMPANY_ROUTE,
          // Assets overflow, so "assets but no articles" cannot be asserted from
          // them; networks come back empty and exact, which can.
          '/assets': pagedRoute(overflowing, 'assets'),
        },
      ),
    );

    const observations = (asRecord(payload)['observations'] as string[]).join(' ');
    expect(observations).not.toMatch(/1000 asset/);
    expect(observations).toMatch(/No network is documented/);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. A 401 on passwords is unknown, not zero                                  */
/* -------------------------------------------------------------------------- */

describe('a collection the API key cannot read', () => {
  const routes = {
    '/companies/7': COMPANY_ROUTE,
    '/assets': pagedRoute(records(5, 7), 'assets'),
    '/asset_passwords': (): Reply => ({ status: 401, json: { error: 'Unauthorized' } }),
  };

  it('reports passwords as unavailable and carries no count at all', async () => {
    const payload = payloadOf(await overview({ company_id: 7 }, routes));
    const passwords = countFor(payload, 'passwords');

    expect(passwords['available']).toBe(false);
    expect(passwords['count'], 'a 401 must not become a zero').toBeUndefined();
    expect('count' in passwords, 'the key itself must be absent, not null').toBe(false);
    expect(passwords['exact']).toBeUndefined();
    expect(String(passwords['reason'])).toContain('password scope');
  });

  it('names the scope in prose rather than reporting a credential-free company', async () => {
    const text = toolText(await overview({ company_id: 7 }, routes));

    expect(text).toContain('password scope');
    expect(text).toMatch(/could not be read/);
    expect(text, 'nothing may read as "this company has no credentials"').not.toMatch(
      /0 password record\(s\)/,
    );
    expect(text).not.toMatch(/No credentials are stored/);
  });

  it('still answers with every collection that did read', async () => {
    const payload = payloadOf(await overview({ company_id: 7 }, routes));

    expect(asRecord(payload)['resolved']).toBe(true);
    expect(countFor(payload, 'assets')['count']).toBe(5);
    expect(asRecord(payload)['unreadable_collections']).toHaveLength(1);
  });

  it('reports an absent credential list as zero only when the read succeeded', async () => {
    const payload = payloadOf(
      await overview(
        { company_id: 7 },
        { '/companies/7': COMPANY_ROUTE, '/asset_passwords': (): Reply => ({ json: [] }) },
      ),
    );

    const passwords = countFor(payload, 'passwords');
    expect(passwords['available']).toBe(true);
    expect(passwords['count']).toBe(0);
    expect((asRecord(payload)['observations'] as string[]).join(' ')).toMatch(
      /No credentials are stored/,
    );
  });

  /**
   * The password walk reads whole `asset_password` records, and Hudu returns
   * `password` and `otp_secret` on the *list* response (spec-defects A1). Only
   * the count is emitted, and `executeTool` strips on the way out regardless —
   * but a secret cannot appear in a payload it was never put into.
   */
  it('never carries credential material out of the password walk', async () => {
    const text = toolText(
      await overview(
        { company_id: 7 },
        {
          '/companies/7': COMPANY_ROUTE,
          '/asset_passwords': (): Reply => ({
            json: [{ id: 1, company_id: 7, name: 'Firewall', password: 'CanaryPassw0rd-LEAK' }],
          }),
        },
      ),
    );

    expect(text).not.toContain('CanaryPassw0rd-LEAK');
    expect(countFor(payloadOf(await overview({ company_id: 7 }, {})), 'passwords')['count']).toBe(
      0,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. An ambiguous search is reported, not resolved                            */
/* -------------------------------------------------------------------------- */

describe('resolving a company by search', () => {
  const threeMatches = [
    { id: 1, name: 'Contoso', city: 'Leeds' },
    { id: 2, name: 'Contoso Labs', city: 'Bath' },
    { id: 3, name: 'Contoso Holdings', city: 'Hull' },
  ];

  it('lists the candidates instead of picking the first', async () => {
    const payload = asRecord(
      payloadOf(
        await overview(
          { search: 'contoso' },
          { '/companies': pagedRoute(threeMatches, 'companies') },
        ),
      ),
    );

    expect(payload['resolved']).toBe(false);
    expect(payload['reason']).toBe('ambiguous_search');
    expect(payload['match_count']).toBe(3);
    expect(
      (payload['candidates'] as Record<string, unknown>[]).map((one) => one['company_id']),
    ).toEqual([1, 2, 3]);
    expect(payload['counts']).toBeUndefined();
  });

  it('counts nothing while the company is ambiguous', async () => {
    const { response, http } = callTool(
      'hudu_company_overview',
      { search: 'contoso' },
      { '/companies': pagedRoute(threeMatches, 'companies') },
    );
    await response;

    expect(http.count('/assets'), 'no fan-out may happen before a company is chosen').toBe(0);
    expect(http.paths).toEqual(['/companies']);
  });

  it('resolves silently when exactly one company matches', async () => {
    const payload = asRecord(
      payloadOf(
        await overview(
          { search: 'contoso' },
          { '/companies': pagedRoute([threeMatches[0]!], 'companies') },
        ),
      ),
    );

    expect(payload['resolved']).toBe(true);
    expect(payload['company_id']).toBe(1);
    // The record came back with the search, so it is not fetched a second time.
    expect(asRecord(payload['company'])['name']).toBe('Contoso');
  });

  it('says a search matched nothing without claiming the company does not exist', async () => {
    const response = await overview(
      { search: 'nope' },
      { '/companies': pagedRoute([], 'companies') },
    );
    const payload = asRecord(payloadOf(response));

    expect(payload['reason']).toBe('no_match');
    expect(String(payload['what_to_do'])).toMatch(/archived/i);
    expect(toolText(response)).toMatch(/no counts were gathered/i);
  });

  it('refuses both arguments and neither, rather than ignoring one', async () => {
    const both = await overview({ company_id: 7, search: 'contoso' }, {});
    expect(both.isError).toBe(true);
    expect(toolText(both)).toMatch(/not both/);

    const neither = await overview({}, {});
    expect(neither.isError).toBe(true);
    expect(toolText(neither)).toMatch(/company_id or search/);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. An id that resolves to nothing resolves visibly                          */
/* -------------------------------------------------------------------------- */

describe('a company id the company list cannot account for', () => {
  it('says the company record is absent instead of returning a nameless overview', async () => {
    // GET /companies/{id} answers 200 with an empty body for a missing id (F3).
    const response = await overview(
      { company_id: 4242 },
      { '/companies/4242': (): Reply => ({ json: null }) },
    );
    const payload = asRecord(payloadOf(response));

    expect(payload['company']).toBeNull();
    expect(String(payload['company_record_note'])).toMatch(/returned no record/);
    expect((payload['observations'] as string[]).join(' ')).toMatch(/may not be a company at all/);
  });

  it('renders an unresolvable id honestly in the gap ranking', async () => {
    const payload = asRecord(
      payloadOf(
        await gaps(
          {},
          {
            '/companies': pagedRoute([{ id: 1, name: 'Visible Ltd' }], 'companies'),
            // Twelve assets belong to a company no page of /companies will name:
            // the archived-company case, measured as 64 orphaned assets on a real
            // instance.
            '/assets': pagedRoute([...records(2, 1), ...records(12, 55, 100)], 'assets'),
          },
        ),
      ),
    );

    const orphans = payload['unresolved_company_ids'] as Record<string, unknown>[];
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!['company_id']).toBe(55);
    expect(orphans[0]!['resolves_to']).toBe('id 55 (not in the visible list)');
    expect(orphans[0]!['assets']).toBe(12);
    expect(String(payload['archived_companies'])).toMatch(/Archived companies are missing/);
  });

  it('warns in the notice that orphaned documentation exists at all', async () => {
    const text = toolText(
      await gaps(
        {},
        {
          '/companies': pagedRoute([{ id: 1, name: 'Visible Ltd' }], 'companies'),
          '/assets': pagedRoute(records(3, 55), 'assets'),
        },
      ),
    );

    expect(text.slice(0, text.indexOf('{'))).toMatch(/appear in no company list/);
  });
});

/* -------------------------------------------------------------------------- */
/* The ranking itself                                                          */
/* -------------------------------------------------------------------------- */

describe('hudu_documentation_gaps', () => {
  const companies = [
    { id: 1, name: 'Thin Ltd' },
    { id: 2, name: 'Middling Ltd' },
    { id: 3, name: 'Thorough Ltd' },
  ];

  const routes = {
    '/companies': pagedRoute(companies, 'companies'),
    '/assets': pagedRoute([...records(1, 1), ...records(4, 2, 10), ...records(9, 3, 20)], 'assets'),
    '/articles': pagedRoute([...records(2, 2, 30), ...records(6, 3, 40)], 'articles'),
  };

  it('ranks the thinnest company first with the counts behind it', async () => {
    const payload = asRecord(payloadOf(await gaps({}, routes)));
    const rows = payload['companies_ranked'] as Record<string, unknown>[];

    expect(rows.map((row) => row['name'])).toEqual(['Thin Ltd', 'Middling Ltd', 'Thorough Ltd']);
    expect(rows[0]!['assets']).toBe(1);
    expect(rows[0]!['articles']).toBe(0);
    expect(rows[0]!['description']).toBe('1 asset(s), 0 article(s)');
    expect(payload['ranking_reliable']).toBe(true);
    expect(payload['counts_are_lower_bounds']).toBe(false);
  });

  it('costs one walk per collection rather than one call per company', async () => {
    const { response, http } = callTool('hudu_documentation_gaps', {}, routes);
    const payload = asRecord(payloadOf(await response));

    expect(http.paths.sort()).toEqual(['/articles', '/assets', '/companies']);
    expect(payload['requests_made']).toBe(3);
  });

  it('honours limit and reports what it did not show', async () => {
    const payload = asRecord(payloadOf(await gaps({ limit: 1 }, routes)));

    expect(payload['companies_shown']).toBe(1);
    expect(payload['companies_considered']).toBe(3);
    expect(payload['companies_ranked']).toHaveLength(1);
  });

  it('declares the ranking unreliable when a walk hit its cap', async () => {
    const response = await gaps(
      {},
      {
        '/companies': pagedRoute(companies, 'companies'),
        // 2,500 records is the gap-walk cap: every page full, no short page.
        '/assets': pagedRoute(records(2500, 3), 'assets'),
      },
    );
    const payload = asRecord(payloadOf(response));
    const rows = payload['companies_ranked'] as Record<string, unknown>[];

    expect(payload['ranking_reliable']).toBe(false);
    expect(payload['counts_are_lower_bounds']).toBe(true);
    expect(rows[0]!['counts_are_lower_bounds']).toBe(true);
    expect(rows[0]!['description']).toMatch(/^at least 0 asset\(s\)/);
    expect(toolText(response).slice(0, 400)).toMatch(/NOT reliable/);
  });

  it('keeps ranking on assets when the article walk fails, and says what is missing', async () => {
    const payload = asRecord(
      payloadOf(
        await gaps(
          {},
          {
            '/companies': pagedRoute(companies, 'companies'),
            '/assets': pagedRoute(records(3, 2), 'assets'),
            '/articles': (): Reply => ({ status: 500, json: { error: 'boom' } }),
          },
        ),
      ),
    );

    const unreadable = payload['unreadable_collections'] as Record<string, unknown>[];
    expect(unreadable.map((entry) => entry['collection'])).toEqual(['articles (instance-wide)']);
    expect(payload['ranking_reliable'], 'a missing collection cannot make a reliable ranking').toBe(
      false,
    );
    expect((payload['companies_ranked'] as Record<string, unknown>[]).length).toBe(3);

    const scope = payload['scope'] as Record<string, unknown>[];
    const articles = scope.find((entry) => entry['collection'] === 'articles (instance-wide)');
    expect('count' in asRecord(articles), 'an unread collection has no count').toBe(false);
  });

  it('counts global articles separately rather than attributing them to a company', async () => {
    const payload = asRecord(
      payloadOf(
        await gaps(
          {},
          {
            '/companies': pagedRoute(companies, 'companies'),
            '/articles': pagedRoute(
              [{ id: 1, name: 'Global runbook', company_id: null }, ...records(2, 1, 5)],
              'articles',
            ),
          },
        ),
      ),
    );

    expect(payload['articles_without_a_company']).toBe(1);
    const rows = payload['companies_ranked'] as Record<string, unknown>[];
    const thin = rows.find((row) => row['company_id'] === 1);
    expect(thin?.['articles']).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

describe('markdown rendering', () => {
  it('carries the lower-bound wording into the human-facing text too', async () => {
    const text = toolText(
      await overview(
        { company_id: 7, response_format: 'markdown' },
        { '/companies/7': COMPANY_ROUTE, '/assets': pagedRoute(records(1000, 7), 'assets') },
      ),
    );

    expect(text).toContain('# Contoso (company 7)');
    expect(text).toContain('at least 1000 asset(s)');
    expect(text).toMatch(/Some counts are lower bounds/);
  });

  it('prints an unreadable collection as unreadable, never as a number', async () => {
    const text = toolText(
      await overview(
        { company_id: 7, response_format: 'markdown' },
        {
          '/companies/7': COMPANY_ROUTE,
          '/asset_passwords': (): Reply => ({ status: 401, json: { error: 'Unauthorized' } }),
        },
      ),
    );

    expect(text).toMatch(/\*\*passwords\*\*: could not be read/);
    expect(text).not.toMatch(/\*\*passwords\*\*: 0/);
  });
});
