/**
 * Time-shaped composites: what is about to expire, and what actually changed.
 *
 * Both tools here exist because an external reviewer drove 0.1.0 against a live
 * instance and found the same two questions unanswerable in any reasonable
 * number of calls.
 *
 * "What expires in the next 30 days, grouped by company?" took a walk of
 * `/expirations`, a second walk of `/companies` to turn `company_id` into a
 * name, and then — because an expiration names its subject only as
 * `expirationable_type` plus `expirationable_id` — one further `get` per row
 * just to print *what* was expiring. Twenty expirations, twenty follow-up
 * calls. {@link expiringSoonTool} resolves subjects one collection at a time
 * instead: a walk per type present in the window, not a request per row.
 *
 * "Who changed this asset most recently, and what changed?" failed twice over.
 * `viewed` events swamp the log and no filter excludes them, so the newest
 * *event* for a record is routinely not its newest *change* — the reviewer's
 * asset last showed a `viewed` two months after its last real edit. And
 * `details` is a JSON *string* holding a post-state snapshot with no before
 * value, so one entry can never say what changed; two consecutive ones can.
 * {@link recentChangesTool} drops the reads and derives that comparison.
 *
 * Two commitments run through both.
 *
 * **A count is a lower bound unless the walk finished.** Hudu publishes no
 * total, no `X-Total-Count` and no `Link` header (`spec-defects.md` C1), so the
 * only end-of-collection signal is a short page — and a walk that stops at its
 * page cap has seen a prefix, not a set. Filtering that prefix client-side
 * makes it worse, because an empty *filtered* result over an incomplete walk
 * looks exactly like an empty collection. "Nothing expires in the next 30 days"
 * is a sentence that gets a certificate missed, so neither tool will emit it
 * unless the walk actually reached the end; `summary` says which case it is
 * before any number is read.
 *
 * **`details` is never passed through as text.** See {@link parseDetails} and
 * {@link diffSnapshots} for what that costs and why it is not optional.
 */

import { z } from 'zod';

import { HuduApiError } from '../api/errors.js';
import { OperationClass } from '../security/classification.js';
import { defineTool, type ToolDefinition } from '../tools/define.js';
import { describeCount, gather, indexByIdI, nameFor, type Walk, walkAll } from './compose.js';

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const asId = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** Walk provenance, in the shape both tools report it. */
const walkReport = (
  walk: Walk<unknown>,
  noun: string,
): {
  complete: boolean;
  records_read: number;
  reads_as: string;
  pages_fetched: number;
  note: string;
} => ({
  complete: walk.complete,
  records_read: walk.count,
  reads_as: describeCount(walk, noun),
  pages_fetched: walk.pages,
  note: walk.note,
});

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Compare expiry dates as calendar strings, not as instants.
 *
 * `Expiration.date` is `format: date` in the captured contract — a day, with no
 * time and no zone. Parsing it into a `Date` would attach midnight UTC and then
 * compare it against a local "now", which moves a boundary date across the edge
 * of the window depending on where the server is running. ISO calendar dates
 * sort lexicographically, so string comparison is both correct and free.
 */
const calendarDate = (value: unknown): string | undefined => {
  const text = asText(value);
  if (text === undefined) return undefined;
  const head = text.slice(0, 10);
  return CALENDAR_DATE.test(head) ? head : undefined;
};

const todayUtc = (now: number): string => new Date(now).toISOString().slice(0, 10);

const shiftDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/* -------------------------------------------------------------------------- */
/* Subject resolution                                                          */
/* -------------------------------------------------------------------------- */

interface SubjectSource {
  readonly path: string;
  readonly listKey?: string;
}

/**
 * Collections cheap enough to walk once in order to name a subject in bulk.
 *
 * The keys are `expirationable_type` values as Hudu spells them. A type absent
 * from this table is reported as type plus id and left unresolved — which is a
 * deliberate refusal, not an omission: the alternative is one `get` per row,
 * which is the cost this tool exists to remove.
 *
 * `AssetPassword` is absent on stronger grounds. `GET /asset_passwords` returns
 * `password` and `otp_secret` on every record of the *list* response
 * (`spec-defects.md` A1), so walking it to learn a credential's *name* would
 * pull every secret in the tenant into this process to answer a question about
 * dates. Nothing here needs that, so nothing here asks for it.
 */
const SUBJECT_SOURCES: Readonly<Record<string, SubjectSource>> = {
  Website: { path: '/websites' },
  Asset: { path: '/assets', listKey: 'assets' },
  Article: { path: '/articles', listKey: 'articles' },
  Company: { path: '/companies', listKey: 'companies' },
};

const UNRESOLVED_TYPE_NOTE =
  'No bulk source is walked for this type, so its subjects are reported as type plus id. ' +
  'Fetch one by id with the matching get tool if the user needs it named.';

const PASSWORD_TYPE_NOTE =
  'Deliberately not resolved: naming these would mean walking /asset_passwords, whose list ' +
  'response carries `password` and `otp_secret` on every record. Use hudu_get_password by id ' +
  'if the user needs one named.';

/* -------------------------------------------------------------------------- */
/* hudu_expiring_soon                                                          */
/* -------------------------------------------------------------------------- */

interface ExpirationEntry {
  readonly date: string;
  readonly days_from_today: number;
  readonly expiration_type: string;
  readonly subject_type: string;
  readonly subject_id: number | null;
  readonly subject_name: string | null;
  readonly expiration_id: number | null;
}

interface CompanyGroup {
  company_id: number | null;
  company_name: string;
  upcoming: ExpirationEntry[];
  already_expired: ExpirationEntry[];
}

/** Entries emitted before the rest are dropped with a note. */
const MAX_EXPIRATION_ENTRIES = 200;

const expiringSoonTool = defineTool({
  name: 'hudu_expiring_soon',
  title: 'Expiring Soon, By Company',
  description:
    'What expires in a date window, grouped by company, with each subject named — one call ' +
    'instead of an expirations walk, a companies walk, and a get per row.\n\n' +
    '**The window is applied client-side.** `GET /expirations` has no date filter, so this ' +
    'walks the collection (capped at 10 pages of 100) and compares `date` itself. Asking for ' +
    'one day therefore costs exactly what asking for a year costs. `company_id` is the one ' +
    'filter that does narrow the walk server-side; use it when you know the client.\n\n' +
    'Subjects are resolved in bulk: one extra walk per `expirationable_type` present in the ' +
    'window (Website, Asset, Article, Company). Other types — AssetPassword above all, whose ' +
    'list response carries stored credentials — are reported as type plus id and left ' +
    'unresolved. `subject_resolution` says which happened for each type.\n\n' +
    'Dates are inclusive at both ends and compared as calendar days in UTC. Entries dated ' +
    'before today come back under `already_expired` rather than mixed in with what is still ' +
    'due.\n\n' +
    '**Read `summary` before reporting a quiet window.** Every count is a lower bound unless ' +
    '`completeness.expirations.complete` is true; an empty result over a walk that stopped at ' +
    'its page cap is not evidence that nothing expires.\n\n' +
    'Wrong shape? One record’s expirations: hudu_list_expirations with resource_type plus ' +
    'resource_id. Renewal detail beyond the date: the subject’s own get tool.',
  inputSchema: {
    days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .default(30)
      .describe(
        'Window length in days, counted forward from today (UTC) and inclusive of the last ' +
          'day. Ignored when start_date and end_date are both given.',
      ),
    start_date: z
      .string()
      .regex(CALENDAR_DATE, 'Use a calendar date, e.g. 2026-09-01')
      .optional()
      .describe(
        'First day of the window, YYYY-MM-DD, inclusive. Defaults to today (UTC). Setting this ' +
          'also bounds `already_expired` at this date instead of returning every past entry.',
      ),
    end_date: z
      .string()
      .regex(CALENDAR_DATE, 'Use a calendar date, e.g. 2026-09-30')
      .optional()
      .describe('Last day of the window, YYYY-MM-DD, inclusive. Defaults to today plus `days`.'),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Numeric company id. The only filter that reduces the walk rather than the output — ' +
          'resolve a customer name with hudu_list_companies first.',
      ),
    expiration_type: z
      .enum([
        'undeclared',
        'domain',
        'ssl_certificate',
        'warranty',
        'asset_field',
        'article_expiration',
      ])
      .optional()
      .describe('Restrict to one kind of expiry, server-side.'),
    include_expired: z
      .boolean()
      .default(true)
      .describe(
        'Keep entries dated before today. True by default because a lapsed certificate is ' +
          'usually more urgent than a pending one; set false for a forward-only view.',
      ),
  },
  operationClass: OperationClass.Read,
  handler: async (args, { client }) => {
    const now = Date.now();
    const today = todayUtc(now);
    const days = (args['days'] as number | undefined) ?? 30;
    const explicitStart = args['start_date'] as string | undefined;
    const start = explicitStart ?? today;
    const end = (args['end_date'] as string | undefined) ?? shiftDays(start, days);
    const includeExpired = (args['include_expired'] as boolean | undefined) ?? true;
    const companyFilter = args['company_id'] as number | undefined;

    if (end < start) {
      throw new HuduApiError(`The window ends (${end}) before it starts (${start}).`, {
        kind: 'validation',
        guidance: 'Set end_date on or after start_date, or drop both and use `days`.',
      });
    }

    const expirations = await walkAll<Rec>(
      client,
      '/expirations',
      { company_id: companyFilter, expiration_type: args['expiration_type'] as string | undefined },
      undefined,
    );

    // The lower bound only exists when the caller drew one. By default the
    // window opens today, and a past-dated entry would then fall outside it —
    // which would hide precisely the expiries that have already bitten.
    const lowerBound = explicitStart !== undefined ? start : includeExpired ? undefined : today;

    const kept: { record: Rec; date: string }[] = [];
    const undated: Rec[] = [];
    let outsideWindow = 0;

    for (const record of expirations.items) {
      const date = calendarDate(record['date']);
      if (date === undefined) {
        undated.push(record);
        continue;
      }
      if (date > end || (lowerBound !== undefined && date < lowerBound)) {
        outsideWindow += 1;
        continue;
      }
      if (!includeExpired && date < today) {
        outsideWindow += 1;
        continue;
      }
      kept.push({ record, date });
    }

    const typesPresent = [
      ...new Set(kept.map(({ record }) => asText(record['expirationable_type']) ?? 'unknown')),
    ].sort();

    const lookups: Record<string, () => Promise<Walk<Rec>>> = {
      companies: () => walkAll<Rec>(client, '/companies', {}, 'companies'),
    };
    for (const type of typesPresent) {
      const source = SUBJECT_SOURCES[type];
      if (source === undefined) continue;
      if (type === 'Company') continue; // the companies walk already covers it
      lookups[`subjects:${type}`] = () =>
        walkAll<Rec>(client, source.path, {}, source.listKey ?? undefined);
    }

    const { results, unavailable } = await gather(lookups);

    const companiesWalk = results['companies'];
    const companyIndex = indexByIdI(companiesWalk?.items ?? []);

    const subjectIndexes = new Map<string, ReadonlyMap<number, string>>();
    if (companiesWalk !== undefined) subjectIndexes.set('Company', companyIndex);
    for (const type of typesPresent) {
      const walk = results[`subjects:${type}`];
      if (walk !== undefined) subjectIndexes.set(type, indexByIdI(walk.items));
    }

    const groups = new Map<string, CompanyGroup>();
    let upcomingCount = 0;
    let expiredCount = 0;

    for (const { record, date } of kept) {
      const companyId = asId(record['company_id']) ?? null;
      const key = companyId === null ? 'none' : String(companyId);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          company_id: companyId,
          company_name:
            companyId === null ? 'no company on this expiration' : nameFor(companyIndex, companyId),
          upcoming: [],
          already_expired: [],
        };
        groups.set(key, group);
      }

      const subjectType = asText(record['expirationable_type']) ?? 'unknown';
      const subjectId = asId(record['expirationable_id']) ?? null;
      const index = subjectIndexes.get(subjectType);
      const entry: ExpirationEntry = {
        date,
        days_from_today: daysBetween(today, date),
        expiration_type: asText(record['expiration_type']) ?? 'unknown',
        subject_type: subjectType,
        subject_id: subjectId,
        subject_name:
          index === undefined || subjectId === null ? null : (index.get(subjectId) ?? null),
        expiration_id: asId(record['id']) ?? null,
      };

      if (date < today) {
        group.already_expired.push(entry);
        expiredCount += 1;
      } else {
        group.upcoming.push(entry);
        upcomingCount += 1;
      }
    }

    const byDate = (a: ExpirationEntry, b: ExpirationEntry): number => a.date.localeCompare(b.date);
    for (const group of groups.values()) {
      group.upcoming.sort(byDate);
      group.already_expired.sort(byDate);
    }

    const ordered = [...groups.values()].sort((a, b) =>
      a.company_name.localeCompare(b.company_name),
    );

    // Bounded output, cut at group granularity so no company is shown half-empty
    // and read as having fewer expiries than it has.
    const emitted: CompanyGroup[] = [];
    let emittedEntries = 0;
    let omittedEntries = 0;
    let omittedCompanies = 0;
    for (const group of ordered) {
      const size = group.upcoming.length + group.already_expired.length;
      if (emittedEntries > 0 && emittedEntries + size > MAX_EXPIRATION_ENTRIES) {
        omittedEntries += size;
        omittedCompanies += 1;
        continue;
      }
      emitted.push(group);
      emittedEntries += size;
    }

    const subjectResolution: Rec = {};
    for (const type of typesPresent) {
      const index = subjectIndexes.get(type);
      if (index === undefined) {
        subjectResolution[type] = {
          resolved: false,
          note:
            type === 'AssetPassword'
              ? PASSWORD_TYPE_NOTE
              : SUBJECT_SOURCES[type] === undefined
                ? UNRESOLVED_TYPE_NOTE
                : 'A bulk source exists for this type but the walk failed; see `unavailable`. ' +
                  'Subjects of this type are reported as type plus id.',
        };
        continue;
      }
      const walk = type === 'Company' ? companiesWalk : results[`subjects:${type}`];
      subjectResolution[type] = {
        resolved: true,
        source: type === 'Company' ? '/companies' : SUBJECT_SOURCES[type]?.path,
        names_available: index.size,
        walk_complete: walk?.complete ?? false,
        note:
          walk?.complete === true
            ? 'Resolved from one walk of the whole collection.'
            : 'That walk stopped at its page cap, so a null subject_name may mean "beyond the ' +
              'pages read" rather than "no such record".',
      };
    }

    const total = upcomingCount + expiredCount;
    const windowText = `${start} to ${end} inclusive`;
    const summary =
      total === 0
        ? expirations.complete
          ? `Nothing expires between ${windowText}. The expirations walk reached the end of the ` +
            `collection (${expirations.count} record(s) read), so this window really is empty.`
          : `No expirations dated between ${windowText} were found in the ${expirations.count} ` +
            'record(s) read — but the walk stopped at its page cap before the end of the ' +
            'collection, so this is NOT evidence that nothing expires. Do not tell the user the ' +
            'window is clear. Narrow with company_id or expiration_type and call again.'
        : `${upcomingCount} upcoming and ${expiredCount} already-expired ` +
          `${plural(total, 'entry', 'entries')} across ${groups.size} ` +
          `${plural(groups.size, 'company', 'companies')} for ${windowText}` +
          (expirations.complete
            ? ', from a complete walk of the expirations collection.'
            : '. The expirations walk stopped at its page cap, so these are LOWER BOUNDS: more ' +
              'may exist beyond the pages read.') +
          (undated.length > 0
            ? ` ${undated.length} further record(s) carried no readable date and are listed ` +
              'under `undated` rather than placed in or out of the window.'
            : '');

    return {
      data: {
        window: {
          start,
          end,
          today,
          boundaries_inclusive: true,
          filtered_client_side: true,
          filter_note:
            'GET /expirations has no date parameter. The window above was applied by this ' +
            'server after walking the collection, so it narrowed the output and not the cost.',
        },
        completeness: {
          expirations: walkReport(expirations, 'expiration record(s) read'),
          companies:
            companiesWalk === undefined
              ? { complete: false, note: 'The companies walk failed; see `unavailable`.' }
              : {
                  ...walkReport(companiesWalk, 'company/companies'),
                  caveat:
                    'GET /companies omits archived companies and offers no parameter to include ' +
                    'them, so a company name may be missing even from a complete walk.',
                },
        },
        summary,
        counts: {
          in_window: total,
          upcoming: upcomingCount,
          already_expired: expiredCount,
          companies: groups.size,
          undated: undated.length,
          outside_window: outsideWindow,
          entries_emitted: emittedEntries,
          entries_omitted: omittedEntries,
        },
        ...(omittedEntries > 0
          ? {
              omission_note:
                `${omittedEntries} entr${omittedEntries === 1 ? 'y' : 'ies'} across ` +
                `${omittedCompanies} compan${omittedCompanies === 1 ? 'y' : 'ies'} are not ` +
                `listed below: this tool emits at most ${MAX_EXPIRATION_ENTRIES} entries per ` +
                'call. They are counted above but not shown — narrow with company_id, ' +
                'expiration_type or a shorter window to see them.',
            }
          : {}),
        subject_resolution: subjectResolution,
        unavailable,
        undated: undated.map((record) => ({
          expiration_id: asId(record['id']) ?? null,
          raw_date: record['date'] ?? null,
          expiration_type: asText(record['expiration_type']) ?? 'unknown',
          subject_type: asText(record['expirationable_type']) ?? 'unknown',
          subject_id: asId(record['expirationable_id']) ?? null,
        })),
        companies: emitted,
      },
      notice: expirations.complete
        ? undefined
        : 'The expirations walk stopped at its page cap, so every count below is a lower bound ' +
          'and an empty window is not a quiet one.',
    };
  },
});

/* -------------------------------------------------------------------------- */
/* details: parsing, and why nothing else may happen to it                     */
/* -------------------------------------------------------------------------- */

/**
 * Parse an activity-log `details` value into an object, or say why not.
 *
 * `details` arrives as a JSON **string**. That single fact is a security
 * problem, not a formatting one: `stripSecrets` in `executeTool` removes
 * `password` and `otp_secret` by key at any depth, and a string has no keys to
 * walk — so a snapshot passed through as text is a hole straight through the
 * one control this server relies on for everything else. The reviewer confirmed
 * the schema of these snapshots includes `encrypted_password_value` keys, and
 * `/activity_logs` is not scope-gated the way the password endpoints are.
 *
 * So the string never leaves this module. It is parsed here, only derived
 * values are emitted, and {@link diffSnapshots} withholds the value of any
 * field whose *name* looks like credential material. Nothing re-serialises it.
 *
 * Parsing is defensive on purpose: a snapshot this server cannot read is a
 * missing diff, never a failed tool call.
 */
function parseDetails(value: unknown): { snapshot: Rec } | { reason: string } {
  if (value === undefined || value === null) return { reason: 'no details on this entry' };
  // Already-parsed objects are accepted rather than assumed impossible: the
  // Hudu contract documents no success response for this endpoint at all
  // (spec-defects.md B2), so the string form is measurement, not promise.
  if (isRecord(value)) return { snapshot: value };
  if (typeof value !== 'string') return { reason: 'details is not a JSON object; not diffable' };

  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return { snapshot: parsed };
    return { reason: 'snapshot present, not diffable: details did not parse to an object' };
  } catch {
    return { reason: 'snapshot present, not diffable: details is not valid JSON' };
  }
}

/**
 * Field names whose *value* is never emitted, only the fact that it changed.
 *
 * Broader than `SECRET_FIELDS` in `src/security/secrets.ts`, and deliberately.
 * That list is `password` and `otp_secret` — the two fields the Hudu schema
 * declares on `Asset_Password` — and it is enforced by key on the structured
 * result. A `details` snapshot is a different surface: its keys are not
 * documented anywhere, the reviewer observed `encrypted_password_value` among
 * them, and any key in it becomes a *value* under `field` in this tool's
 * output, where a key-based stripper can no longer see it. The pattern is the
 * only control at that point, so it errs wide: withholding the value of a field
 * called `keychain_name` costs a caller nothing, and the opposite error is a
 * credential in a transcript.
 */
const SENSITIVE_FIELD_NAME =
  /(pass(word|phrase)?|secret|otp|token|credential|encrypted|api[_-]?key|private[_-]?key|salt|auth)/i;

/** Fields per entry before the rest are counted rather than listed. */
const MAX_CHANGED_FIELDS = 30;

interface FieldChange {
  readonly field: string;
  readonly from?: string | number | boolean | null;
  readonly to?: string | number | boolean | null;
  readonly value_omitted?: true;
  readonly reason?: string;
}

const SCALAR_DISPLAY_LIMIT = 200;

type Scalar = string | number | boolean | null | undefined;

const scalarOrNull = (value: Scalar): string | number | boolean | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return value.length > SCALAR_DISPLAY_LIMIT
    ? `${value.slice(0, SCALAR_DISPLAY_LIMIT)}…[truncated]`
    : value;
};

const isScalar = (value: unknown): value is Scalar =>
  value === null ||
  value === undefined ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

/**
 * Compare two post-state snapshots and report the fields that differ.
 *
 * Three rules, in order, and each one closes a way for secret material to reach
 * the output:
 *
 * 1. A field whose name matches {@link SENSITIVE_FIELD_NAME} is reported as
 *    changed with no values at all.
 * 2. A field whose value is not a scalar is reported as changed with no values
 *    either. A nested object could carry a credential under a key neither this
 *    pattern nor `stripSecrets` would reach once it had been flattened into a
 *    display string, and "the address block changed" is the useful part anyway.
 * 3. Everything else is emitted as two shortened scalars.
 *
 * The result is a *derived* diff. Hudu publishes no before/after; this is this
 * server's comparison of two snapshots it was given, and every caller-facing
 * field says so.
 */
function diffSnapshots(before: Rec, after: Rec): { changes: FieldChange[]; omitted: number } {
  const changes: FieldChange[] = [];
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();

  for (const field of fields) {
    const from = before[field];
    const to = after[field];
    if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) continue;

    if (SENSITIVE_FIELD_NAME.test(field)) {
      changes.push({
        field,
        value_omitted: true,
        reason:
          'the field name looks like credential material, so this server reports that it ' +
          'changed and withholds both values',
      });
      continue;
    }
    if (!isScalar(from) || !isScalar(to)) {
      changes.push({
        field,
        value_omitted: true,
        reason: 'nested value; this server does not expand structures out of a details snapshot',
      });
      continue;
    }
    changes.push({ field, from: scalarOrNull(from), to: scalarOrNull(to) });
  }

  return changes.length > MAX_CHANGED_FIELDS
    ? {
        changes: changes.slice(0, MAX_CHANGED_FIELDS),
        omitted: changes.length - MAX_CHANGED_FIELDS,
      }
    : { changes, omitted: 0 };
}

/* -------------------------------------------------------------------------- */
/* hudu_recent_changes                                                         */
/* -------------------------------------------------------------------------- */

const DERIVED_NOTE =
  'Derived by this server: the API publishes no before/after, so these fields come from ' +
  'comparing the JSON snapshot on this entry with the one on the previous change to the same ' +
  'record. Present it as a computed comparison, not as something Hudu reported.';

const NO_PREDECESSOR_NOTE =
  'Not diffable: this is the earliest change to this record inside the lookback window, so the ' +
  'state it was changed *from* lies outside the window and there is nothing to compare against. ' +
  'Widen `days` (or set an earlier start_date) if the previous state matters.';

const VIEW_NOTE =
  'A read, returned because include_viewed was set. It changed nothing, carries no comparable ' +
  'snapshot, and is never used as the baseline for another entry’s diff.';

/** Entries emitted before the rest are counted rather than listed. */
const MAX_CHANGE_ENTRIES = 100;

interface LogEntry {
  readonly at: number | undefined;
  readonly action: string;
  readonly isView: boolean;
  readonly recordType: string;
  readonly recordId: number | null;
  readonly loggedAt: string | null;
  readonly userId: number | null;
  readonly userEmail: string | null;
  readonly parsed: { snapshot: Rec } | { reason: string };
  what_changed: Rec;
}

const recentChangesTool = defineTool({
  name: 'hudu_recent_changes',
  title: 'Recent Changes',
  description:
    'The activity log filtered to actual changes: `viewed` events dropped, actor and record ' +
    'named, and a field-level diff derived where two snapshots allow one.\n\n' +
    'Two properties of this log make the raw tool hard to use and both are handled here. ' +
    '`viewed` events swamp an active instance and no filter excludes them, so the newest entry ' +
    'for a record is routinely not its newest change — they are dropped client-side, after the ' +
    'walk. And `details` is a JSON string holding a post-state snapshot with no before value, ' +
    'so one entry can never say what changed; where a record has two changes in the window this ' +
    'compares their snapshots and reports the fields that differ.\n\n' +
    '**That diff is derived by this server, not reported by Hudu** — `what_changed.basis` says ' +
    'so on every entry. The earliest change to a record inside the window has no predecessor ' +
    'and cannot be diffed at all. Values of fields whose names look like credential material ' +
    'are withheld, and raw `details` is never returned.\n\n' +
    '`resource_type` and `resource_id` must be sent together; Hudu ignores either alone. The ' +
    'API has a start-date filter and no end-date filter, so a window is always "since X", ' +
    'never "between X and Y".\n\n' +
    'Counts are lower bounds unless `completeness.complete` is true. For raw entries, `viewed` ' +
    'history or an unfiltered log, use hudu_list_activity_logs.',
  inputSchema: {
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .default(7)
      .describe(
        'Lookback in days from now. Sent to Hudu as `start_date`, so it does narrow the walk.',
      ),
    start_date: z
      .string()
      .optional()
      .describe(
        'Explicit ISO-8601 start instant, e.g. "2026-07-01T00:00:00Z", overriding `days`. Send ' +
          'an explicit offset; a bare date leaves the time of day to the server.',
      ),
    resource_type: z
      .string()
      .optional()
      .describe(
        'Hudu record type, spelled as Hudu spells it: "Asset", "Company", "Article", ' +
          '"AssetPassword". Must be sent with resource_id. Entries read it back as `record_type`.',
      ),
    resource_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Numeric id of that record. Must be sent with resource_type.'),
    user_id: z.number().int().positive().optional().describe('Only this actor, by numeric id.'),
    user_email: z.string().optional().describe('Only this actor, by email address.'),
    include_viewed: z
      .boolean()
      .default(false)
      .describe(
        'Keep `viewed` entries. False by default. Even when true they are never used as the ' +
          'baseline for a diff — a read changes nothing.',
      ),
  },
  operationClass: OperationClass.Read,
  handler: async (args, { client }) => {
    const resourceType = args['resource_type'] as string | undefined;
    const resourceId = args['resource_id'] as number | undefined;

    // A raw Zod shape cannot express "both or neither", and the API's failure
    // mode for one alone is silence: Hudu ignores the orphan filter and returns
    // the whole log, which reads exactly like "this record has that much
    // history". Refusing here is the only way that stays visible.
    if ((resourceType === undefined) !== (resourceId === undefined)) {
      throw new HuduApiError('resource_type and resource_id must be supplied together.', {
        kind: 'validation',
        guidance:
          'Hudu ignores either one on its own and returns the unfiltered log, which would ' +
          'look like history for the record you named. Send both, or neither.',
      });
    }

    const days = (args['days'] as number | undefined) ?? 7;
    const startDate =
      (args['start_date'] as string | undefined) ??
      new Date(Date.now() - days * DAY_MS).toISOString();
    const includeViewed = (args['include_viewed'] as boolean | undefined) ?? false;

    const walk = await walkAll<Rec>(
      client,
      '/activity_logs',
      {
        start_date: startDate,
        resource_type: resourceType,
        resource_id: resourceId,
        user_id: args['user_id'] as number | undefined,
        user_email: args['user_email'] as string | undefined,
      },
      undefined,
    );

    let viewsDropped = 0;
    const entries: LogEntry[] = [];

    for (const record of walk.items) {
      const action = asText(record['action']) ?? 'unknown';
      // Anything named "view..." is a read. Hudu publishes no list of legal
      // action values, so this is a prefix rule rather than an equality test —
      // and nothing that modifies a record is named for viewing it.
      const isView = /^view/i.test(action);
      if (isView && !includeViewed) {
        viewsDropped += 1;
        continue;
      }
      const loggedAt = asText(record['created_at']) ?? null;
      const at = loggedAt === null ? undefined : Date.parse(loggedAt);
      entries.push({
        at: at === undefined || Number.isNaN(at) ? undefined : at,
        action,
        isView,
        recordType: asText(record['record_type']) ?? 'unknown',
        recordId: asId(record['record_id']) ?? null,
        loggedAt,
        userId: asId(record['user_id']) ?? null,
        userEmail: asText(record['user_email']) ?? null,
        parsed: parseDetails(record['details']),
        // Every non-view entry is reassigned by the diff pass below; a view is
        // never in that pass, so it states its own basis here rather than
        // reaching the output with an empty object.
        what_changed: isView ? { basis: 'none', note: VIEW_NOTE } : {},
      });
    }

    /* Build the diffs, per record, oldest first. */
    const byRecord = new Map<string, LogEntry[]>();
    for (const entry of entries) {
      if (entry.isView) continue; // a read is never a baseline and never a change
      const key = `${entry.recordType}#${entry.recordId ?? 'null'}`;
      const bucket = byRecord.get(key);
      if (bucket === undefined) byRecord.set(key, [entry]);
      else bucket.push(entry);
    }

    let diffed = 0;
    for (const bucket of byRecord.values()) {
      // Undated entries sort last and are never used as a baseline: without a
      // timestamp "the previous change" is not a fact about them.
      bucket.sort((a, b) => (a.at ?? Number.MAX_SAFE_INTEGER) - (b.at ?? Number.MAX_SAFE_INTEGER));
      let previous: { entry: LogEntry; snapshot: Rec } | undefined;

      for (const entry of bucket) {
        if ('reason' in entry.parsed) {
          entry.what_changed = { basis: 'none', note: `Not diffable: ${entry.parsed.reason}.` };
        } else if (previous === undefined) {
          entry.what_changed = { basis: 'none', note: NO_PREDECESSOR_NOTE };
        } else {
          const { changes, omitted } = diffSnapshots(previous.snapshot, entry.parsed.snapshot);
          diffed += 1;
          entry.what_changed = {
            basis: 'derived diff',
            compared_against: {
              action: previous.entry.action,
              logged_at: previous.entry.loggedAt,
            },
            note: DERIVED_NOTE,
            changed_field_count: changes.length + omitted,
            ...(omitted > 0
              ? {
                  fields_omitted: omitted,
                  omission_note: `Listing the first ${MAX_CHANGED_FIELDS}.`,
                }
              : {}),
            fields: changes,
          };
        }

        if (entry.at !== undefined && !('reason' in entry.parsed)) {
          previous = { entry, snapshot: entry.parsed.snapshot };
        }
      }
    }

    /* Newest first for the reader. */
    const ordered = [...entries].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const emitted = ordered.slice(0, MAX_CHANGE_ENTRIES);
    const omittedEntries = ordered.length - emitted.length;

    const changeCount = entries.filter((entry) => !entry.isView).length;
    const summary =
      changeCount === 0
        ? walk.complete
          ? `No changes were recorded since ${startDate}` +
            (viewsDropped > 0 ? ` (${viewsDropped} \`viewed\` event(s) were dropped)` : '') +
            '. The activity-log walk reached the end of the results, so that is the whole window.'
          : `No changes were found in the ${walk.count} log entr${walk.count === 1 ? 'y' : 'ies'} ` +
            `read since ${startDate} — but the walk stopped at its page cap before the end of ` +
            'the results, so this is NOT evidence that nothing changed. Narrow with ' +
            'resource_type plus resource_id, or a shorter lookback, and call again.'
        : `${changeCount} change ${plural(changeCount, 'entry', 'entries')} across ` +
          `${byRecord.size} record(s) since ${startDate}; ${viewsDropped} \`viewed\` ` +
          `event(s) dropped; ${diffed} entr${diffed === 1 ? 'y' : 'ies'} carried a derivable ` +
          'diff.' +
          (walk.complete
            ? ''
            : ' The walk stopped at its page cap, so every figure here is a LOWER BOUND.');

    return {
      data: {
        window: {
          start: startDate,
          end: 'now',
          note:
            'GET /activity_logs filters from a start date only — there is no end-date parameter ' +
            '— so this window runs to the present and cannot be closed at the far end.',
        },
        filters: {
          resource_type: resourceType ?? null,
          resource_id: resourceId ?? null,
          user_id: args['user_id'] ?? null,
          user_email: args['user_email'] ?? null,
          viewed_events: includeViewed
            ? 'included on request'
            : 'dropped client-side after the walk',
        },
        completeness: walkReport(walk, 'log entry/entries read'),
        summary,
        counts: {
          changes: changeCount,
          viewed_dropped: viewsDropped,
          records_touched: byRecord.size,
          entries_with_derived_diff: diffed,
          entries_emitted: emitted.length,
          entries_omitted: omittedEntries,
        },
        details_handling:
          'Raw `details` is never returned. It arrives as a JSON string, which the central ' +
          'secret stripper cannot walk, so this server parses it, emits only derived field ' +
          'names and scalar values, withholds the values of fields whose names look like ' +
          'credential material, and never expands a nested structure out of a snapshot.',
        changes: emitted.map((entry) => ({
          logged_at: entry.loggedAt,
          action: entry.action,
          actor: { user_id: entry.userId, user_email: entry.userEmail },
          record_type: entry.recordType,
          record_id: entry.recordId,
          what_changed: entry.what_changed,
        })),
      },
      notice: walk.complete
        ? undefined
        : 'The activity-log walk stopped at its page cap, so every count below is a lower bound ' +
          'and "no changes" means "none in the entries read".',
    };
  },
});

export function timelineTools(): ToolDefinition[] {
  return [expiringSoonTool, recentChangesTool];
}
