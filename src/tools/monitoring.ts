/**
 * Websites, relations, magic dash items and matchers.
 *
 * What holds these four together is that none of them is documentation in the
 * way an article or an asset is. A website is a live monitor, a relation is an
 * edge between two other records, a magic dash item is a tile painted onto a
 * company dashboard, and a matcher is a row in the mapping table between a
 * connected PSA or RMM and Hudu's companies. Three of the four are also
 * irregular against the CRUD factory, each in a different way:
 *
 *   - `/relations` has no read-one and no update route at all.
 *   - `/magic_dash` has no read-one route, its POST is an upsert, and it has a
 *     second delete that matches on a title rather than an id.
 *   - `/matchers` has no read-one and no create route, because matchers are
 *     brought into existence by an integration sync rather than by a caller.
 *
 * So the factory builds the list, delete and generic pieces, and the four tools
 * whose behaviour the factory's fixed prose would misdescribe are written out.
 */

import { z } from 'zod';

import { unwrapRecord } from '../api/envelope.js';
import { buildPath } from '../api/paths.js';
import { OperationClass } from '../security/classification.js';
import { defineTool, type ToolDefinition } from './define.js';
import {
  buildCreateTool,
  buildDeleteTool,
  buildGetTool,
  buildListTool,
  buildUpdateTool,
  type ResourceSpec,
} from './resource.js';

/** Drop the `undefined` the factory returns for capabilities a spec omits. */
const defined = (tools: readonly (ToolDefinition | undefined)[]): ToolDefinition[] =>
  tools.filter((tool): tool is ToolDefinition => tool !== undefined);

/** Strip `undefined` so a partial write never blanks a field it did not mention. */
const bodyFrom = (
  args: Record<string, unknown>,
  drop: readonly string[],
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (drop.includes(key)) continue;
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
};

const updatedAtDescription =
  'ISO-8601 range as "start,end". Either side may be omitted — "2026-01-01T00:00:00Z," means ' +
  'everything changed since that moment, ",2026-01-01T00:00:00Z" everything changed before it. ' +
  'A bare timestamp with no comma matches that exact moment.';

/**
 * How `name` and `search` differ, which the captured contract never says.
 *
 * Measured on Hudu 2.34.2 against `GET /assets`: `name: "UDM Pro"` matched the
 * whole name case-insensitively and excluded "UDM Pro Max", while `search:
 * "UDM"` matched as a substring and returned both. The measurement is from the
 * asset list rather than `/websites`, so it is offered as the behaviour to
 * expect rather than as a fact established here. A website's name is its URL,
 * which makes an exact-match `name` filter especially easy to miss with —
 * "contoso.com" is not the stored "https://portal.contoso.com".
 */
const NAME_MATCHING =
  'Matching, observed on Hudu 2.34.2 and documented nowhere: a `name` filter matched the whole ' +
  'value case-insensitively rather than as a substring — on the asset list, `name: "UDM Pro"` ' +
  'excluded "UDM Pro Max". That is one instance rather than a published contract, so treat it ' +
  'as a working assumption. It bites here because the stored name is a full URL: send exactly ' +
  'what the record holds, or use `search` for a hostname fragment. An empty result means ' +
  'nothing matched the name in full, not that the site is unmonitored.';

const SEARCH_MATCHING =
  'Matching, observed on Hudu 2.34.2 and documented nowhere: `search` matched as a substring ' +
  'where `name` matched the whole value — on the asset list, `search: "UDM"` returned both "UDM ' +
  'Pro" and "UDM Pro Max", while `name: "UDM Pro"` returned only the first. That is one ' +
  'instance rather than a published contract, but it is the reason to reach for this parameter ' +
  'when you hold a hostname rather than the full URL a website record is named after.';

/* ------------------------------------------------------------------------- *
 * Websites
 * ------------------------------------------------------------------------- */

const WEBSITE_SUMMARY =
  'A website in Hudu is a live monitor, not a documentation page: Hudu polls the host on a ' +
  'schedule and records its uptime, TLS certificate expiry, WHOIS registration and DNS records ' +
  'against the owning company.';

const websiteWritableFields = {
  name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The site to monitor, written as its URL — "https://portal.contoso.com". This doubles as ' +
        'the display name of the record, so Hudu shows whatever you send here in lists.',
    ),
  company_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the company this monitor belongs to, so its results appear on that ' +
        "company's page. Resolve a customer name to an id with hudu_list_companies first. The " +
        'list endpoint has no company filter, so a website that is filed under the wrong ' +
        'company is awkward to find again.',
    ),
  notes: z
    .string()
    .optional()
    .describe('Free-text notes shown on the website record, e.g. who owns the domain renewal.'),
  paused: z
    .boolean()
    .optional()
    .describe(
      'true suspends monitoring of this host entirely — no uptime, TLS, WHOIS or DNS checks ' +
        'run and no alerts fire — while keeping the record and its history. This is the right ' +
        'setting for a planned outage or a decommissioning in progress; deleting the record ' +
        'throws away the history as well.',
    ),
  disable_ssl: z
    .boolean()
    .optional()
    .describe(
      "true stops TLS certificate monitoring, so Hudu no longer tracks the host's certificate " +
        'or warns before it expires. Uptime checking continues. Set this for hosts served over ' +
        'plain HTTP or behind a certificate Hudu cannot validate, where the check would only ' +
        'produce noise.',
    ),
  disable_whois: z
    .boolean()
    .optional()
    .describe(
      'true stops WHOIS monitoring, so Hudu no longer tracks the domain registration or warns ' +
        'before the domain expires. Uptime checking continues. Set this for hosts on a domain ' +
        'the customer does not own, or on a TLD whose registry does not answer WHOIS.',
    ),
  disable_dns: z
    .boolean()
    .optional()
    .describe(
      "true stops DNS record monitoring, so Hudu no longer snapshots the domain's records or " +
        'reports when they change. Uptime checking continues.',
    ),
};

export const websitesSpec: ResourceSpec = {
  key: 'websites',
  singular: 'website',
  title: 'Website',
  titlePlural: 'Websites',
  basePath: '/websites',
  summary: WEBSITE_SUMMARY,
  listNotes:
    'There is no company filter on this endpoint. To answer "what are we monitoring for ' +
    'Contoso?", list websites and match on `company_id` in the returned records, or try ' +
    '`search`. The monitoring state of each record is in `monitoring_status` ("up"/"down"), ' +
    '`code` (last HTTP status) and `monitored_at` (when it was last checked).',
  paginated: true,
  filters: {
    search: z
      .string()
      .optional()
      .describe(
        'Broad text search across website fields. The best first filter for a hostname. ' +
          SEARCH_MATCHING,
      ),
    name: z
      .string()
      .optional()
      .describe(`Match against the website name — usually its URL. ${NAME_MATCHING}`),
    slug: z.string().optional().describe('URL slug, if you already know it.'),
    updated_at: z.string().optional().describe(updatedAtDescription),
  },
  update: { bodyKey: 'website', fields: websiteWritableFields },
  deletable: true,
  deleteImpact:
    'Stops monitoring this host and permanently removes the record along with its accumulated ' +
    'uptime, certificate and DNS history. If the intent is only to stop the checks or the ' +
    'alerts, set `paused: true` with hudu_update_website instead and keep the history.',
};

/**
 * `POST /websites`, hand-written for two reasons.
 *
 * The factory's create prose describes an inert record being filed. This call
 * instead starts recurring outbound traffic from the customer's Hudu instance
 * to a third-party host, which Article IX wants named where the decision is
 * made. It also has to tolerate an empty success body — see below.
 */
const createWebsiteTool = defineTool({
  name: 'hudu_create_website',
  title: 'Create Website Monitor',
  description:
    `Create a website monitor. ${WEBSITE_SUMMARY}\n\n` +
    'This is not a passive documentation record. From the moment it is created, the Hudu ' +
    'instance begins making repeated outbound requests to the host you name — HTTP polling ' +
    "plus TLS, WHOIS and DNS lookups — on Hudu's own schedule, and will raise alerts against " +
    'the owning company when they fail. Point it only at hosts the customer actually owns or ' +
    'is contracted to watch, and use `disable_ssl`, `disable_whois` and `disable_dns` to turn ' +
    'off individual checks that would only produce noise. `paused: true` creates the record ' +
    'with every check dormant.\n\n' +
    'Hudu publishes no success response for this endpoint, so the created record may come back ' +
    'empty even though the write succeeded. When that happens this tool returns `website: ' +
    'null` — confirm with hudu_list_websites filtered by `name` rather than retrying, which ' +
    'would create a second monitor. Hudu answers 422 with the offending field named when ' +
    'validation fails.',
  inputSchema: {
    ...websiteWritableFields,
    // A monitor with no host to poll has nothing to do; the spec marks no field
    // required, but this one is what the endpoint exists to receive.
    name: z
      .string()
      .min(1)
      .describe(
        'The site to monitor, written as its URL — "https://portal.contoso.com". This is the ' +
          'host Hudu will begin polling, and it doubles as the display name of the record.',
      ),
  },
  operationClass: OperationClass.Create,
  impact:
    'Starts recurring outbound monitoring of an external host from the Hudu instance, and ' +
    'arms the alerts that go with it.',
  handler: async (args, { client }) => {
    const response = await client.post<unknown>(buildPath('/websites'), {
      website: bodyFrom(args, ['confirm', 'response_format']),
    });
    const record = unwrapRecord(response.data, 'website') ?? null;

    return {
      data: { created: true, status: response.status, website: record },
      notice:
        record === null
          ? 'Hudu returned no body for this create, which its API documentation permits. The ' +
            'monitor was accepted but its id is unknown — look it up with hudu_list_websites ' +
            'before creating another.'
          : undefined,
    };
  },
});

/* ------------------------------------------------------------------------- *
 * Relations
 * ------------------------------------------------------------------------- */

const RELATION_SUMMARY =
  'A relation is a link between any two Hudu records — an asset to the password that opens it, ' +
  'an article to the company it documents — stored as a from/to pair of type-and-id. Hudu ' +
  'exposes no update route for relations, so changing one means deleting it and creating a ' +
  'replacement.';

/**
 * Deliberately not a `z.enum`.
 *
 * The spec names six types in a parenthetical (D6) and this argument used to
 * enforce them. The live run then returned `IpAddress` on real relations
 * (spec-defects.md F7) — a type the parenthetical omits — so the enum would
 * have rejected a value the API demonstrably uses, and rejected it locally,
 * before Hudu ever saw the call. An enum that is provably incomplete is worse
 * than free text: a wrong value costs one 422 several seconds later, while a
 * wrong enum makes a legitimate relation impossible to create at all. The
 * documented set and the observed set are both named in the description instead.
 */
const RELATABLE_TYPES_DOCUMENTED = [
  'Asset',
  'Website',
  'Procedure',
  'AssetPassword',
  'Company',
  'Article',
] as const;

const RELATABLE_TYPES_OBSERVED = [
  'Article',
  'Asset',
  'AssetPassword',
  'Procedure',
  'IpAddress',
] as const;

const relatableTypeDescription = (end: 'origin' | 'destination'): string =>
  `Kind of record at the ${end} of the link, as Hudu's internal class name. Two overlapping ` +
  'sets are known and neither is closed, so this is a free-text string rather than a fixed ' +
  `list. Documented in the API contract: ${RELATABLE_TYPES_DOCUMENTED.join(', ')}. Observed ` +
  `live on Hudu 2.34.2: ${RELATABLE_TYPES_OBSERVED.join(', ')} — note that IpAddress is real ` +
  'and appears in no published list, and that Website and Company are documented but were not ' +
  'seen on that instance. The string is case-sensitive and is the class name, not the label ' +
  'shown in the UI — a password is "AssetPassword", not "Password". List existing relations ' +
  'with hudu_list_relations to read the exact strings your instance uses before creating one.';

export const relationsSpec: ResourceSpec = {
  key: 'relations',
  singular: 'relation',
  title: 'Relation',
  titlePlural: 'Relations',
  basePath: '/relations',
  // GET /relations returns {relations: [...]} on Hudu 2.34.2, undocumented in
  // the captured contract (spec-defects.md F1). There is no read-one route, so
  // no recordKey is needed here.
  listKey: 'relations',
  summary: RELATION_SUMMARY,
  titleField: 'name',
  listNotes:
    'This endpoint takes no filters whatsoever — not by record, not by type, not by company. ' +
    'Finding the relations on one asset therefore means paging through the whole set and ' +
    'matching `fromable_type`/`fromable_id` (or the `toable_` pair) yourself. Expect to see ' +
    'each link twice: creating a relation also creates its mirror in the opposite direction, ' +
    'and `is_inverse: true` marks the mirror copy. Use this list to read the exact ' +
    '`fromable_type`/`toable_type` strings your instance uses before creating one — the ' +
    'published list of types is incomplete, and a live Hudu 2.34.2 instance returned Article, ' +
    'Asset, AssetPassword, Procedure and IpAddress, the last of which appears in no Hudu ' +
    'documentation.',
  paginated: true,
  create: {
    bodyKey: 'relation',
    fields: {
      fromable_type: z.string().min(1).describe(relatableTypeDescription('origin')),
      fromable_id: z
        .number()
        .int()
        .positive()
        .describe('Numeric Hudu id of the origin record, of the type named in `fromable_type`.'),
      toable_type: z.string().min(1).describe(relatableTypeDescription('destination')),
      toable_id: z
        .number()
        .int()
        .positive()
        .describe('Numeric Hudu id of the destination record, of the type named in `toable_type`.'),
      description: z
        .string()
        .optional()
        .describe(
          'Free text explaining what the link means, shown alongside it on both records — ' +
            '"admin credentials for this firewall". Worth filling in: the record names alone ' +
            'rarely say why two things were linked.',
        ),
      is_inverse: z
        .boolean()
        .optional()
        .describe(
          'Leave this unset. Hudu creates the reverse link automatically and sets this flag on ' +
            'the copy it generates; sending true yourself declares the relation you are ' +
            'creating to be that generated mirror.',
        ),
    },
  },
  deletable: true,
  deleteImpact:
    'Removes the link and its mirror copy. Neither of the two linked records is touched — only ' +
    'the association between them goes. Because Hudu has no update route for relations, this ' +
    'is also the first half of editing one: delete, then call hudu_create_relation with the ' +
    'corrected types, ids or description. Read the relation with hudu_list_relations before ' +
    'deleting so you can recreate it if the change was a mistake.',
};

/* ------------------------------------------------------------------------- *
 * Magic Dash
 * ------------------------------------------------------------------------- */

const MAGIC_DASH_SUMMARY =
  'A magic dash item is one of the coloured tiles across the top of a company page in Hudu — a ' +
  'title, a headline message, an optional shade and optional HTML detail. They are normally ' +
  'written by scripts and integrations to surface a live status ("Microsoft 365: 42 licences, ' +
  '3 unassigned") next to the documentation.';

/**
 * The company-identifier asymmetry.
 *
 * `GET /magic_dash` filters on `company_id`; both writes address a company by
 * `company_name` and take no id at all. That is not a transcription slip in
 * this file — it is what the API documents, and it is the single thing most
 * likely to send a caller in circles.
 */
const COMPANY_NAME_NOTE =
  'The write endpoints identify the company by *name*, not by id — `company_id` is a read-side ' +
  'filter only, and there is no way to address a tile by company id when writing. The name has ' +
  'to match an existing Hudu company exactly. Take it from `company_name` on a listed item, or ' +
  'from `name` on the record hudu_list_companies returns.';

export const magicDashSpec: ResourceSpec = {
  key: 'magic_dash_items',
  singular: 'magic_dash_item',
  title: 'Magic Dash Item',
  titlePlural: 'Magic Dash Items',
  basePath: '/magic_dash',
  summary: MAGIC_DASH_SUMMARY,
  titleField: 'title',
  listNotes:
    `${COMPANY_NAME_NOTE}\n\n` +
    'There is no endpoint for fetching a single magic dash item, so this list is the only way ' +
    'to read one — filter by `title` and `company_id` to narrow to the tile you want and read ' +
    'its `id` and `company_name` from the result.',
  paginated: true,
  filters: {
    title: z
      .string()
      .optional()
      .describe(
        'Match the tile title, e.g. "Microsoft 365". Titles are not unique across companies.',
      ),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Show only tiles on this company's dashboard, by numeric Hudu company id."),
  },
  deletable: true,
  deleteImpact:
    'Removes the tile from the company dashboard. The underlying data the tile reported on is ' +
    'untouched — only the tile goes — but nothing in Hudu recreates it, so whatever script or ' +
    'integration wrote it will have to run again.',
};

/**
 * `POST /magic_dash` — an upsert, not a create.
 *
 * The spec is explicit that `title` is "used for matching existing Magic Dash
 * Items with the same title and company_name", and the operation's own summary
 * is "Create or update a Magic Dash Item". A caller who reads this as a create
 * gets no error when a tile already exists — it is silently rewritten — which
 * is why it is classified Update and named for what it does.
 */
const upsertMagicDashTool = defineTool({
  name: 'hudu_upsert_magic_dash_item',
  title: 'Create or Replace Magic Dash Item',
  description:
    'Create a magic dash tile, or replace the existing one with the same title on the same ' +
    `company. ${MAGIC_DASH_SUMMARY}\n\n` +
    'Read that first sentence carefully: this single endpoint does both. Hudu matches on ' +
    '`title` plus `company_name`, and if a tile with that pair already exists it is overwritten ' +
    'with what you send — no error, no warning, and no way to recover what it said before. ' +
    'Check hudu_list_magic_dash_items for the title on that company first whenever you are not ' +
    'deliberately refreshing a tile you own.\n\n' +
    'The replacement is wholesale rather than a merge: fields you omit are not carried over ' +
    'from the previous tile, so send the complete tile you want to end up with every time.\n\n' +
    COMPANY_NAME_NOTE,
  inputSchema: {
    // title and company_name are the match key; message is what the tile says.
    // All three are required on the returned MagicDash record.
    title: z
      .string()
      .min(1)
      .describe(
        'Heading of the tile, e.g. "Microsoft 365" or "Backup Status". This is half of the ' +
          'match key: reusing a title that already exists on this company replaces that tile ' +
          'rather than adding a second one.',
      ),
    company_name: z
      .string()
      .min(1)
      .describe(
        'Exact name of the company whose dashboard the tile belongs on. This is the other half ' +
          'of the match key. It must match an existing Hudu company name; there is no id form ' +
          'of this field.',
      ),
    message: z
      .string()
      .min(1)
      .describe(
        'The headline shown on the face of the tile — short, and usually the number or status ' +
          'the tile exists to report, e.g. "42 licences, 3 unassigned".',
      ),
    content: z
      .string()
      .optional()
      .describe(
        'Longer detail revealed when the tile is opened, as HTML. Hudu renders this, so ' +
          'Markdown sent here is shown literally with its asterisks and pipes intact — use ' +
          '<table>, <ul>, <p> and <a href="..."> instead.',
      ),
    content_link: z
      .string()
      .optional()
      .describe(
        'URL the tile links out to, for sending a reader to the system the tile reports on.',
      ),
    icon: z
      .string()
      .optional()
      .describe('Font Awesome class shown in the tile header, e.g. "fas fa-circle".'),
    image_url: z
      .string()
      .optional()
      .describe('URL of an image to show in the tile header, as an alternative to an icon.'),
    shade: z
      .string()
      .optional()
      .describe(
        'Background colour of the tile, used to signal state at a glance — "success" and ' +
          '"danger" are the examples Hudu documents. Hudu publishes no closed list, so copy a ' +
          'value off an existing tile via hudu_list_magic_dash_items rather than inventing one.',
      ),
  },
  operationClass: OperationClass.Update,
  impact:
    'Overwrites any existing tile with the same title on the same company, wholesale and ' +
    'without confirmation. Creates a new tile only when no such pair exists.',
  handler: async (args, { client }) => {
    const response = await client.post<unknown>(buildPath('/magic_dash'), {
      magic_dash_item: bodyFrom(args, ['confirm', 'response_format']),
    });
    return { data: unwrapRecord(response.data, 'magic_dash_item') ?? null };
  },
});

/**
 * `DELETE /magic_dash` with no id.
 *
 * Hudu's example sends the title and company name as a JSON body on the DELETE,
 * which is what this does. The spec labels the two parameters `formData`, but
 * this client speaks JSON everywhere and the documented example is a JSON
 * object, so the body form is the one that matches the docs as written.
 */
const deleteMagicDashByTitleTool = defineTool({
  name: 'hudu_delete_magic_dash_item_by_title',
  title: 'Delete Magic Dash Item by Title',
  description:
    'Delete a magic dash tile identified by its title and company name rather than by its id. ' +
    `${MAGIC_DASH_SUMMARY}\n\n` +
    'Prefer hudu_delete_magic_dash_item when you have an id — it names exactly one record, and ' +
    'you can read that record first. This tool cannot: it hands Hudu two strings and Hudu ' +
    'deletes whatever they match, so there is nothing to check beforehand and nothing in the ' +
    'response that says which tile went. It exists because scripts that write tiles with ' +
    'hudu_upsert_magic_dash_item know the title and company they used but never learn the id.\n\n' +
    'List with hudu_list_magic_dash_items filtered by `title` and `company_id` first and show ' +
    'the user the tile you believe you are about to remove.\n\n' +
    COMPANY_NAME_NOTE,
  inputSchema: {
    title: z
      .string()
      .min(1)
      .describe(
        'Exact title of the tile to delete. Matching is on this plus the company name; a title ' +
          'that does not exist on that company matches nothing.',
      ),
    company_name: z
      .string()
      .min(1)
      .describe(
        'Exact name of the company whose dashboard the tile is on. Required — without it the ' +
          'title alone identifies nothing.',
      ),
  },
  operationClass: OperationClass.Destructive,
  impact:
    'Deletes by match rather than by id. A title that matches nothing is a harmless no-op, but ' +
    'a title that matches the wrong tile destroys it, and the response tells you neither which ' +
    'tile was removed nor whether anything was removed at all. There is no undo.',
  handler: async (args, { client }) => {
    const title = args['title'] as string;
    const companyName = args['company_name'] as string;

    const response = await client.request<unknown>({
      method: 'DELETE',
      path: buildPath('/magic_dash'),
      body: { title, company_name: companyName },
    });

    return {
      data: {
        deleted: true,
        resource: 'magic_dash_items',
        title,
        company_name: companyName,
        status: response.status,
        ...(response.data === undefined ? {} : { response: response.data }),
      },
      notice:
        `Sent a delete matching title "${title}" on company "${companyName}". Hudu does not ` +
        'report which tile it removed, or whether it removed one at all — re-list the ' +
        "company's tiles if you need to confirm the outcome.",
    };
  },
});

/* ------------------------------------------------------------------------- *
 * Matchers
 * ------------------------------------------------------------------------- */

const MATCHER_SUMMARY =
  'A matcher is one row in the mapping table between a connected integration (a PSA or RMM ' +
  "such as Autotask or ConnectWise) and Hudu's companies: it ties one customer record in that " +
  'external system to one Hudu company, so synced data lands in the right place.';

const INTEGRATION_ID_NOTE =
  '`integration_id` is required on every call here. It is the number in the address bar when ' +
  "you edit the integration in Hudu's admin UI (…/integrations/<integration_id>/edit); the API " +
  'publishes no endpoint that lists integrations, so it has to come from the user or from a ' +
  'matcher you have already seen (`integrator_id` on the record).\n\n' +
  'It is required by this schema because omitting it makes Hudu answer **HTTP 500**, not 400 ' +
  '(observed on Hudu 2.34.2). If you ever see a 500 from this endpoint, read it as a missing ' +
  'or unusable `integration_id` rather than as an outage, and check the id before reporting ' +
  'the instance as broken. With a valid `integration_id` the same call answers 200.';

export const matchersSpec: ResourceSpec = {
  key: 'matchers',
  singular: 'matcher',
  title: 'Matcher',
  titlePlural: 'Matchers',
  basePath: '/matchers',
  listKey: 'matchers',
  summary: MATCHER_SUMMARY,
  listNotes:
    `${INTEGRATION_ID_NOTE}\n\n` +
    'The reason to call this is almost always `matched: false`, which returns the records the ' +
    'integration pulled in but could not tie to a Hudu company — the sync backlog someone has ' +
    'to work through. Each unmatched row carries the external `name` and, where Hudu guessed, ' +
    'a `potential_company_id`. Resolve them one at a time with hudu_update_matcher.',
  paginated: true,
  filters: {
    // Required by the API, so required in the schema. Omitting it was expected
    // to produce a 404 that reads as "no matchers exist"; the live run found
    // that `GET /matchers` with no integration_id answers HTTP 500 instead
    // (spec-defects.md F6), which is worse — it reads as an instance fault.
    integration_id: z
      .number()
      .int()
      .positive()
      .describe(
        'Numeric id of the integration whose matchers you want. Required — omitting it makes ' +
          'Hudu answer 500 rather than rejecting the call as invalid, so a server error here ' +
          'means a missing parameter and not an outage. Find it in the URL when editing the ' +
          'integration in Hudu, or read `integrator_id` off a matcher you already have.',
      ),
    matched: z
      .boolean()
      .optional()
      .describe(
        'false returns only the integration records that have not yet been tied to a Hudu ' +
          'company — the ones needing attention. true returns only the resolved ones. Omit for ' +
          'both.',
      ),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Show only matchers already pointing at this Hudu company.'),
    sync_id: z
      .number()
      .int()
      .optional()
      .describe(
        "The record's id inside the integration, for integrations that number their records. " +
          'Use `identifier` instead when that system uses string keys.',
      ),
    identifier: z
      .string()
      .optional()
      .describe(
        "The record's string key inside the integration, for integrations that do not use " +
          'numeric ids.',
      ),
  },
  deletable: true,
  deleteImpact:
    'Removes the mapping row between the integration record and the Hudu company. No company ' +
    'and no integration data is deleted, but the link is gone and the record becomes unmatched ' +
    'again, so synced data stops landing on that company until it is re-matched. To point a ' +
    'matcher at a different company, use hudu_update_matcher instead of deleting it.',
};

/**
 * `PUT /matchers/{id}`, hand-written because the endpoint's real use is a
 * workflow rather than a field edit.
 *
 * "Update a matcher" describes the HTTP verb accurately and the job not at all.
 * What an operator actually does with this route is clear an integration's
 * unmatched backlog, and that is two calls in a fixed order — neither of which
 * a model would infer from a generic update description.
 */
const updateMatcherTool = defineTool({
  name: 'hudu_update_matcher',
  title: 'Update Matcher',
  description:
    'Point an integration record at a Hudu company, or correct which company it points at. ' +
    `${MATCHER_SUMMARY}\n\n` +
    'This is how an unmatched record gets resolved, and it is the second half of a two-step ' +
    'job:\n' +
    '1. Call hudu_list_matchers with the `integration_id` and `matched: false` to get the ' +
    'records the sync could not place. Each one gives you its `id`, the customer `name` as the ' +
    'external system spells it, and sometimes a `potential_company_id` that Hudu guessed at.\n' +
    '2. Work out the right Hudu company — hudu_list_companies with `search` set to that name ' +
    'is the usual way — and call this tool with the matcher `id` and that `company_id`.\n\n' +
    'Matchers cannot be created through the API; they appear when an integration syncs. So ' +
    'this tool only ever edits rows that already exist, and a matcher id that returns 404 ' +
    'means the sync has not produced that record.\n\n' +
    'Only the fields you supply are sent, and each replaces the stored value outright.',
  inputSchema: {
    id: z
      .number()
      .int()
      .positive()
      .describe('Numeric Hudu id of the matcher row, from hudu_list_matchers.'),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Numeric id of the Hudu company this integration record should map to. Setting this is ' +
          'what resolves an unmatched record; changing it on a matched one redirects future ' +
          'synced data to a different company.',
      ),
    potential_company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Hudu's suggested company for this record, which the UI offers as a one-click match. " +
          'Setting it only changes the suggestion — use `company_id` to actually make the match.',
      ),
    sync_id: z
      .string()
      .optional()
      .describe(
        "The record's id inside the integration. Sent as a string, even where the integration " +
          'numbers its records. Change this only to correct a mis-synced key.',
      ),
    identifier: z
      .string()
      .optional()
      .describe(
        "The record's string key inside the integration, for systems that do not use numeric " +
          'ids. Change this only to correct a mis-synced key.',
      ),
  },
  operationClass: OperationClass.Update,
  impact:
    'Changes which Hudu company this integration record maps to, and therefore where future ' +
    'synced data from that record is filed.',
  handler: async (args, { client }) => {
    const response = await client.put<unknown>(
      buildPath('/matchers/{id}', { id: args['id'] as number }),
      { matcher: bodyFrom(args, ['id', 'confirm', 'response_format']) },
    );
    return { data: unwrapRecord(response.data, 'matcher') ?? null };
  },
});

/* ------------------------------------------------------------------------- */

export function monitoringTools(): ToolDefinition[] {
  return defined([
    buildListTool(websitesSpec),
    buildGetTool(websitesSpec),
    createWebsiteTool,
    buildUpdateTool(websitesSpec),
    buildDeleteTool(websitesSpec),

    // No GET /relations/{id} and no PUT: read-one and update do not exist.
    buildListTool(relationsSpec),
    buildCreateTool(relationsSpec),
    buildDeleteTool(relationsSpec),

    // No GET /magic_dash/{id}; POST is the upsert above, not a plain create.
    buildListTool(magicDashSpec),
    upsertMagicDashTool,
    buildDeleteTool(magicDashSpec),
    deleteMagicDashByTitleTool,

    // No GET /matchers/{id} and no POST: matchers are created by integration sync.
    buildListTool(matchersSpec),
    updateMatcherTool,
    buildDeleteTool(matchersSpec),
  ]);
}
