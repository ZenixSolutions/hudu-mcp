/**
 * The two timeline composites, driven end to end through `executeTool`.
 *
 * These run the same path the SDK callback does — handler, secret stripping,
 * notice, serialisation — because the properties under test are properties of
 * what a model actually receives, not of what the handler happened to return.
 *
 * What is being defended here:
 *
 * 1. `viewed` events are noise by default and history on request.
 * 2. A field-level diff exists only where two snapshots exist, is labelled as
 *    derived, and says so plainly when there is no predecessor to compare with.
 * 3. A `details` snapshot never reaches the output as text, and a field whose
 *    name looks like credential material never reaches it with a value. This is
 *    the one control the central stripper cannot provide: `details` is a JSON
 *    *string*, so `stripSecrets` has no keys to walk.
 * 4. An empty result over an incomplete walk is never reported as an empty
 *    window. "Nothing expires in the next 30 days" is how a certificate lapses.
 * 5. The expiry window is inclusive at both ends and applied client-side,
 *    because `GET /expirations` has no date filter to apply it with.
 */

import { describe, expect, it } from 'vitest';

import { HuduClient } from '../../src/api/client.js';
import { executeTool, type McpToolResponse, prepareTool } from '../../src/tools/define.js';
import { timelineTools } from '../../src/workflows/timeline.js';
import { fakeClock, testConfig, toolText } from '../helpers/fixtures.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** A canned collection, answered by API path rather than by call order. */
type Route = (query: URLSearchParams) => unknown;

interface RecordedCall {
  readonly path: string;
  readonly query: URLSearchParams;
}

/**
 * Route by path, not by sequence.
 *
 * Both tools fan out concurrently once their first walk is done, so a
 * script replayed in call order would encode an ordering neither tool
 * promises. Routing makes the fixtures say what they mean.
 */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  routes: Record<string, Route>,
): Promise<{
  response: McpToolResponse;
  data: Record<string, unknown>;
  text: string;
  calls: RecordedCall[];
}> {
  const config = testConfig();
  const calls: RecordedCall[] = [];

  const fetchImpl: typeof globalThis.fetch = (input) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const path = url.pathname.replace('/api/v1', '');
    calls.push({ path, query: url.searchParams });
    const route = routes[path];
    const body = route === undefined ? [] : route(url.searchParams);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  const client = new HuduClient(config, { fetch: fetchImpl, clock: fakeClock() });
  const definition = timelineTools().find((tool) => tool.name === name);
  if (!definition) throw new Error(`${name} is not exported by timelineTools()`);

  const response = await executeTool(prepareTool(definition), args, { client, config });
  return {
    response,
    data: response.structuredContent ?? {},
    text: toolText(response),
    calls,
  };
}

const asRecord = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const asArray = (value: unknown): Record<string, unknown>[] => value as Record<string, unknown>[];

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const TODAY = new Date().toISOString().slice(0, 10);
const day = (offset: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const COMPANIES = [
  { id: 1, name: 'Acme Ltd' },
  { id: 2, name: 'Globex' },
];

const expiration = (
  id: number,
  date: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  date,
  company_id: 1,
  expiration_type: 'ssl_certificate',
  expirationable_type: 'Website',
  expirationable_id: 100 + id,
  ...overrides,
});

const logEntry = (
  id: number,
  action: string,
  createdAt: string,
  details: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  action,
  created_at: createdAt,
  user_id: 5,
  user_email: 'tech@example.test',
  record_type: 'Asset',
  record_id: 42,
  details,
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* hudu_recent_changes: reads are not changes                                  */
/* -------------------------------------------------------------------------- */

describe('hudu_recent_changes drops reads by default', () => {
  const routes: Record<string, Route> = {
    '/activity_logs': () => [
      logEntry(1, 'updated', '2026-07-01T10:00:00Z', JSON.stringify({ name: 'Old' })),
      logEntry(2, 'viewed', '2026-07-30T10:00:00Z', null),
    ],
  };

  it('excludes `viewed` entries and says how many it dropped', async () => {
    const { data } = await runTool('hudu_recent_changes', {}, routes);
    const changes = asArray(data['changes']);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.['action']).toBe('updated');
    expect(asRecord(data['counts'])['viewed_dropped']).toBe(1);
    expect(asRecord(data['counts'])['changes']).toBe(1);
  });

  it('includes them when the caller asks, without ever making one a diff baseline', async () => {
    const { data } = await runTool('hudu_recent_changes', { include_viewed: true }, routes);
    const changes = asArray(data['changes']);

    expect(changes.map((entry) => entry['action'])).toEqual(['viewed', 'updated']);
    expect(asRecord(data['counts'])['viewed_dropped']).toBe(0);
    // The change count is changes, not entries: a read did not change anything.
    expect(asRecord(data['counts'])['changes']).toBe(1);

    const viewed = changes.find((entry) => entry['action'] === 'viewed');
    expect(asRecord(viewed?.['what_changed'])['basis']).toBe('none');
  });

  it('sends the lookback to Hudu as start_date rather than filtering it here', async () => {
    const { calls } = await runTool('hudu_recent_changes', { days: 3 }, routes);
    expect(calls[0]?.query.get('start_date')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses a resource filter with only half of the pair', async () => {
    const { response, text } = await runTool('hudu_recent_changes', { resource_id: 42 }, routes);

    expect(response.isError).toBe(true);
    expect(text).toMatch(/must be supplied together/i);
    // The failure mode this guards is silence, so the message has to name it.
    expect(text).toMatch(/unfiltered log/i);
  });
});

/* -------------------------------------------------------------------------- */
/* hudu_recent_changes: the derived diff                                       */
/* -------------------------------------------------------------------------- */

describe('hudu_recent_changes derives a diff from two snapshots', () => {
  const routes: Record<string, Route> = {
    '/activity_logs': () => [
      logEntry(
        1,
        'updated',
        '2026-07-01T10:00:00Z',
        JSON.stringify({ id: 42, name: 'Old name', notes: 'same', location: 'Rack 1' }),
      ),
      logEntry(
        2,
        'updated',
        '2026-07-02T10:00:00Z',
        JSON.stringify({ id: 42, name: 'New name', notes: 'same', location: 'Rack 2' }),
      ),
    ],
  };

  it('reports exactly the fields whose values differ', async () => {
    const { data } = await runTool('hudu_recent_changes', {}, routes);
    const newest = asArray(data['changes'])[0];
    const changed = asRecord(newest?.['what_changed']);

    expect(newest?.['logged_at']).toBe('2026-07-02T10:00:00Z');
    expect(changed['basis']).toBe('derived diff');

    const fields = asArray(changed['fields']);
    expect(fields.map((field) => field['field']).sort()).toEqual(['location', 'name']);
    expect(fields.find((field) => field['field'] === 'name')).toMatchObject({
      from: 'Old name',
      to: 'New name',
    });
    expect(asRecord(changed['compared_against'])['logged_at']).toBe('2026-07-01T10:00:00Z');
  });

  it('labels the diff as computed here rather than reported by Hudu', async () => {
    const { data, text } = await runTool('hudu_recent_changes', {}, routes);
    const changed = asRecord(asArray(data['changes'])[0]?.['what_changed']);

    expect(String(changed['note'])).toMatch(/derived by this server/i);
    expect(text).toMatch(/no before\/after/i);
    expect(asRecord(data['counts'])['entries_with_derived_diff']).toBe(1);
  });

  it('says outright that the earliest change in the window cannot be diffed', async () => {
    const { data } = await runTool('hudu_recent_changes', {}, routes);
    const oldest = asArray(data['changes'])[1];
    const changed = asRecord(oldest?.['what_changed']);

    expect(oldest?.['logged_at']).toBe('2026-07-01T10:00:00Z');
    expect(changed['basis']).toBe('none');
    expect(changed['fields']).toBeUndefined();
    expect(String(changed['note'])).toMatch(/earliest change/i);
    expect(String(changed['note'])).toMatch(/outside the window/i);
  });

  it('degrades to "not diffable" instead of throwing on an unparseable snapshot', async () => {
    const { response, data } = await runTool(
      'hudu_recent_changes',
      {},
      {
        '/activity_logs': () => [
          logEntry(1, 'updated', '2026-07-01T10:00:00Z', JSON.stringify({ name: 'Old' })),
          logEntry(2, 'updated', '2026-07-02T10:00:00Z', '{not json at all'),
        ],
      },
    );

    expect(response.isError).toBeUndefined();
    const changed = asRecord(asArray(data['changes'])[0]?.['what_changed']);
    expect(changed['basis']).toBe('none');
    expect(String(changed['note'])).toMatch(/not diffable/i);
  });
});

/* -------------------------------------------------------------------------- */
/* hudu_recent_changes: details is a string, and the stripper cannot walk it   */
/* -------------------------------------------------------------------------- */

describe('a details snapshot never carries credential material into the output', () => {
  const CANARY_ENCRYPTED = 'ENCRYPTED-CANARY-DO-NOT-LEAK';
  const CANARY_PASSWORD = 'PlainCanaryPassw0rd';
  const CANARY_NESTED = 'NESTED-CANARY-DO-NOT-LEAK';

  const snapshot = (suffix: string): string =>
    JSON.stringify({
      id: 42,
      name: `Firewall ${suffix}`,
      // The key the reviewer observed in this schema. It is not in
      // SECRET_FIELDS, and it would not be reachable by a key-based stripper
      // anyway while `details` is a string.
      encrypted_password_value: `${CANARY_ENCRYPTED}-${suffix}`,
      password: `${CANARY_PASSWORD}-${suffix}`,
      config: { api_token: `${CANARY_NESTED}-${suffix}` },
    });

  const routes: Record<string, Route> = {
    '/activity_logs': () => [
      logEntry(1, 'updated', '2026-07-01T10:00:00Z', snapshot('one')),
      logEntry(2, 'updated', '2026-07-02T10:00:00Z', snapshot('two')),
    ],
  };

  it('reports the credential-shaped fields as changed and withholds both values', async () => {
    const { data } = await runTool('hudu_recent_changes', {}, routes);
    const fields = asArray(asRecord(asArray(data['changes'])[0]?.['what_changed'])['fields']);

    for (const name of ['encrypted_password_value', 'password']) {
      const field = fields.find((candidate) => candidate['field'] === name);
      expect(field, `${name} changed and must be reported`).toBeDefined();
      expect(field?.['value_omitted']).toBe(true);
      expect(field?.['from']).toBeUndefined();
      expect(field?.['to']).toBeUndefined();
    }

    // The ordinary field still comes through, or the tool would be useless.
    expect(fields.find((field) => field['field'] === 'name')).toMatchObject({
      from: 'Firewall one',
      to: 'Firewall two',
    });
  });

  it('lets no canary value reach the model-visible text, at any nesting depth', async () => {
    const { text } = await runTool('hudu_recent_changes', {}, routes);

    expect(text).not.toContain(CANARY_ENCRYPTED);
    expect(text).not.toContain(CANARY_PASSWORD);
    expect(text).not.toContain(CANARY_NESTED);
  });

  it('never re-serialises the raw details blob into the result', async () => {
    const { text, data } = await runTool('hudu_recent_changes', {}, routes);

    expect(text).not.toContain('encrypted_password_value\\"'); // an escaped JSON string
    expect(JSON.stringify(data)).not.toContain('\\"id\\":42');
    for (const entry of asArray(data['changes'])) {
      expect(entry['details']).toBeUndefined();
    }
    expect(String(data['details_handling'])).toMatch(/never returned/i);
  });
});

/* -------------------------------------------------------------------------- */
/* hudu_expiring_soon: an empty filtered result is not an empty window         */
/* -------------------------------------------------------------------------- */

describe('hudu_expiring_soon will not call an incomplete walk a quiet window', () => {
  /** Ten full pages, every date far outside the window: nothing matches. */
  const fullPages: Record<string, Route> = {
    '/expirations': () =>
      Array.from({ length: 100 }, (_unused, index) => expiration(index + 1, day(400))),
    '/companies': () => COMPANIES,
  };

  it('says the walk stopped early and that this is not evidence of nothing', async () => {
    const { data, text } = await runTool('hudu_expiring_soon', { days: 30 }, fullPages);

    expect(asRecord(data['counts'])['in_window']).toBe(0);
    expect(asRecord(asRecord(data['completeness'])['expirations'])['complete']).toBe(false);

    const summary = String(data['summary']);
    expect(summary).not.toMatch(/^Nothing expires/);
    expect(summary).toMatch(/NOT evidence/);
    expect(summary).toMatch(/stopped at its page cap/);

    // The warning must be in the text a model reads, not only in a nested field.
    expect(text).toMatch(/lower bound/i);
  });

  it('says the window is genuinely empty when the walk did reach the end', async () => {
    const { data } = await runTool(
      'hudu_expiring_soon',
      { days: 30 },
      { '/expirations': () => [expiration(1, day(400))], '/companies': () => COMPANIES },
    );

    const summary = String(data['summary']);
    expect(asRecord(asRecord(data['completeness'])['expirations'])['complete']).toBe(true);
    expect(summary).toMatch(/^Nothing expires/);
    expect(summary).not.toMatch(/NOT evidence/);
  });

  it('reports counts as lower bounds when the walk was capped', async () => {
    const { data } = await runTool(
      'hudu_expiring_soon',
      { days: 30 },
      {
        '/expirations': () =>
          Array.from({ length: 100 }, (_unused, index) => expiration(index + 1, day(5))),
        '/companies': () => COMPANIES,
      },
    );

    const walk = asRecord(asRecord(data['completeness'])['expirations']);
    expect(walk['complete']).toBe(false);
    expect(String(walk['reads_as'])).toMatch(/^at least /);
    expect(String(data['summary'])).toMatch(/LOWER BOUNDS/);
  });
});

/* -------------------------------------------------------------------------- */
/* hudu_expiring_soon: the window                                              */
/* -------------------------------------------------------------------------- */

describe('hudu_expiring_soon applies an inclusive window client-side', () => {
  const routes: Record<string, Route> = {
    '/expirations': () => [
      expiration(1, day(30)), // last day of a 30-day window: inside
      expiration(2, day(31)), // one day past it: outside
      expiration(3, TODAY), // first day: inside, and not "already expired"
      expiration(4, day(-1)), // yesterday: already expired
      expiration(5, 'whenever'), // unreadable: neither in nor out
    ],
    '/companies': () => COMPANIES,
    '/websites': () => [
      { id: 101, name: 'acme.example' },
      { id: 103, name: 'today.example' },
      { id: 104, name: 'lapsed.example' },
    ],
  };

  it('sends no date parameter, because the endpoint has none', async () => {
    const { calls, data } = await runTool('hudu_expiring_soon', { days: 30 }, routes);
    const expirationCall = calls.find((call) => call.path === '/expirations');

    for (const parameter of ['start_date', 'end_date', 'date', 'days']) {
      expect(expirationCall?.query.get(parameter)).toBeNull();
    }
    expect(asRecord(data['window'])['filtered_client_side']).toBe(true);
  });

  it('keeps the last day of the window and drops the day after it', async () => {
    const { data } = await runTool('hudu_expiring_soon', { days: 30 }, routes);
    const group = asArray(data['companies'])[0];
    const upcoming = asArray(group?.['upcoming']);

    expect(upcoming.map((entry) => entry['date'])).toEqual([TODAY, day(30)]);
    expect(asRecord(data['counts'])['outside_window']).toBe(1);
    expect(asRecord(data['window'])['boundaries_inclusive']).toBe(true);
  });

  it('separates what has already lapsed from what is still due', async () => {
    const { data } = await runTool('hudu_expiring_soon', { days: 30 }, routes);
    const group = asArray(data['companies'])[0];

    expect(asArray(group?.['already_expired']).map((entry) => entry['date'])).toEqual([day(-1)]);
    expect(asRecord(data['counts'])['already_expired']).toBe(1);
    expect(asRecord(data['counts'])['upcoming']).toBe(2);
  });

  it('drops what has already lapsed only when asked to', async () => {
    const { data } = await runTool(
      'hudu_expiring_soon',
      { days: 30, include_expired: false },
      routes,
    );

    expect(asRecord(data['counts'])['already_expired']).toBe(0);
    expect(asArray(asArray(data['companies'])[0]?.['already_expired'])).toEqual([]);
  });

  it('lists an undated entry rather than silently placing it in or out', async () => {
    const { data } = await runTool('hudu_expiring_soon', { days: 30 }, routes);

    expect(asRecord(data['counts'])['undated']).toBe(1);
    expect(asArray(data['undated'])[0]).toMatchObject({ expiration_id: 5, raw_date: 'whenever' });
    expect(String(data['summary'])).toMatch(/no readable date/);
  });

  it('resolves company and subject names with one walk each, not one get per row', async () => {
    const { data, calls } = await runTool('hudu_expiring_soon', { days: 30 }, routes);

    expect(calls.filter((call) => call.path === '/websites')).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/companies')).toHaveLength(1);
    expect(calls.some((call) => /^\/websites\/\d+/.test(call.path))).toBe(false);
    // Naming a credential must never cost a walk of the credential collection.
    expect(calls.some((call) => call.path.startsWith('/asset_passwords'))).toBe(false);

    const group = asArray(data['companies'])[0];
    expect(group?.['company_name']).toBe('Acme Ltd');
    expect(asArray(group?.['upcoming'])[0]).toMatchObject({
      subject_type: 'Website',
      subject_id: 103,
      subject_name: 'today.example',
    });
  });

  it('reports an unresolvable subject type plainly instead of fetching it', async () => {
    const { data, calls } = await runTool(
      'hudu_expiring_soon',
      { days: 30 },
      {
        '/expirations': () => [
          expiration(1, day(3), { expirationable_type: 'AssetPassword', expirationable_id: 9 }),
        ],
        '/companies': () => COMPANIES,
      },
    );

    expect(calls.some((call) => call.path.startsWith('/asset_passwords'))).toBe(false);

    const entry = asArray(asArray(data['companies'])[0]?.['upcoming'])[0];
    expect(entry).toMatchObject({ subject_type: 'AssetPassword', subject_id: 9 });
    expect(entry?.['subject_name']).toBeNull();

    const resolution = asRecord(asRecord(data['subject_resolution'])['AssetPassword']);
    expect(resolution['resolved']).toBe(false);
    expect(String(resolution['note'])).toMatch(/otp_secret|password/);
  });

  it('honours an explicit range over `days`, at both ends', async () => {
    const { data } = await runTool(
      'hudu_expiring_soon',
      { start_date: day(10), end_date: day(20) },
      {
        '/expirations': () => [
          expiration(1, day(9)),
          expiration(2, day(10)),
          expiration(3, day(20)),
          expiration(4, day(21)),
        ],
        '/companies': () => COMPANIES,
      },
    );

    const window = asRecord(data['window']);
    expect([window['start'], window['end']]).toEqual([day(10), day(20)]);
    expect(
      asArray(asArray(data['companies'])[0]?.['upcoming']).map((entry) => entry['date']),
    ).toEqual([day(10), day(20)]);
    expect(asRecord(data['counts'])['outside_window']).toBe(2);
  });

  it('refuses a window that ends before it starts', async () => {
    const { response, text } = await runTool(
      'hudu_expiring_soon',
      { start_date: day(20), end_date: day(10) },
      routes,
    );

    expect(response.isError).toBe(true);
    expect(text).toMatch(/before it starts/i);
  });
});
