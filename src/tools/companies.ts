/**
 * Companies.
 *
 * The root object in Hudu. Assets, articles, passwords, websites, networks and
 * racks all hang off a company, so almost every task begins by resolving a
 * customer name to a company id. That makes the list tool's search filters the
 * most-used surface in this server.
 */

import { z } from 'zod';

import { unwrapList } from '../api/envelope.js';
import { buildPath } from '../api/paths.js';
import { ResponseFormat, unpaginatedInfo } from '../presentation/format.js';
import { OperationClass } from '../security/classification.js';
import { defineTool, responseFormatArg, type ToolDefinition } from './define.js';
import { buildResourceTools, type ResourceSpec } from './resource.js';

/**
 * What `GET /companies` cannot show, stated wherever the list is described.
 *
 * Measured on 2.34.2: the instance holds 27 companies and this endpoint returns
 * 22. The five missing ones are all `archived: true`, and assets still point at
 * them — a tally of asset `company_id`s turned up 64 assets belonging to
 * companies that no listing of this endpoint will ever mention.
 *
 * There is no filter to fix this. `?archived=true` and `?archived=false` both
 * return the same 22 records, because `/companies` ignores query parameters it
 * does not recognise rather than rejecting them the way `/networks` does
 * (spec-defects.md F4; the rejecting behaviour is per-endpoint, not global).
 * That is precisely why an `archived` argument cannot simply be added and left
 * to fail visibly: `?archived=true` returns the same 22 records as sending
 * nothing at all, so the filter would look like it worked and do nothing, which
 * is worse than the gap it tried to close. So this is disclosed rather than
 * fixed: the pagination machinery is telling the truth about the page, and this
 * says what the page can never contain.
 *
 * It is declared as `completenessCaveat` on the spec, which puts it in the
 * description *and* on every result — `pagination_note` is what a caller reads
 * at the moment it decides the list in front of it is the whole picture, and
 * for this one resource that note is true about the paging and misleading about
 * the universe.
 */
const ARCHIVED_EXCLUSION =
  'Archived companies are missing from this list. `GET /companies` returns only unarchived ' +
  'records and Hudu publishes no parameter to include archived ones — sending `archived` has ' +
  'no effect on this endpoint, which ignores unrecognised query parameters instead of ' +
  'rejecting them. So a company id you have seen on an asset, password, website, network or ' +
  'rack may legitimately not appear here, and the number of companies on the instance may be ' +
  'larger than any page count from this tool. hudu_get_company does return archived companies: ' +
  'resolve an unfamiliar company id with it rather than concluding the company does not exist.';

const updatedAtDescription =
  'ISO-8601 range as "start,end". Either side may be omitted — "2026-01-01T00:00:00Z," means ' +
  'everything changed since that moment.';

/**
 * How `name` and `search` differ, which the captured contract never says.
 *
 * Measured on Hudu 2.34.2 against `GET /assets`: `name: "UDM Pro"` matched the
 * whole name case-insensitively and excluded "UDM Pro Max", while `search:
 * "UDM"` matched as a substring and returned both. The measurement is from the
 * asset list rather than this one, so it is offered as the behaviour to expect
 * rather than as a fact established here — the point either way is that a
 * caller who assumes `name` is a substring match silently misses records.
 */
const NAME_MATCHING =
  'Matching, observed on Hudu 2.34.2 and documented nowhere: a `name` filter matched the whole ' +
  'value case-insensitively rather than as a substring — on the asset list, `name: "UDM Pro"` ' +
  'excluded "UDM Pro Max". That is one instance rather than a published contract, so treat it ' +
  'as a working assumption: an empty result here means nothing matched the name in full, not ' +
  'that no such company exists.';

const SEARCH_MATCHING =
  'Matching, observed on Hudu 2.34.2 and documented nowhere: `search` matched as a substring ' +
  'where `name` matched the whole value — on the asset list, `search: "UDM"` returned both "UDM ' +
  'Pro" and "UDM Pro Max", while `name: "UDM Pro"` returned only the first. That is one ' +
  'instance rather than a published contract, but it is the reason to reach for this parameter ' +
  'when you hold a fragment of a name rather than all of it.';

const writableFields = {
  name: z.string().min(1).optional().describe('Company name.'),
  nickname: z.string().optional().describe('Short name shown in lists.'),
  company_type: z.string().optional().describe('Free-text classification, e.g. "Client".'),
  address_line_1: z.string().optional(),
  address_line_2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zip: z.string().optional(),
  country_name: z.string().optional(),
  phone_number: z.string().optional(),
  fax_number: z.string().optional(),
  website: z.string().optional().describe('Primary website URL.'),
  id_number: z.string().optional().describe('Your own external identifier for this company.'),
  parent_company_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Numeric id of a parent company, for nested company structures.'),
  notes: z.string().optional().describe('Free-text notes shown on the company record.'),
};

export const companiesSpec: ResourceSpec = {
  key: 'companies',
  singular: 'company',
  title: 'Company',
  titlePlural: 'Companies',
  basePath: '/companies',
  // Both envelopes are undocumented and were measured on Hudu 2.34.2:
  // GET /companies returns {companies: [...]} and GET /companies/{id} returns
  // {company: {...}} (spec-defects.md F1, F2).
  listKey: 'companies',
  recordKey: 'company',
  summary:
    'A company is the top-level container in Hudu; every asset, article, password and website ' +
    'belongs to exactly one.',
  listNotes:
    'To find a company by name, prefer `search` (matches broadly) over `name` (matches the ' +
    'name field). If the API key was created with a company scope, only that company is ' +
    `visible here and everything else returns 404.\n\n${ARCHIVED_EXCLUSION}`,
  completenessCaveat: ARCHIVED_EXCLUSION,
  paginated: true,
  filters: {
    search: z
      .string()
      .optional()
      .describe(
        `Broad text search across company fields. The best first filter for a name. ${SEARCH_MATCHING}`,
      ),
    name: z
      .string()
      .optional()
      .describe(`Match against the company name specifically. ${NAME_MATCHING}`),
    phone_number: z.string().optional(),
    website: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    slug: z.string().optional().describe('URL slug, if you already know it.'),
    id_number: z.string().optional().describe('Your own external identifier.'),
    id_in_integration: z
      .string()
      .optional()
      .describe('Match a company by its id inside a connected integration (PSA, RMM).'),
    updated_at: z.string().optional().describe(updatedAtDescription),
  },
  create: { bodyKey: 'company', fields: { ...writableFields, name: z.string().min(1) } },
  update: { bodyKey: 'company', fields: writableFields },
  deletable: true,
  deleteImpact:
    'Deletes the company AND cascades to everything inside it — assets, articles, passwords, ' +
    'websites, networks and racks. This is the widest-reaching delete in the Hudu API and ' +
    'there is no undo.',
  archivable: true,
};

/**
 * `GET /companies/jump`.
 *
 * Resolves an integration's own identifier to the Hudu company, which is how an
 * agent gets from a PSA or RMM ticket to the right documentation.
 */
const jumpTool = defineTool({
  name: 'hudu_find_company_by_integration',
  title: 'Find Company by Integration Identifier',
  description:
    'Resolve a company in a connected integration (a PSA, RMM or similar) to its Hudu company ' +
    'record.\n\n' +
    "Use this when you arrive from another system holding that system's customer id rather " +
    'than a Hudu id — for example a ticket that names its own account identifier. If you only ' +
    'have a customer *name*, use hudu_list_companies with `search` instead.',
  inputSchema: {
    integration_slug: z
      .string()
      .min(1)
      .describe('Slug of the integration in Hudu, e.g. "cw_manage", "syncro", "ninja".'),
    integration_id: z
      .number()
      .int()
      .optional()
      .describe("Hudu's internal id for the integration, when several of the same type exist."),
    integration_identifier: z
      .string()
      .optional()
      .describe("The company's identifier inside that integration."),
    ...responseFormatArg,
  },
  operationClass: OperationClass.Read,
  handler: async (args, { client }) => {
    const response = await client.get<unknown>(buildPath('/companies/jump'), {
      integration_slug: args['integration_slug'] as string,
      integration_id: args['integration_id'] as number | undefined,
      integration_identifier: args['integration_identifier'] as string | undefined,
    });
    return { data: response.data ?? null };
  },
});

/** `GET /cards/lookup` — integration cards attached to Hudu records. */
const cardLookupTool = defineTool({
  name: 'hudu_lookup_integration_cards',
  title: 'Look Up Integration Cards',
  description:
    'List the integration cards Hudu holds for a given external record. Cards are the link ' +
    'between a Hudu asset or company and its counterpart in a connected PSA or RMM, and they ' +
    'carry the synced fields shown on the record.\n\n' +
    'Use this to answer "what does Hudu know about this device from our RMM?" without opening ' +
    'the RMM itself.',
  inputSchema: {
    integration_slug: z.string().min(1).describe('Slug of the integration, e.g. "cw_manage".'),
    integration_id: z.number().int().optional().describe("Hudu's id for the integration."),
    integration_identifier: z
      .string()
      .optional()
      .describe("The record's identifier inside that integration."),
    ...responseFormatArg,
  },
  operationClass: OperationClass.Read,
  handler: async (args, { client }) => {
    const response = await client.get<unknown>(buildPath('/cards/lookup'), {
      integration_slug: args['integration_slug'] as string,
      integration_id: args['integration_id'] as number | undefined,
      integration_identifier: args['integration_identifier'] as string | undefined,
    });
    const items = unwrapList<Record<string, unknown>>(
      response.data,
      'integrator_cards',
      'GET /cards/lookup',
    );
    // A full envelope rather than a bare `{count, items}`: the character budget
    // shapes anything carrying `items`, and it can only describe a cut honestly
    // if the payload states whether the endpoint pages. `/cards/lookup`
    // documents no page parameter, so it does not.
    return {
      data: { ...unpaginatedInfo(items.length), items },
      markdown:
        args['response_format'] === ResponseFormat.Markdown
          ? (): string => `# Integration cards\n\n${items.length} card(s) found.`
          : undefined,
    };
  },
});

export function companyTools(): ToolDefinition[] {
  return [...buildResourceTools(companiesSpec), jumpTool, cardLookupTool];
}
