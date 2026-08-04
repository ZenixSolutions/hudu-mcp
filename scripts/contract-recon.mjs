#!/usr/bin/env node
/**
 * Read-only reconnaissance of a live Hudu instance.
 *
 * Usage:
 *   HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=... node scripts/contract-recon.mjs
 *
 * Walks every `GET` documented in `docs/reference/api-docs.json` exactly once
 * and writes `docs/reference/contract-observations.md`: the observed status, the
 * observed body shape, the top-level key *names* of the first record, and any
 * response header outside a boring baseline. It also collects the distinct
 * values of the four undocumented enum-like fields that the tool descriptions
 * currently tell callers to discover by reading an existing record —
 * `network_type` (D1), rack item `status` and `side` (D2, B7),
 * `ip_address.status` (D5), and relation `fromable_type`/`toable_type` (D6).
 *
 * This is not a test and nothing runs it automatically. It is the thing you run
 * once against a real tenant to find out where `docs/reference/spec-defects.md`
 * and reality disagree, and its output is meant to be committed and read.
 *
 * ---------------------------------------------------------------------------
 * READ-ONLY
 * ---------------------------------------------------------------------------
 * Every request is a `GET`. There is exactly one function that reaches the
 * network, {@link httpGet}, and it hardcodes the method and takes no method
 * argument. Redirects are not followed, so the API key cannot be sent to a host
 * named by a redirect. Nothing here writes to the instance, and nothing here
 * should ever be extended to.
 *
 * ---------------------------------------------------------------------------
 * REDACTION
 * ---------------------------------------------------------------------------
 * The output file goes into a public repository, and the instance it is
 * generated from is a production MSP tenant holding other people's customer
 * data. The report therefore emits only:
 *
 *   - endpoint paths as they appear in the API specification;
 *   - HTTP status codes;
 *   - structural shape ("bare array", "object wrapping `assets`", ...);
 *   - record *key names*, never record values;
 *   - response header *names*, with values only for a small allowlist of
 *     rate-limit and count headers whose values are numeric;
 *   - enum-like field values, and only where they look like enum members:
 *     numbers, booleans, and short strings of `[A-Za-z0-9_-]`.
 *
 * That last rule is what keeps a company name or a hostname out of the file. A
 * value that does not match is counted and withheld, and the report says how
 * many were withheld so the omission is visible rather than silent.
 *
 * The instance hostname is never written to the file, nor printed. `Location`
 * and `Set-Cookie` are reported as present with their values withheld.
 * `/asset_passwords` is walked like any other collection, and like any other
 * collection only its key names are recorded — which for that endpoint means
 * the strings "password" and "otp_secret" appear as names, and no credential
 * material is read, printed or stored.
 *
 * The credential comes from the environment and is never accepted as an
 * argument, which would put it in shell history.
 */

import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, URL, URLSearchParams } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = join(REPO_ROOT, 'docs', 'reference', 'contract-observations.md');
const OUTPUT_LABEL = relative(REPO_ROOT, OUTPUT_PATH);

const API_PREFIX = '/api/v1';

/** No more than two requests per second, against a live production tenant. */
const MIN_REQUEST_INTERVAL_MS = 500;

/** Per-request timeout. Generous: an unpaginated IPAM range can be very large. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Records asked for on a paginated collection probe. */
const SAMPLE_PAGE_SIZE = 5;

/** Pages walked when harvesting enum values from a paginated collection. */
const ENUM_PAGE_SIZE = 100;
const ENUM_MAX_PAGES = 5;

/** Above this, a field is not an enum and its values are withheld wholesale. */
const MAX_DISTINCT_VALUES = 25;

/* -------------------------------------------------------------------------- */
/* Redaction primitives                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Headers present on essentially every response, or whose value is per-request
 * noise. Dropped entirely — listing them would bury the interesting ones.
 */
const BORING_HEADERS = new Set([
  'accept-ranges',
  'age',
  'alt-svc',
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'content-security-policy',
  'content-security-policy-report-only',
  'content-type',
  'date',
  'etag',
  'expires',
  'keep-alive',
  'pragma',
  'referrer-policy',
  'report-to',
  'server',
  'strict-transport-security',
  'transfer-encoding',
  'vary',
  'x-content-type-options',
  'x-download-options',
  'x-frame-options',
  'x-permitted-cross-domain-policies',
  'x-powered-by',
  'x-request-id',
  'x-runtime',
  'x-xss-protection',
]);

/** Headers reported as present, with the value withheld unconditionally. */
const VALUE_WITHHELD_HEADERS = new Set([
  'authorization',
  'cookie',
  'location',
  'proxy-authenticate',
  'set-cookie',
  'www-authenticate',
  'x-api-key',
]);

/** Headers whose value is worth recording: rate limiting (A8) and counts (C1). */
const VALUE_SAFE_HEADER = /^(?:x-)?rate-?limit-|^retry-after$|^x-total-count$/;

/** A header value safe to print: short, and made of digits and punctuation. */
const SAFE_HEADER_VALUE = /^[A-Za-z0-9 ,;:._-]{1,60}$/;

/** A value that could plausibly be an enum member rather than tenant content. */
const ENUM_SAFE_STRING = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Render a field value for the report, or return null to withhold it.
 *
 * Deliberately conservative. A hostname, an email address, a URL or a company
 * name all contain characters this rejects, so the failure mode is "withheld
 * something harmless" rather than "published something private".
 */
function enumSafeValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'string' && ENUM_SAFE_STRING.test(value)) return value;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const USAGE = `Usage: node scripts/contract-recon.mjs

Reads its configuration from the environment. It takes no arguments; the API key
is deliberately not accepted on the command line, where it would be recorded in
shell history.

  HUDU_BASE_URL   Hudu instance URL, e.g. https://hudu.example.com
  HUDU_API_KEY    An API key from Hudu Admin -> Basic Information -> API Keys

Every request it makes is a GET. It writes ${OUTPUT_LABEL}.`;

if (process.argv.slice(2).some((argument) => argument === '-h' || argument === '--help')) {
  console.log(USAGE);
  process.exit(0);
}

if (process.argv.length > 2) {
  console.error(`::error::contract-recon takes no arguments.\n\n${USAGE}`);
  process.exit(1);
}

/** Strip a trailing slash and a trailing `/api/v1`, matching src/config.ts. */
const normaliseBaseUrl = (raw) =>
  raw
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/v1$/i, '');

const BASE_URL = normaliseBaseUrl(process.env.HUDU_BASE_URL ?? '');
const API_KEY = (process.env.HUDU_API_KEY ?? '').trim();

if (BASE_URL === '' || API_KEY === '') {
  console.error(`::error::HUDU_BASE_URL and HUDU_API_KEY must both be set.\n\n${USAGE}`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* The single network primitive                                               */
/* -------------------------------------------------------------------------- */

let nextRequestAt = 0;

const apiPath = (template, params) =>
  API_PREFIX +
  template.replace(/\{(\w+)\}/g, (_match, key) => encodeURIComponent(String(params[key])));

/**
 * Issue one GET.
 *
 * The method is a literal and there is no parameter that could change it. This
 * is the only function in the file that touches the network.
 */
async function httpGet(template, params = {}, query = {}) {
  const now = Date.now();
  if (nextRequestAt > now) await sleep(nextRequestAt - now);
  nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;

  const url = new URL(BASE_URL + apiPath(template, params));
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await globalThis.fetch(url.toString(), {
      method: 'GET',
      headers: {
        'x-api-key': API_KEY,
        accept: 'application/json',
        'user-agent': 'hudu-mcp-contract-recon (+https://github.com/ZenixSolutions/hudu-mcp)',
      },
      redirect: 'manual',
      signal: globalThis.AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // The message could contain the URL, and the URL contains the hostname.
    return { transportError: error instanceof Error ? error.name : 'unknown error' };
  }

  const text = await response.text().catch(() => '');
  let body;
  let parseFailed = false;
  try {
    body = text.trim() === '' ? undefined : JSON.parse(text);
  } catch {
    parseFailed = true;
  }

  return { status: response.status, headers: response.headers, body, parseFailed };
}

/** Cache keyed on path and query only, so no hostname enters the key. */
const cache = new Map();

function get(template, params = {}, query = {}) {
  const key = `${apiPath(template, params)}?${new URLSearchParams(
    Object.entries(query).map(([name, value]) => [name, String(value)]),
  ).toString()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = httpGet(template, params, query);
  cache.set(key, pending);
  return pending;
}

/* -------------------------------------------------------------------------- */
/* Shape observation                                                          */
/* -------------------------------------------------------------------------- */

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Work out what a body is, without assuming what it ought to be.
 *
 * Returns the structural description, the records found, and the envelope key
 * used to find them. The point of the exercise is to compare this against what
 * `src/tools/*.ts` declares, so nothing here is allowed to presume the answer.
 */
function observeShape(body) {
  if (body === undefined) return { shape: 'empty body', records: [], envelopeKey: null };
  if (body === null) return { shape: 'JSON null', records: [], envelopeKey: null };

  if (Array.isArray(body)) {
    return {
      shape: `bare array (${plural(body.length, 'record')})`,
      records: body,
      envelopeKey: null,
    };
  }

  if (isRecord(body)) {
    const keys = Object.keys(body);
    const arrayKeys = keys.filter((key) => Array.isArray(body[key]));

    if (arrayKeys.length === 1) {
      const key = arrayKeys[0];
      return {
        shape: `object wrapping an array under \`${key}\` (${plural(body[key].length, 'record')})`,
        records: body[key],
        envelopeKey: key,
      };
    }
    if (arrayKeys.length > 1) {
      return {
        shape: `object wrapping ${arrayKeys.length} arrays, under \`${arrayKeys.join('`, `')}\``,
        records: [],
        envelopeKey: null,
      };
    }
    if (keys.length === 0) return { shape: 'empty object', records: [], envelopeKey: null };

    // A lone key holding an object is the single-record envelope that
    // `unwrapRecord` takes a `recordKey` for. Reporting the wrapper name and the
    // inner keys is what makes the `recordKey` on a ResourceSpec checkable.
    if (keys.length === 1 && isRecord(body[keys[0]])) {
      return {
        shape: `object wrapping a single record under \`${keys[0]}\``,
        records: [body[keys[0]]],
        envelopeKey: keys[0],
      };
    }

    return { shape: 'single object', records: [body], envelopeKey: null };
  }

  return { shape: `bare ${typeof body}`, records: [], envelopeKey: null };
}

/** Key names of the first record, sorted. Names only — never values. */
function firstRecordKeys(records) {
  const first = records.find(isRecord);
  return first === undefined ? null : Object.keys(first).sort();
}

/** Header names outside the baseline, with values only where the allowlist permits. */
function interestingHeaders(headers) {
  if (headers === undefined) return [];
  const output = [];

  for (const rawName of headers.keys()) {
    const name = rawName.toLowerCase();
    if (BORING_HEADERS.has(name)) continue;

    if (VALUE_WITHHELD_HEADERS.has(name)) {
      output.push(`\`${name}\` (present; value withheld)`);
      continue;
    }

    if (VALUE_SAFE_HEADER.test(name)) {
      const value = headers.get(rawName) ?? '';
      output.push(
        SAFE_HEADER_VALUE.test(value)
          ? `\`${name}: ${value}\``
          : `\`${name}\` (present; value not in a safe-to-print form)`,
      );
      continue;
    }

    output.push(`\`${name}\``);
  }

  return output.sort();
}

/* -------------------------------------------------------------------------- */
/* The endpoints                                                              */
/* -------------------------------------------------------------------------- */

const PAGED = { page: 1, page_size: SAMPLE_PAGE_SIZE };

/**
 * Every `GET` in the captured contract, in probe order.
 *
 * `stores` names the slot the first record's `id` is remembered in; `params`
 * maps a path placeholder to a slot filled by an earlier probe. An endpoint
 * whose slots are still empty when its turn comes is reported as not probed
 * rather than guessed at — Article IV applies to reconnaissance too.
 *
 * `note` is copied into the report for the endpoints whose observation needs a
 * caveat to be read correctly.
 */
const ENDPOINTS = [
  { path: '/api_info', kind: 'singleton' },

  { path: '/companies', kind: 'collection', query: PAGED, stores: 'company' },
  { path: '/companies/{id}', kind: 'item', params: { id: 'company' } },
  {
    path: '/companies/{company_id}/assets',
    kind: 'collection',
    params: { company_id: 'company' },
    query: PAGED,
    stores: 'company_asset',
  },
  {
    path: '/companies/{company_id}/assets/{id}',
    kind: 'item',
    params: { company_id: 'company', id: 'company_asset' },
  },

  { path: '/assets', kind: 'collection', query: PAGED, stores: 'asset' },
  { path: '/asset_layouts', kind: 'collection', query: { page: 1 }, stores: 'asset_layout' },
  { path: '/asset_layouts/{id}', kind: 'item', params: { id: 'asset_layout' } },

  {
    path: '/asset_passwords',
    kind: 'collection',
    query: { page: 1, page_size: 1 },
    stores: 'asset_password',
    note:
      'Probed with `page_size=1`. Key names only are recorded; no value from a password record ' +
      'is read, stored or printed. A7 predicts this may answer 401 or 404 rather than 403 for a ' +
      'key created without password access.',
  },
  { path: '/asset_passwords/{id}', kind: 'item', params: { id: 'asset_password' } },

  { path: '/password_folders', kind: 'collection', query: PAGED, stores: 'password_folder' },
  { path: '/password_folders/{id}', kind: 'item', params: { id: 'password_folder' } },

  { path: '/articles', kind: 'collection', query: PAGED, stores: 'article' },
  { path: '/articles/{id}', kind: 'item', params: { id: 'article' } },
  { path: '/folders', kind: 'collection', query: PAGED, stores: 'folder' },
  { path: '/folders/{id}', kind: 'item', params: { id: 'folder' } },
  { path: '/procedures', kind: 'collection', query: PAGED, stores: 'procedure' },
  { path: '/procedures/{id}', kind: 'item', params: { id: 'procedure' } },

  { path: '/websites', kind: 'collection', query: PAGED, stores: 'website' },
  { path: '/websites/{id}', kind: 'item', params: { id: 'website' } },
  { path: '/relations', kind: 'collection', query: PAGED },
  { path: '/magic_dash', kind: 'collection', query: PAGED },
  { path: '/matchers', kind: 'collection', query: PAGED },

  { path: '/networks', kind: 'collection', stores: 'network', note: 'Unpaginated (C2).' },
  { path: '/networks/{id}', kind: 'item', params: { id: 'network' } },
  { path: '/ip_addresses', kind: 'collection', stores: 'ip_address', note: 'Unpaginated (C2).' },
  { path: '/ip_addresses/{id}', kind: 'item', params: { id: 'ip_address' } },

  { path: '/rack_storages', kind: 'collection', stores: 'rack_storage', note: 'Unpaginated (C2).' },
  { path: '/rack_storages/{id}', kind: 'item', params: { id: 'rack_storage' } },
  {
    path: '/rack_storage_items',
    kind: 'collection',
    stores: 'rack_storage_item',
    note:
      'Unpaginated (C2). The key list here is the evidence for C4: if no key links an item back ' +
      'to its cabinet, "what is mounted in rack 12?" stays unanswerable.',
  },
  { path: '/rack_storage_items/{id}', kind: 'item', params: { id: 'rack_storage_item' } },

  { path: '/users', kind: 'collection', query: PAGED, stores: 'user' },
  { path: '/users/{id}', kind: 'item', params: { id: 'user' } },
  { path: '/activity_logs', kind: 'collection', query: PAGED },
  { path: '/expirations', kind: 'collection', query: PAGED },
  { path: '/uploads', kind: 'collection', stores: 'upload', note: 'Unpaginated (C2).' },
  { path: '/uploads/{id}', kind: 'item', params: { id: 'upload' } },
  { path: '/public_photos', kind: 'collection', query: PAGED },

  {
    path: '/cards/lookup',
    kind: 'lookup',
    note:
      'Probed with no parameters, because the integration slug and identifier it needs cannot be ' +
      'invented. The observation below describes the missing-parameter path only, not a ' +
      'successful lookup.',
  },
  {
    path: '/companies/jump',
    kind: 'lookup',
    note: 'Probed with no parameters; see the note on `/cards/lookup`.',
  },
  {
    path: '/cards/jump',
    kind: 'lookup',
    note:
      'Probed with no parameters, and with redirects not followed. A5: this endpoint is ' +
      'documented as working without API key authentication, which is why it is not implemented ' +
      'by this server (E2).',
  },
];

/* -------------------------------------------------------------------------- */
/* Undocumented fields the tool descriptions currently punt on                */
/* -------------------------------------------------------------------------- */

const ENUM_TARGETS = [
  {
    item: 'D1',
    label: '`network_type` on a network',
    path: '/networks',
    field: 'network_type',
    documented: 'Documented only as "an integer", with no mapping published.',
  },
  {
    item: 'D2',
    label: '`status` on a rack storage item',
    path: '/rack_storage_items',
    field: 'status',
    documented: 'Documented as an integer with no meanings published.',
  },
  {
    item: 'B7',
    label: '`side` on a rack storage item',
    path: '/rack_storage_items',
    field: 'side',
    documented:
      'Typed as a string ("Front or Rear") as a query filter and as an integer in the body ' +
      'schema, with no mapping given for the integer.',
  },
  {
    item: 'D5',
    label: '`status` on an IP address',
    path: '/ip_addresses',
    field: 'status',
    documented:
      'Legal values appear only in prose — "unassigned, assigned, reserved, deprecated, dhcp, ' +
      'or slaac" — in the property description, not as a schema `enum`.',
  },
  {
    item: 'D6',
    label: '`fromable_type` on a relation',
    path: '/relations',
    field: 'fromable_type',
    paginated: true,
    documented:
      'Values appear only in a parenthetical (Asset, Website, Procedure, AssetPassword, ' +
      'Company, Article), not as a schema `enum`, so the list may not be exhaustive.',
  },
  {
    item: 'D6',
    label: '`toable_type` on a relation',
    path: '/relations',
    field: 'toable_type',
    paginated: true,
    documented: 'As `fromable_type`.',
  },
];

/**
 * Collect every record of a collection that the enum harvest needs.
 *
 * Unpaginated collections come back whole in one response, which the endpoint
 * walk has already fetched and cached. Paginated ones are walked until a short
 * page or {@link ENUM_MAX_PAGES}, so a large tenant costs a bounded number of
 * requests rather than an unbounded one.
 */
async function collectRecords(target) {
  if (target.paginated !== true) {
    const response = await get(target.path);
    if (response.status !== 200) return { records: [], pages: 0, status: response.status };
    return { records: observeShape(response.body).records, pages: 1, status: 200 };
  }

  const records = [];
  let pages = 0;
  let status = null;

  for (let page = 1; page <= ENUM_MAX_PAGES; page += 1) {
    const response = await get(target.path, {}, { page, page_size: ENUM_PAGE_SIZE });
    status ??= response.status;
    if (response.status !== 200) break;

    const found = observeShape(response.body).records;
    pages += 1;
    records.push(...found);
    if (found.length < ENUM_PAGE_SIZE) break;
  }

  return { records, pages, status };
}

/** Distinct enum-safe values of one field, with everything else counted out. */
function harvest(records, field) {
  const values = new Set();
  let present = 0;
  let withheld = 0;
  let nullish = 0;

  for (const record of records) {
    if (!isRecord(record) || !(field in record)) continue;
    present += 1;

    const raw = record[field];
    if (raw === null || raw === undefined) {
      nullish += 1;
      continue;
    }

    const safe = enumSafeValue(raw);
    if (safe === null) withheld += 1;
    else values.add(safe);
  }

  return { values: [...values].sort(), present, withheld, nullish, examined: records.length };
}

/* -------------------------------------------------------------------------- */
/* The walk                                                                   */
/* -------------------------------------------------------------------------- */

const discovered = new Map();

/** Fill an endpoint's path placeholders, or return null if an id is missing. */
function resolveParams(endpoint) {
  const params = {};
  for (const [placeholder, slot] of Object.entries(endpoint.params ?? {})) {
    const value = discovered.get(slot);
    if (value === undefined) return null;
    params[placeholder] = value;
  }
  return params;
}

async function walkEndpoints() {
  const observations = [];

  for (const endpoint of ENDPOINTS) {
    const params = resolveParams(endpoint);

    if (params === null) {
      observations.push({
        path: endpoint.path,
        kind: endpoint.kind,
        note: endpoint.note,
        skipped:
          'Not probed: no record id was available from the parent collection, which on this ' +
          'instance was empty or unreadable.',
      });
      console.error(`  skip  ${endpoint.path} (no id available)`);
      continue;
    }

    const response = await get(endpoint.path, params, endpoint.query ?? {});

    if (response.transportError !== undefined) {
      observations.push({
        path: endpoint.path,
        kind: endpoint.kind,
        note: endpoint.note,
        skipped: `Not probed: the request failed at the transport (${response.transportError}).`,
      });
      console.error(`  fail  ${endpoint.path} (${response.transportError})`);
      continue;
    }

    const observed = observeShape(response.body);
    const keys = firstRecordKeys(observed.records);

    if (endpoint.stores !== undefined && !discovered.has(endpoint.stores)) {
      const first = observed.records.find(isRecord);
      const id = first?.id;
      if (typeof id === 'number' || (typeof id === 'string' && id !== '')) {
        // Held in memory to address the item endpoints. Never written out.
        discovered.set(endpoint.stores, id);
      }
    }

    observations.push({
      path: endpoint.path,
      kind: endpoint.kind,
      note: endpoint.note,
      status: response.status,
      shape: response.parseFailed ? 'response body was not JSON' : observed.shape,
      envelopeKey: observed.envelopeKey,
      keys,
      headers: interestingHeaders(response.headers),
      query: Object.keys(endpoint.query ?? {}),
    });

    console.error(`  ${String(response.status).padStart(4)}  ${endpoint.path}`);
  }

  return observations;
}

async function walkEnums() {
  const results = [];

  for (const target of ENUM_TARGETS) {
    const { records, pages, status } = await collectRecords(target);
    results.push({ ...target, ...harvest(records, target.field), pages, status });
    console.error(`  enum  ${target.path}.${target.field} (${records.length} records)`);
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* The report                                                                 */
/* -------------------------------------------------------------------------- */

const code = (values) => values.map((value) => `\`${value}\``).join(', ');

function renderObservation(observation) {
  const lines = [`### GET ${observation.path}`, ''];

  if (observation.note !== undefined) lines.push(observation.note, '');

  if (observation.skipped !== undefined) {
    lines.push(observation.skipped, '');
    return lines;
  }

  lines.push(`- **Status:** ${observation.status}`);
  lines.push(`- **Body shape:** ${observation.shape}`);
  if (observation.envelopeKey !== null) {
    lines.push(`- **Envelope key:** \`${observation.envelopeKey}\``);
  }
  if (observation.query.length > 0) {
    lines.push(`- **Query sent:** ${code(observation.query)}`);
  }
  lines.push(
    observation.keys === null
      ? '- **First record keys:** no record was returned, so no keys were observed'
      : `- **First record keys:** ${code(observation.keys)}`,
  );
  lines.push(
    observation.headers.length === 0
      ? '- **Headers beyond the baseline:** none'
      : `- **Headers beyond the baseline:** ${observation.headers.join(', ')}`,
  );
  lines.push('');

  return lines;
}

function renderEnum(result) {
  const lines = [`### ${result.label} (${result.item})`, ''];
  lines.push(`Contract says: ${result.documented}`, '');

  if (result.status !== 200) {
    lines.push(
      `Not observed: \`GET ${result.path}\` answered ${result.status ?? 'nothing'} on this ` +
        'instance.',
      '',
    );
    return lines;
  }

  lines.push(`- **Records examined:** ${result.examined} (from \`GET ${result.path}\`)`);
  lines.push(`- **Records carrying the field:** ${result.present}`);
  lines.push(`- **Records where it was null:** ${result.nullish}`);

  if (result.present === 0) {
    lines.push('- **Distinct values:** none — no record on this instance carries the field', '');
    return lines;
  }

  if (result.values.length > MAX_DISTINCT_VALUES) {
    lines.push(
      `- **Distinct values:** ${result.values.length}, which is more than the ` +
        `${MAX_DISTINCT_VALUES} this report will print. A field with that many distinct values ` +
        'is not an enum, so the values are withheld rather than published.',
      '',
    );
    return lines;
  }

  lines.push(
    result.values.length === 0
      ? '- **Distinct values:** none in a form safe to publish'
      : `- **Distinct values (${result.values.length}):** ${code(result.values)}`,
  );
  if (result.withheld > 0) {
    lines.push(
      `- **Withheld:** ${result.withheld} value(s) did not look enum-like and were not ` +
        'published. If that count is high, the field is free text rather than an enum.',
    );
  }
  lines.push('');

  return lines;
}

function renderReport(observations, enums) {
  const probed = observations.filter((observation) => observation.skipped === undefined);
  const statuses = new Map();
  for (const observation of probed) {
    statuses.set(observation.status, (statuses.get(observation.status) ?? 0) + 1);
  }

  const lines = [
    '# Observed behaviour of a live Hudu instance',
    '',
    'Generated by `scripts/contract-recon.mjs`, which walks every `GET` in',
    '`docs/reference/api-docs.json` once and records what came back. It is not run',
    'automatically and it is not a test: it is the evidence for the claims in',
    '`docs/reference/spec-defects.md` that could only be settled against a running',
    'instance.',
    '',
    `Generated: ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## What is and is not in this file',
    '',
    'Every request behind this report was a `GET`. Nothing was created, changed or',
    'deleted, and the script has no code path that could.',
    '',
    'The instance this was generated from is a production tenant holding real',
    'customer data, so the report carries **shapes and names only**: endpoint paths,',
    'status codes, structural shape, record *key names*, response header *names*,',
    'and — for a handful of undocumented fields — values that look like enum members',
    'and nothing else. No record value, company name, person, hostname or URL from',
    'the tenant appears anywhere below, and no value from a password record is read',
    'at all. Where a value was withheld, the count of withheld values is given, so',
    'an omission is visible rather than silent.',
    '',
    'Observations are about **this instance**. Per CLAUDE.md invariant 6, behaviour',
    'seen here is evidence about one deployment, not a documented API guarantee, and',
    'it does not by itself justify a new tool, argument or documented behaviour.',
    '',
    '## Summary',
    '',
    `- Endpoints in the walk: ${observations.length}`,
    `- Probed: ${probed.length}`,
    `- Not probed (no id available, or transport failure): ${observations.length - probed.length}`,
    ...[...statuses.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([status, count]) => `- HTTP ${status}: ${count} endpoint(s)`),
    '',
    '## Endpoints',
    '',
  ];

  for (const observation of observations) lines.push(...renderObservation(observation));

  lines.push(
    '## Undocumented field values',
    '',
    'These are the fields whose legal values the contract does not publish, and',
    'which the tool descriptions in `src/tools/` currently tell a caller to discover',
    'by reading an existing record. What follows is that reading, done once.',
    '',
    'Treat these as observations, not as an enum definition: an absent value here',
    'means only that no record on this instance used it.',
    '',
  );

  for (const result of enums) lines.push(...renderEnum(result));

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/* -------------------------------------------------------------------------- */

async function main() {
  console.error('contract-recon: walking every documented GET, at most 2 requests/second.');
  console.error('Nothing below issues a POST, PUT, PATCH or DELETE.\n');

  const observations = await walkEndpoints();
  console.error('');
  const enums = await walkEnums();

  writeFileSync(OUTPUT_PATH, renderReport(observations, enums), 'utf8');

  const probed = observations.filter((observation) => observation.skipped === undefined);
  const failures = probed.filter((observation) => observation.status >= 400);
  const withHeaders = probed.filter((observation) => observation.headers.length > 0);
  const wrapped = probed.filter(
    (observation) => observation.envelopeKey !== null && observation.kind === 'collection',
  );
  const wrappedRecords = probed.filter(
    (observation) => observation.envelopeKey !== null && observation.kind !== 'collection',
  );

  console.error('\n--- summary -------------------------------------------------');
  console.error(`Endpoints walked:            ${observations.length}`);
  console.error(`Probed:                      ${probed.length}`);
  console.error(`Not probed:                  ${observations.length - probed.length}`);
  console.error(`Answered 4xx or 5xx:         ${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  ${failure.status}  ${failure.path}`);
  }
  // The two lists to check against the `listKey` and `recordKey` on every
  // ResourceSpec in src/tools/. A disagreement here is the silent-empty-list
  // failure the contract tests exist to catch.
  console.error(`List endpoints with an envelope:   ${wrapped.length}`);
  for (const item of wrapped) console.error(`  listKey   ${item.path} -> ${item.envelopeKey}`);
  console.error(`Single records with an envelope:   ${wrappedRecords.length}`);
  for (const item of wrappedRecords) {
    console.error(`  recordKey ${item.path} -> ${item.envelopeKey}`);
  }
  console.error(`Non-baseline headers seen:   ${withHeaders.length} endpoint(s)`);
  for (const result of enums) {
    const summary =
      result.values.length > MAX_DISTINCT_VALUES
        ? `${result.values.length} distinct (withheld)`
        : result.values.join(', ') || 'none observed';
    console.error(`  ${result.item} ${result.path}.${result.field}: ${summary}`);
  }
  console.error(`\nWrote ${OUTPUT_LABEL}`);
  console.error('Read it before committing it: the redaction rules are conservative, but the');
  console.error('file is going into a public repository and a human should confirm that.');
}

await main();
