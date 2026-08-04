/**
 * Contract tests against a live Hudu instance.
 *
 * These are the only tests in this repository that touch the network, and they
 * skip themselves unless `HUDU_CONTRACT_TESTS=1` and both `HUDU_BASE_URL` and
 * `HUDU_API_KEY` are set. CI must never enable them.
 *
 * Their purpose is narrow and worth stating plainly: everything else in this
 * suite is written against `docs/reference/api-docs.json`, captured from a live
 * instance on 2026-08-04. If Hudu changes, every other test still passes while
 * the server is quietly wrong. These tests detect that drift, so each assertion
 * checks a shape the production code *assumes* rather than merely a shape that
 * happens to be returned.
 *
 * Beyond drift detection, most of the assertions below test a numbered claim in
 * `docs/reference/spec-defects.md` — the claims that were derived by reading the
 * specification and have never been checked against a running instance. Each
 * such assertion names its item number in the failure message, so a failure
 * points at the paragraph that has to be rewritten rather than at a line of
 * test code.
 *
 * READ-ONLY, WITHOUT EXCEPTION. Every request this file can make is a `GET`.
 * `HuduClient.get` and the local `rawGet` helper are the only two ways a request
 * leaves this file, and neither accepts a method argument. There is no guarded
 * write path here and there must never be one — these tests run against
 * production MSP tenants holding real customer data, and a contract test that
 * can mutate one is a defect regardless of how carefully it is gated.
 *
 * An empty tenant is not drift. Every test that needs records to be meaningful
 * skips itself, with a message saying what was missing, rather than failing.
 */

import { describe, expect, it, type TestContext } from 'vitest';

import { HuduClient } from '../../src/api/client.js';
import { unwrapList, unwrapRecord } from '../../src/api/envelope.js';
import { errorFromResponse } from '../../src/api/errors.js';
import { buildPath, buildUrl, type QueryValue } from '../../src/api/paths.js';
import { loadConfig, MAX_PAGE_SIZE, normaliseBaseUrl } from '../../src/config.js';

/**
 * Abandon a test because this instance cannot answer the question.
 *
 * An empty collection is not drift, and neither is a tenant with no racks. Every
 * test below that needs records to be meaningful calls this instead of failing,
 * so the run reports "not observable here" rather than a false positive.
 *
 * `ctx.skip` already throws, but its declaration is overloaded and the compiler
 * will not treat a call to it as unreachable-after. The explicit annotation here
 * carries that `never` so a skip genuinely ends the test in the type system too.
 */
const skipWith: (ctx: TestContext, note: string) => never = (ctx, note) => ctx.skip(note);

const enabled =
  process.env['HUDU_CONTRACT_TESTS'] === '1' &&
  (process.env['HUDU_BASE_URL'] ?? '') !== '' &&
  (process.env['HUDU_API_KEY'] ?? '') !== '';

const DRIFT =
  'the captured contract and live behaviour have diverged. docs/reference/api-docs.json was ' +
  'captured on 2026-08-04 and the code assumes the shape it describes; this instance returned ' +
  'something else. Re-capture the contract, update docs/reference/spec-defects.md, and check ' +
  'whether any tool built on that assumption is now wrong.';

const client = (): HuduClient => new HuduClient(loadConfig(process.env, '0.0.0-contract'), {});

/* -------------------------------------------------------------------------- */
/* Raw GET helper                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A `GET` issued outside {@link HuduClient}, so that a test can see the response
 * headers.
 *
 * `HuduResponse` deliberately surfaces only `status` and `data`; nothing in the
 * server needs headers, and C1 and A8 are claims *about headers*. Widening the
 * client's public API to serve a test would put a seam in production code that
 * production code has no use for, so the narrower change is one plain `fetch`
 * here, reusing `buildPath`/`buildUrl` so the URL is assembled exactly as the
 * client assembles it.
 *
 * The method is a literal. This helper takes no method parameter, by design:
 * that is where the read-only guarantee of this file is actually enforced.
 * Redirects are not followed — a 3xx is an observation, and following one could
 * send the API key to whatever host the redirect names.
 */
interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Two requests per second, matching the pace `scripts/contract-recon.mjs` keeps. */
const MIN_REQUEST_INTERVAL_MS = 500;
let nextRequestAt = 0;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function rawGet(path: string, query: Record<string, QueryValue> = {}): Promise<RawResponse> {
  const now = Date.now();
  if (nextRequestAt > now) await sleep(nextRequestAt - now);
  nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;

  const baseUrl = normaliseBaseUrl(process.env['HUDU_BASE_URL'] ?? '');
  const response = await fetch(buildUrl(baseUrl, buildPath(path), query), {
    method: 'GET',
    headers: {
      'x-api-key': process.env['HUDU_API_KEY'] ?? '',
      accept: 'application/json',
    },
    redirect: 'manual',
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    // Hudu answers some failures with an HTML page. The status is the
    // observation that matters in that case; the body is left undefined.
    body = undefined;
  }

  return { status: response.status, headers: response.headers, body };
}

/**
 * Memoised {@link rawGet}, keyed on path and query rather than on the full URL
 * so the instance hostname never becomes part of a cache key.
 *
 * Several claims are tested against the same response — C1 and the envelope
 * shape both read `GET /companies?page=1&page_size=5` — and issuing that request
 * once per claim would multiply the load on a production tenant for no gain.
 */
const responses = new Map<string, Promise<RawResponse>>();

function probe(path: string, query: Record<string, QueryValue> = {}): Promise<RawResponse> {
  const key = buildUrl('', buildPath(path), query);
  const cached = responses.get(key);
  if (cached !== undefined) return cached;
  const pending = rawGet(path, query);
  responses.set(key, pending);
  return pending;
}

/* -------------------------------------------------------------------------- */
/* Shape helpers                                                              */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const topLevelKeys = (body: unknown): string[] => (isRecord(body) ? Object.keys(body) : []);

/**
 * Describe a body by shape and key names only.
 *
 * Failure messages go into CI logs and issue reports, so they must be safe to
 * paste: nothing here reads a record's *values*.
 */
function shapeOf(body: unknown): string {
  if (body === undefined || body === null) return 'an empty body';
  if (Array.isArray(body)) return `a bare array of ${body.length}`;
  if (isRecord(body)) {
    const arrayKeys = Object.keys(body).filter((key) => Array.isArray(body[key]));
    if (arrayKeys.length > 0) return `an object wrapping arrays under [${arrayKeys.join(', ')}]`;
    return `a single object with keys [${Object.keys(body).join(', ')}]`;
  }
  return `a bare ${typeof body}`;
}

/* -------------------------------------------------------------------------- */
/* The list endpoints this server calls                                       */
/* -------------------------------------------------------------------------- */

interface ListEndpoint {
  readonly path: string;
  /** The `listKey` the matching ResourceSpec passes to `unwrapList`. */
  readonly listKey?: string;
  readonly paginated: boolean;
  /** False only for `/asset_layouts`, which documents `page` and no `page_size` (C3). */
  readonly pageSizeSupported?: boolean;
  /**
   * Accept a single bare object where a list was expected, as `unwrapList`
   * does. Set for no endpoint since the live run settled B1: `/asset_layouts`
   * returns `{asset_layouts: [...]}`, not the single object the contract
   * documents. Kept because the tolerance in `unwrapList` is still real and the
   * next endpoint to contradict its own schema will need it.
   */
  readonly allowSingleObject?: boolean;
  /** Records to ask for. Lower for endpoints whose records carry secrets. */
  readonly probePageSize?: number;
  /** Where the assumption lives, so a failure names the file to fix. */
  readonly declaredIn: string;
}

/**
 * Every collection the server lists, with the envelope key its tool declares.
 *
 * Kept in step with the `ResourceSpec` literals in `src/tools/*.ts` by hand.
 * That duplication is deliberate: a table derived from the specs would agree
 * with them by construction and could never catch a wrong `listKey`.
 */
const LIST_ENDPOINTS: readonly ListEndpoint[] = [
  {
    path: '/companies',
    listKey: 'companies',
    paginated: true,
    declaredIn: 'src/tools/companies.ts',
  },
  { path: '/assets', listKey: 'assets', paginated: true, declaredIn: 'src/tools/assets.ts' },
  {
    path: '/asset_layouts',
    // B1 predicted a single bare object here. The live run found
    // `{asset_layouts: [...]}` instead (spec-defects.md F1), so the envelope is
    // declared and `allowSingleObject` no longer describes this endpoint.
    listKey: 'asset_layouts',
    paginated: true,
    pageSizeSupported: false,
    declaredIn: 'src/tools/assets.ts',
  },
  // page_size 1: these records carry `password` and `otp_secret` (A1), so the
  // test pulls the smallest sample that can answer the question and reads only
  // key names from it.
  {
    path: '/asset_passwords',
    paginated: true,
    probePageSize: 1,
    declaredIn: 'src/tools/passwords.ts',
  },
  { path: '/password_folders', paginated: true, declaredIn: 'src/tools/passwords.ts' },
  { path: '/articles', listKey: 'articles', paginated: true, declaredIn: 'src/tools/content.ts' },
  { path: '/folders', listKey: 'folders', paginated: true, declaredIn: 'src/tools/content.ts' },
  {
    path: '/procedures',
    listKey: 'procedures',
    paginated: true,
    declaredIn: 'src/tools/content.ts',
  },
  { path: '/websites', paginated: true, declaredIn: 'src/tools/monitoring.ts' },
  {
    path: '/relations',
    listKey: 'relations',
    paginated: true,
    declaredIn: 'src/tools/monitoring.ts',
  },
  { path: '/magic_dash', paginated: true, declaredIn: 'src/tools/monitoring.ts' },
  {
    path: '/matchers',
    listKey: 'matchers',
    paginated: true,
    declaredIn: 'src/tools/monitoring.ts',
  },
  { path: '/users', listKey: 'users', paginated: true, declaredIn: 'src/tools/admin.ts' },
  { path: '/activity_logs', paginated: true, declaredIn: 'src/tools/admin.ts' },
  { path: '/expirations', paginated: true, declaredIn: 'src/tools/admin.ts' },
  {
    path: '/public_photos',
    listKey: 'public_photos',
    paginated: true,
    declaredIn: 'src/tools/admin.ts',
  },
  { path: '/uploads', paginated: false, declaredIn: 'src/tools/admin.ts' },
  { path: '/networks', paginated: false, declaredIn: 'src/tools/ipam.ts' },
  { path: '/ip_addresses', paginated: false, declaredIn: 'src/tools/ipam.ts' },
  { path: '/rack_storages', paginated: false, declaredIn: 'src/tools/racks.ts' },
  { path: '/rack_storage_items', paginated: false, declaredIn: 'src/tools/racks.ts' },
];

/** The query a list probe sends, matching what `buildListTool` would send. */
function probeQuery(endpoint: ListEndpoint): Record<string, QueryValue> {
  if (!endpoint.paginated) return {};
  if (endpoint.pageSizeSupported === false) return { page: 1 };
  return { page: 1, page_size: endpoint.probePageSize ?? 5 };
}

const listOf = (response: RawResponse, endpoint: ListEndpoint): unknown[] =>
  unwrapList<unknown>(response.body, endpoint.listKey, `GET ${endpoint.path}`);

const endpointFor = (path: string): ListEndpoint => {
  const found = LIST_ENDPOINTS.find((endpoint) => endpoint.path === path);
  /* c8 ignore next -- every caller passes a path from the table above */
  if (!found) throw new Error(`No list endpoint declared for ${path}`);
  return found;
};

/* -------------------------------------------------------------------------- */

describe.skipIf(!enabled)('live Hudu contract', () => {
  it('GET /api_info returns the version fields the code reports', async () => {
    const response = await client().get<Record<string, unknown>>(buildPath('/api_info'));

    expect(response.status, DRIFT).toBe(200);
    expect(response.data, DRIFT).toBeTypeOf('object');
    expect(Object.keys(response.data), DRIFT).toContain('version');
  });

  it('GET /companies wraps its array under "companies", with no total', async () => {
    const response = await client().get<unknown>(buildPath('/companies'), {
      page: 1,
      page_size: 5,
    });

    expect(response.status, DRIFT).toBe(200);

    // Corrected from "returns a bare array". The captured contract documents no
    // envelope here and this test asserted a bare array on that basis; the live
    // run found `{companies: [...]}` (spec-defects.md F1), so the old assertion
    // was testing the document rather than the endpoint. `hudu_list_companies`
    // now declares the envelope, and this is what it depends on.
    expect(
      isRecord(response.data) && Array.isArray(response.data['companies']),
      `Envelope drift on GET /companies: src/tools/companies.ts declares listKey "companies" ` +
        `from a live observation on Hudu 2.34.2. This instance returned ${shapeOf(response.data)}. ` +
        DRIFT,
    ).toBe(true);

    // C1: no collection endpoint returns a total count. `page_was_full` is the
    // only honest signal this server can emit.
    expect(topLevelKeys(response.data), DRIFT).not.toContain('total');

    const items = unwrapList<Record<string, unknown>>(response.data, 'companies', 'GET /companies');
    expect(items.length, DRIFT).toBeLessThanOrEqual(5);
    if (items.length > 0) {
      expect(Object.keys(items[0]!), DRIFT).toContain('id');
      expect(Object.keys(items[0]!), DRIFT).toContain('name');
    }
  });

  it('GET /companies honours page_size, so the clamp means something', async () => {
    const response = await client().get<unknown>(buildPath('/companies'), {
      page: 1,
      page_size: 1,
    });

    const items = unwrapList<unknown>(response.data, 'companies', 'GET /companies');
    expect(items.length, DRIFT).toBeLessThanOrEqual(1);
  });

  it('GET /asset_layouts returns a wrapped list, not the one object it documents (B1)', async () => {
    // The published schema says the 200 response is a single Asset_Layout. The
    // live run found `{asset_layouts: [...]}` (spec-defects.md F1), which is
    // what the tool now declares. `unwrapList` still absorbs the single-object
    // form, so a return to the documented shape would not break the tool — but
    // it would break this assertion, which is the point of testing it here.
    const response = await client().get<unknown>(buildPath('/asset_layouts'), { page: 1 });

    expect(response.status, DRIFT).toBe(200);
    expect(
      isRecord(response.data) && Array.isArray(response.data['asset_layouts']),
      `Envelope drift on GET /asset_layouts: src/tools/assets.ts declares listKey ` +
        `"asset_layouts". This instance returned ${shapeOf(response.data)}. ${DRIFT}`,
    ).toBe(true);

    const items = unwrapList<Record<string, unknown>>(
      response.data,
      'asset_layouts',
      'GET /asset_layouts',
    );
    expect(Array.isArray(items), DRIFT).toBe(true);

    if (items.length > 0) {
      expect(Object.keys(items[0]!), DRIFT).toContain('id');
    }
  });

  it('GET /asset_layouts still returns something without page_size (C3)', async () => {
    // C3: this is the only endpoint in the contract that paginates without a
    // size control, which is why hudu_list_asset_layouts offers no page_size.
    const response = await client().get<unknown>(buildPath('/asset_layouts'));

    expect(response.status, DRIFT).toBe(200);
    expect(
      () => unwrapList(response.data, 'asset_layouts', 'GET /asset_layouts'),
      DRIFT,
    ).not.toThrow();
  });

  it('authenticates with x-api-key alone', async () => {
    // A 401 here means the key or the header scheme has changed; the client
    // sends no Authorization header and never has.
    const response = await client().get<unknown>(buildPath('/api_info'));
    expect(response.status, DRIFT).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/* C1: no collection endpoint reports a total                                 */
/* -------------------------------------------------------------------------- */

/**
 * Body keys that would mean Hudu now reports a total.
 *
 * `meta` and `pagination` are included because a wrapper object is the usual
 * way an API adds counting without changing the array's key.
 */
const TOTAL_BODY_KEYS = ['total', 'total_count', 'count', 'meta', 'pagination'] as const;

/** Headers that would carry a total or a next-page link outside the body. */
const TOTAL_HEADERS = ['x-total-count', 'link'] as const;

const C1_CONSEQUENCE =
  'C1 is load-bearing: it is the reason this server emits no `total` and no `has_more`, and the ' +
  'reason `page_was_full` exists at all (CLAUDE.md invariant 5). If a total is now available, ' +
  'the honest-pagination design in src/presentation/format.ts should be revisited and ' +
  'docs/reference/spec-defects.md C1 rewritten. Until then this is drift, not an improvement.';

describe.skipIf(!enabled)('C1: collections carry no total, in the body or the headers', () => {
  for (const endpoint of LIST_ENDPOINTS) {
    it(`GET ${endpoint.path} reports no total`, async (ctx) => {
      const response = await probe(endpoint.path, probeQuery(endpoint));

      if (response.status !== 200) {
        skipWith(
          ctx,
          `GET ${endpoint.path} answered HTTP ${response.status} on this instance, so C1 could ` +
            'not be tested against it. If that status is 401/403/404 on /asset_passwords, the ' +
            'A7 test is where that is examined.',
        );
      }

      const keys = topLevelKeys(response.body);
      const totals = TOTAL_BODY_KEYS.filter((key) => keys.includes(key));
      expect(
        totals,
        `C1: GET ${endpoint.path} returned top-level key(s) [${totals.join(', ')}] where the ` +
          `contract documents none. Observed ${shapeOf(response.body)}. ${C1_CONSEQUENCE}`,
      ).toEqual([]);

      const headers = TOTAL_HEADERS.filter((name) => response.headers.get(name) !== null);
      expect(
        headers,
        `C1: GET ${endpoint.path} answered with header(s) [${headers.join(', ')}], which the ` +
          `captured contract documents nowhere. ${C1_CONSEQUENCE}`,
      ).toEqual([]);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Envelope shape per list endpoint                                           */
/* -------------------------------------------------------------------------- */

const ENVELOPE_CONSEQUENCE =
  'This is the worst failure mode in the server: `unwrapList` does not throw for most wrong ' +
  'shapes, it returns an empty array, and an agent reads an empty list as "there are none of ' +
  'these" rather than as an error. Correct the `listKey` on the ResourceSpec and re-capture ' +
  'docs/reference/api-docs.json.';

describe.skipIf(!enabled)('list envelopes match the listKey each tool declares', () => {
  for (const endpoint of LIST_ENDPOINTS) {
    const expectation =
      endpoint.listKey === undefined
        ? 'a bare array'
        : `an object wrapping the array under "${endpoint.listKey}"`;

    it(`GET ${endpoint.path} returns ${expectation}`, async (ctx) => {
      const response = await probe(endpoint.path, probeQuery(endpoint));

      if (response.status !== 200) {
        skipWith(
          ctx,
          `GET ${endpoint.path} answered HTTP ${response.status} on this instance, so its ` +
            'envelope could not be observed.',
        );
      }
      if (response.body === undefined) {
        skipWith(
          ctx,
          `GET ${endpoint.path} returned an empty body, so there is no envelope to check.`,
        );
      }

      const observed = shapeOf(response.body);

      if (endpoint.listKey === undefined) {
        // `allowSingleObject` covers B1 only: `GET /asset_layouts` is documented
        // as one object and `unwrapList` absorbs that by promoting it.
        const acceptable =
          Array.isArray(response.body) ||
          (endpoint.allowSingleObject === true && isRecord(response.body) && 'id' in response.body);

        expect(
          acceptable,
          `Envelope drift on GET ${endpoint.path}: ${endpoint.declaredIn} declares no listKey, ` +
            `so the tool expects a bare array. This instance returned ${observed}. ` +
            `${ENVELOPE_CONSEQUENCE} ${DRIFT}`,
        ).toBe(true);
      } else {
        const wrapped = isRecord(response.body) && Array.isArray(response.body[endpoint.listKey]);
        expect(
          wrapped,
          `Envelope drift on GET ${endpoint.path}: ${endpoint.declaredIn} passes ` +
            `listKey "${endpoint.listKey}", so the tool expects an object with that array on ` +
            `it. This instance returned ${observed}. ${ENVELOPE_CONSEQUENCE} ${DRIFT}`,
        ).toBe(true);

        // A second array-valued key would make `unwrapList`'s fallback ambiguous
        // the moment the documented key is ever renamed, and it would throw
        // rather than guess. Better to know now.
        const body = response.body;
        const arrayKeys = isRecord(body)
          ? Object.keys(body).filter((key) => Array.isArray(body[key]))
          : [];
        expect(
          arrayKeys.filter((key) => key !== endpoint.listKey),
          `GET ${endpoint.path} wraps more than one array. src/api/envelope.ts falls back to ` +
            '"the only array-valued property" when the documented key is missing, and that ' +
            `fallback stops working here. ${DRIFT}`,
        ).toEqual([]);
      }

      // What production actually does with this body, asserted directly.
      const items = listOf(response, endpoint);
      expect(
        Array.isArray(items),
        `unwrapList could not normalise GET ${endpoint.path}. Observed ${observed}. ${DRIFT}`,
      ).toBe(true);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* A7: what a scope failure actually looks like                               */
/* -------------------------------------------------------------------------- */

/**
 * A7 is only testable with a key that lacks password access. Set this when the
 * key under test *has* it, so the test skips rather than reports the resulting
 * `200` as a security finding.
 */
const keyHasPasswordAccess = process.env['HUDU_CONTRACT_KEY_HAS_PASSWORD_ACCESS'] === '1';

describe.skipIf(!enabled)('A7: no 403 is documented, so what does a scope failure return?', () => {
  it('GET /asset_passwords resolves A7 empirically', async (ctx) => {
    if (keyHasPasswordAccess) {
      skipWith(
        ctx,
        'HUDU_CONTRACT_KEY_HAS_PASSWORD_ACCESS=1, so this key can read passwords and cannot ' +
          'demonstrate a scope failure. Re-run with a key created with password access OFF to ' +
          'resolve A7.',
      );
    }

    const endpoint = endpointFor('/asset_passwords');
    const response = await probe(endpoint.path, probeQuery(endpoint));
    const status = response.status;

    expect(
      [200, 401, 403, 404],
      `A7: GET /asset_passwords answered HTTP ${status} for an API key created without ` +
        'password access. A7 predicted 401 or 404 because no 403 appears anywhere in the ' +
        'captured contract, and this is none of the four outcomes that were anticipated ' +
        '(200-with-empty, 401, 403, 404). Record HTTP ' +
        `${status} in docs/reference/spec-defects.md A7 and add guidance for it to ` +
        'src/api/errors.ts, which currently has none.',
    ).toContain(status);

    if (status === 200) {
      const items = listOf(response, endpoint);
      expect(
        items.length,
        `A7 (security finding): GET /asset_passwords answered HTTP 200 with ${items.length} ` +
          'record(s) for a key created with password access OFF. Either the key scope is not ' +
          'enforced on this endpoint, or the key under test does have password access — check ' +
          'the key in Hudu before reporting this, and set ' +
          'HUDU_CONTRACT_KEY_HAS_PASSWORD_ACCESS=1 if it does. If the scope really is ' +
          'unenforced, that outranks every other finding in this file: A1 says one unfiltered ' +
          'call returns every credential and every TOTP seed visible to the key.',
      ).toBe(0);
      return;
    }

    // Whatever the status turns out to be, the operator reading the error has to
    // be told that a key scope is a possible cause. That is the whole point of
    // A7: a scope failure is indistinguishable from a bad key or a missing
    // record unless the guidance says so.
    const { guidance } = errorFromResponse({
      status,
      statusText: '',
      method: 'GET',
      url: '',
    });

    expect(
      /scope|scoped|permission/i.test(guidance),
      `A7 resolved: a password-scope failure on this instance is HTTP ${status}. The guidance ` +
        `src/api/errors.ts gives for ${status} does not mention key scope, so an operator who ` +
        'hits it will chase the wrong cause. Add it, and record the observed status in ' +
        `docs/reference/spec-defects.md A7. Current guidance: "${guidance}"`,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* A8: rate-limit headers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `X-RateLimit-*`, `RateLimit-*` and `Retry-After`, as lower-cased header names.
 * The optional hyphen catches `x-rate-limit-remaining`, which some Rails
 * throttles emit instead.
 */
const RATE_LIMIT_HEADER = /^(?:x-)?rate-?limit-|^retry-after$/;

describe.skipIf(!enabled)('A8: rate limiting is invisible in the response', () => {
  // No attempt is made to provoke a 429. The published limit is 300/minute and
  // this runs against production tenants; hammering one to observe an error
  // would be a denial of service dressed up as a test.
  it('a normal 200 carries no rate-limit headers', async () => {
    const response = await probe('/api_info');
    expect(response.status, DRIFT).toBe(200);

    const seen = [...response.headers.keys()].filter((name) => RATE_LIMIT_HEADER.test(name));
    expect(
      seen,
      `A8: GET /api_info answered with rate-limit header(s) [${seen.join(', ')}]. A8 says the ` +
        'contract documents none, which is why src/api/rate-limit.ts paces requests client-side ' +
        'from a configured number rather than from anything the server says. If these headers ' +
        'are real, the client could follow them instead of guessing — update ' +
        'docs/reference/spec-defects.md A8 and open an issue to use them.',
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* D12: the effective page_size ceiling                                       */
/* -------------------------------------------------------------------------- */

/**
 * Collections most likely to hold more than `MAX_PAGE_SIZE` records on a real
 * MSP tenant, in the order they are tried. `/asset_passwords` is deliberately
 * absent: it is the one collection this file will not page through.
 */
const CEILING_CANDIDATES = ['/assets', '/activity_logs', '/articles', '/companies'] as const;

describe.skipIf(!enabled)('D12: no maximum page_size is published', () => {
  it(`the instance honours page_size=${MAX_PAGE_SIZE}, or reveals the ceiling it applies`, async (ctx) => {
    const notes: string[] = [];

    for (const path of CEILING_CANDIDATES) {
      const endpoint = endpointFor(path);
      const wide = await probe(path, { page: 1, page_size: MAX_PAGE_SIZE });

      if (wide.status !== 200) {
        notes.push(`${path} answered HTTP ${wide.status}`);
        continue;
      }

      const returned = listOf(wide, endpoint).length;
      if (returned === 0) {
        notes.push(`${path} is empty`);
        continue;
      }

      // Ask for the page *after* the one just returned, sized to match it. A
      // non-empty answer proves more records existed than the wide page carried,
      // which can only mean the server capped the page at `returned`. An empty
      // answer means the collection simply holds `returned` records and says
      // nothing about a ceiling.
      const next = await probe(path, { page: 2, page_size: returned });
      const moreExists = next.status === 200 && listOf(next, endpoint).length > 0;

      if (!moreExists) {
        notes.push(
          `${path} holds ${returned} record(s) in total, fewer than the ${MAX_PAGE_SIZE} asked ` +
            'for, so no ceiling is observable on it',
        );
        continue;
      }

      expect(
        returned,
        `D12: GET ${path}?page=1&page_size=${MAX_PAGE_SIZE} returned ${returned} records, and ` +
          `page 2 at that size still had records — so this instance caps page_size at ` +
          `${returned}, not at ${MAX_PAGE_SIZE}. src/config.ts sets MAX_PAGE_SIZE=` +
          `${MAX_PAGE_SIZE} and src/tools/resource.ts tells every caller that a value up to ` +
          'that is honoured. Both are wrong: a caller asking for 100 and receiving ' +
          `${returned} reads the short page as the end of the collection. Lower MAX_PAGE_SIZE ` +
          `to ${returned} and record the observed ceiling under D12.`,
      ).toBe(MAX_PAGE_SIZE);

      return;
    }

    skipWith(
      ctx,
      `D12 could not be tested: no candidate collection on this instance holds more than ` +
        `${MAX_PAGE_SIZE} records, so a server-side cap and a short collection are ` +
        `indistinguishable. Probed ${notes.join('; ')}.`,
    );
  });

  it('a page past the end is an empty collection, not an error', async () => {
    // The whole honest-pagination design walks pages until one comes back short
    // (C1). That walk steps one page past the end by construction, so this has
    // to be a normal, empty 200 rather than a 404 or a 422.
    const endpoint = endpointFor('/companies');
    const response = await probe('/companies', { page: 9_999, page_size: 1 });

    expect(
      response.status,
      `C1 (pagination): GET /companies?page=9999 answered HTTP ${response.status}. Paging past ` +
        'the end is how a caller discovers the end — there is no total to compare against — so ' +
        'anything other than an empty 200 makes the documented walk in ' +
        `src/presentation/format.ts unsafe. ${DRIFT}`,
    ).toBe(200);

    expect(
      listOf(response, endpoint).length,
      `C1 (pagination): GET /companies?page=9999 returned records. Either this instance has ` +
        'more than 9,999 pages of companies, or page numbers past the end wrap around — and if ' +
        'they wrap, a page walk never terminates. Investigate before trusting any list tool.',
    ).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* C2: collections with no pagination at all                                  */
/* -------------------------------------------------------------------------- */

describe.skipIf(!enabled)('C2/F4: unpaginated collections reject page and page_size', () => {
  for (const path of ['/networks', '/ip_addresses'] as const) {
    it(`GET ${path} rejects page and page_size outright`, async (ctx) => {
      const all = await probe(path);

      if (all.status !== 200) {
        skipWith(ctx, `GET ${path} answered HTTP ${all.status} on this instance.`);
      }

      const paged = await probe(path, { page: 1, page_size: 1 });

      // F4, measured on 2.34.2: Hudu does not ignore a parameter an endpoint
      // does not document — it answers 400 "page is not a valid filter
      // parameter" and returns nothing at all. That is why `paginated: false`
      // on these specs is load-bearing rather than cosmetic, and why passing
      // arguments through on the assumption the server will drop what it does
      // not recognise is unsafe against this API.
      expect(
        paged.status,
        `F4: GET ${path}?page=1&page_size=1 answered HTTP ${paged.status}, where 400 was ` +
          'measured on 2.34.2. If this endpoint now accepts pagination, src/tools/ipam.ts is ' +
          'withholding arguments that would work AND its `page_was_full: false` claim is no ' +
          'longer safe — a caller could be reading page 1 of many and be told it is the whole ' +
          `set. Re-capture the contract and revisit C2 and F4. ${DRIFT}`,
      ).toBe(400);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* D10: the read shape of asset custom fields                                 */
/* -------------------------------------------------------------------------- */

describe.skipIf(!enabled)('D10: assets read back `fields`, not `custom_fields`', () => {
  it('a returned asset carries {id, label, value, position} field entries', async (ctx) => {
    const endpoint = endpointFor('/assets');
    const response = await probe('/assets', { page: 1, page_size: 25 });

    if (response.status !== 200) {
      skipWith(ctx, `GET /assets answered HTTP ${response.status} on this instance.`);
    }

    const assets = listOf(response, endpoint).filter(isRecord);
    if (assets.length === 0) {
      skipWith(
        ctx,
        'This instance has no assets, so the read shape of `fields` cannot be observed.',
      );
    }

    const withFields = assets.find(
      (asset) => Array.isArray(asset['fields']) && asset['fields'].length > 0,
    );
    if (withFields === undefined) {
      skipWith(
        ctx,
        `None of the first ${assets.length} assets on this instance has a non-empty \`fields\` ` +
          'array, so D10 could not be checked. This is not drift — an asset layout with no ' +
          'custom fields is legitimate.',
      );
    }

    const entries = (withFields['fields'] as unknown[]).filter(isRecord);
    expect(
      entries.length,
      `D10: an asset's \`fields\` array holds entries that are not objects. Observed entry ` +
        `types: [${(withFields['fields'] as unknown[]).map((entry) => typeof entry).join(', ')}]. ` +
        DRIFT,
    ).toBeGreaterThan(0);

    const entry = entries[0]!;
    for (const key of ['id', 'label', 'position'] as const) {
      expect(
        Object.keys(entry),
        `D10: an asset field entry has no \`${key}\`. The contract describes reads as returning ` +
          '`fields` as an array of {id, label, value, position}, and ' +
          'docs/reference/spec-defects.md D10 documents the read/write asymmetry on that ' +
          `basis. Observed keys: [${Object.keys(entry).join(', ')}]. ${DRIFT}`,
      ).toContain(key);
    }

    // `value` is checked separately: an empty custom field plausibly omits it,
    // and conflating that with a renamed key would waste an investigation.
    expect(
      'value' in entry,
      `D10: an asset field entry has no \`value\` key. Observed keys: ` +
        `[${Object.keys(entry).join(', ')}]. If Hudu now omits \`value\` on empty fields that ` +
        'is worth recording under D10; if it has been renamed, every caller reading a custom ' +
        'field is affected.',
    ).toBe(true);

    // The write-side name must not appear on a read. If it does, the asymmetry
    // D10 describes has been fixed upstream and the tool descriptions that warn
    // about it are now misleading.
    expect(
      Object.keys(withFields).includes('custom_fields'),
      'D10: a read of an asset returned `custom_fields`, which the contract documents only on ' +
        'the write side. The read/write asymmetry recorded under D10 may have been resolved ' +
        'upstream — check whether src/tools/assets.ts still needs to explain it.',
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* C4: a rack's contents are unreachable                                      */
/* -------------------------------------------------------------------------- */

/**
 * Key names that would link a rack storage item back to its cabinet.
 *
 * `rack_storage_role_id` is excluded deliberately: it is documented as a
 * colour-coded *role*, travels beside `rack_storage_role_name`, `_description`
 * and `_hex_color`, and mistaking it for the cabinet link is precisely the error
 * C4 exists to prevent.
 */
const RACK_REFERENCE = /^(?:rack_storage_id|rack_id|storage_id|rack_storage)$/;

const looksLikeRackReference = (key: string): boolean =>
  RACK_REFERENCE.test(key) ||
  (/rack/i.test(key) && key.endsWith('_id') && !key.startsWith('rack_storage_role'));

describe.skipIf(!enabled)('C4: a rack storage item carries no reference to its rack', () => {
  it('no rack link exists on a rack storage item', async (ctx) => {
    const endpoint = endpointFor('/rack_storage_items');
    const response = await probe('/rack_storage_items');

    if (response.status !== 200) {
      skipWith(ctx, `GET /rack_storage_items answered HTTP ${response.status} on this instance.`);
    }

    const items = listOf(response, endpoint).filter(isRecord);
    if (items.length === 0) {
      skipWith(
        ctx,
        'This instance has no rack storage items, so C4 could not be checked. An empty rack ' +
          'inventory is not drift.',
      );
    }

    const keys = Object.keys(items[0]!);
    const references = keys.filter(looksLikeRackReference);

    expect(
      references,
      `C4 (significant finding): a rack storage item on this instance carries ` +
        `[${references.join(', ')}], a reference back to its rack that the captured contract ` +
        'does not document. C4 states that "what is mounted in rack 12?" is unanswerable, and ' +
        'src/tools/racks.ts says so to every caller. If this field is real, that limitation ' +
        'should be lifted: add the filter or the lookup, rewrite C4, and correct the module ' +
        `docstring in src/tools/racks.ts. Observed keys: [${keys.join(', ')}].`,
    ).toEqual([]);

    // The positive half of the same claim: the role id is present and is not it.
    expect(
      keys,
      'C4: a rack storage item no longer carries `rack_storage_role_id`. The tool descriptions ' +
        `in src/tools/racks.ts are written around that field. Observed keys: [${keys.join(', ')}].`,
    ).toContain('rack_storage_role_id');
  });
});

/* -------------------------------------------------------------------------- */
/* 404 ambiguity                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A path no Hudu version routes. Deliberately unlike any real collection name,
 * so a future Hudu release is unlikely to make it meaningful.
 */
const UNROUTED_PATH = '/hudu_mcp_contract_probe_no_such_collection';

/** An id no tenant will have issued. */
const IMPLAUSIBLE_ID = 999_999_999;

/**
 * Reduce a 404 to something comparable, without quoting the tenant.
 *
 * The signature is the status, the body's top-level key names, and whether the
 * two bodies' message strings are equal — never the message text itself.
 */
function notFoundSignature(response: RawResponse): string {
  return `HTTP ${response.status} with body keys [${topLevelKeys(response.body).join(', ')}]`;
}

const messageOf = (response: RawResponse): string | undefined => {
  if (!isRecord(response.body)) return undefined;
  for (const key of ['error', 'message', 'errors']) {
    const value = response.body[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
};

/**
 * Rewritten after the live run. This block previously asserted that
 * `GET /companies/{implausible id}` answers 404 and that a missing record is
 * indistinguishable from an unrouted path — both derived from the contract, and
 * both contradicted on Hudu 2.34.2 (spec-defects.md F3). `/companies/{id}` and
 * `/articles/{id}` answer **HTTP 200 with a body of `null`**; `/networks/{id}`
 * and `/users/{id}` answer 404 with a resource-specific message; and an
 * unrouted path answers 404 with a different body shape again. The old
 * assertions tested the document, so they are replaced rather than kept.
 */
describe.skipIf(!enabled)('F3: "no such record" is not one behaviour', () => {
  it('GET /companies/{missing id} answers 200 with no record, not 404', async () => {
    const missingRecord = await probe(`/companies/${IMPLAUSIBLE_ID}`);

    expect(
      missingRecord.status,
      `F3: GET /companies/${IMPLAUSIBLE_ID} answered HTTP ${missingRecord.status}. On Hudu ` +
        '2.34.2 it answers 200 with an empty body, which is why buildGetTool in ' +
        'src/tools/resource.ts reports `found: false` from a *successful* call rather than ' +
        'relying on the error path. If this endpoint now 404s, that branch is no longer ' +
        'reachable here — check whether any endpoint still answers 200, and if none does, ' +
        `simplify it. ${DRIFT}`,
    ).toBe(200);

    expect(
      unwrapRecord(missingRecord.body, 'company'),
      `F3: GET /companies/${IMPLAUSIBLE_ID} answered 200 and carried a record. Either this ` +
        'tenant really has that id, or a missing company now returns something. ' +
        `Observed ${shapeOf(missingRecord.body)}.`,
    ).toBeUndefined();
  });

  it('an unrouted path answers 404 with a generic body', async () => {
    const unroutedPath = await probe(UNROUTED_PATH);

    expect(
      unroutedPath.status,
      `GET ${UNROUTED_PATH} answered HTTP ${unroutedPath.status} rather than 404. ${DRIFT}`,
    ).toBe(404);

    expect(
      topLevelKeys(unroutedPath.body),
      `F3: an unrouted path answered ${notFoundSignature(unroutedPath)}. It was observed as ` +
        '{"status":404,"error":"Not Found"} on 2.34.2, which is what distinguishes it from a ' +
        'resource-specific "X not found". If the shape has changed, re-check the 404 guidance ' +
        `in src/api/errors.ts. ${DRIFT}`,
    ).toContain('error');
  });

  it('a 404 for a missing record names the resource, unlike an unrouted path', async () => {
    // `/networks/{id}` is the 404 half of F3: it answers `{"error":"Network not
    // found"}` where the unrouted path answers `{"status":404,"error":"Not
    // Found"}`. The two are therefore *distinguishable*, which the previous
    // version of this test asserted they were not.
    const missingNetwork = await probe(`/networks/${IMPLAUSIBLE_ID}`);
    const unroutedPath = await probe(UNROUTED_PATH);

    expect(
      missingNetwork.status,
      `F3: GET /networks/${IMPLAUSIBLE_ID} answered HTTP ${missingNetwork.status} rather than ` +
        `404. ${DRIFT}`,
    ).toBe(404);

    const both = `missing record: ${notFoundSignature(missingNetwork)}; unrouted path: ${notFoundSignature(unroutedPath)}`;

    expect(
      messageOf(missingNetwork) === messageOf(unroutedPath),
      `F3: a missing network and an unrouted path now carry the same message (${both}). They ` +
        'were distinguishable on 2.34.2, and the 404 guidance in src/api/errors.ts tells an ' +
        'operator to read the body to tell them apart. If that no longer works, the guidance ' +
        'has to go back to hedging between both causes.',
    ).toBe(false);
  });
});

describe.skipIf(enabled)('live Hudu contract (skipped)', () => {
  it('is opt-in: set HUDU_CONTRACT_TESTS=1 with real credentials to run it', () => {
    expect(enabled).toBe(false);
  });
});
