/**
 * Declarative CRUD tool generation.
 *
 * The Hudu API exposes roughly ninety operations that are, structurally, the
 * same eight shapes repeated across twenty-odd resources. Writing them out by
 * hand would be ninety chances to forget percent-encoding, or a page-size
 * clamp, or a confirmation gate. This module turns a resource *description*
 * into those tools, so the shapes are implemented once and the per-resource
 * modules only state what is genuinely different about them.
 *
 * Irregular endpoints — the split asset read/write paths, magic dash's
 * delete-by-body, the activity-log purge — are hand-written in their own
 * modules instead of being forced through this factory.
 */

import { z } from 'zod';

import { unwrapList, unwrapRecord } from '../api/envelope.js';
import { buildPath, toQuery } from '../api/paths.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config.js';
import {
  type ListEnvelope,
  pageInfo,
  projectFields,
  renderListMarkdown,
  renderRecordMarkdown,
  ResponseFormat,
  unpaginatedInfo,
} from '../presentation/format.js';
import { OperationClass } from '../security/classification.js';
import { defineTool, responseFormatArg, type ToolDefinition } from './define.js';

/** Pagination arguments shared by every list tool that supports them. */
export const paginationArgs = {
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('1-based page number. Hudu has no cursor or offset — only pages.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(
      `Records per page (1-${MAX_PAGE_SIZE}, default ${DEFAULT_PAGE_SIZE}). Hudu publishes no ` +
        `maximum, so this client clamps at ${MAX_PAGE_SIZE}; larger values are rejected here ` +
        'rather than silently altered by the server.',
    ),
};

export const fieldsArg = {
  fields: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Return only these top-level fields on each record. Use it to keep large lists small — ' +
        'e.g. ["id","name","company_id"]. Unknown field names are ignored.',
    ),
};

export interface ResourceSpec {
  /** Resource key used in tool names, snake_case plural, e.g. `companies`. */
  readonly key: string;
  /** Singular tool-name fragment, e.g. `company`. */
  readonly singular: string;
  /** Human title, singular, e.g. `Company`. */
  readonly title: string;
  /** Human title, plural, e.g. `Companies`. */
  readonly titlePlural: string;
  /** Collection path, without the `/api/v1` prefix, e.g. `/companies`. */
  readonly basePath: string;
  /** Item path template. Defaults to `${basePath}/{id}`. */
  readonly itemPath?: string;
  /** Envelope key on list responses, when the endpoint wraps the array. */
  readonly listKey?: string;
  /** Envelope key on single-record responses, when wrapped. */
  readonly recordKey?: string;
  /** One or two sentences on what the resource is, used in every description. */
  readonly summary: string;
  /** Extra guidance appended to the list tool description. */
  readonly listNotes?: string;
  /** Filter arguments accepted by the list tool. */
  readonly filters?: z.ZodRawShape;
  /** Whether the list endpoint documents `page` and `page_size`. */
  readonly paginated: boolean;
  /**
   * Whether the paginated list endpoint also documents `page_size`. Defaults to
   * true. `GET /asset_layouts` documents `page` alone; offering a `page_size`
   * there would invite a caller to ask for 100 records, receive the server
   * default, and read the short page as the end of the data.
   */
  readonly pageSizeSupported?: boolean;
  /** Field used as the heading when rendering Markdown. */
  readonly titleField?: string;
  /** Create support: the body wrapper key and the accepted fields. */
  readonly create?: { readonly bodyKey?: string; readonly fields: z.ZodRawShape };
  /** Update support: the body wrapper key and the accepted fields. */
  readonly update?: { readonly bodyKey?: string; readonly fields: z.ZodRawShape };
  /** Whether `DELETE {itemPath}` exists. */
  readonly deletable?: boolean;
  /** Human description of what deleting this resource takes with it. */
  readonly deleteImpact?: string;
  /** Whether `PUT {itemPath}/archive` and `/unarchive` exist. */
  readonly archivable?: boolean;
}

const itemPathOf = (spec: ResourceSpec): string => spec.itemPath ?? `${spec.basePath}/{id}`;

const idArg = (spec: ResourceSpec): z.ZodRawShape => ({
  id: z.number().int().positive().describe(`Numeric Hudu id of the ${spec.title.toLowerCase()}.`),
});

/** Strip `undefined` so a partial update never blanks a field it did not mention. */
const compact = (
  input: Record<string, unknown>,
  drop: readonly string[],
): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (drop.includes(key)) continue;
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
};

const wrapBody = (bodyKey: string | undefined, payload: Record<string, unknown>): unknown =>
  bodyKey === undefined ? payload : { [bodyKey]: payload };

export function buildListTool(spec: ResourceSpec): ToolDefinition {
  const filters = spec.filters ?? {};
  const pageSizeSupported = spec.pageSizeSupported !== false;
  const pagination = spec.paginated
    ? pageSizeSupported
      ? paginationArgs
      : { page: paginationArgs.page }
    : {};

  return defineTool({
    name: `hudu_list_${spec.key}`,
    title: `List ${spec.titlePlural}`,
    description:
      `List ${spec.titlePlural.toLowerCase()} in Hudu. ${spec.summary}\n\n` +
      (spec.listNotes ? `${spec.listNotes}\n\n` : '') +
      'Returns an object with `items` plus pagination facts. Note that the Hudu API returns ' +
      'no total count for any collection, so `page_was_full` is the only honest signal that ' +
      'more records exist — read `pagination_note` before concluding a list is complete.',
    inputSchema: { ...filters, ...pagination, ...fieldsArg, ...responseFormatArg },
    operationClass: OperationClass.Read,
    handler: async (args, { client }) => {
      const page = (args['page'] as number | undefined) ?? 1;
      const pageSize = (args['page_size'] as number | undefined) ?? DEFAULT_PAGE_SIZE;
      const query = compact(args, ['fields', 'response_format', 'page', 'page_size']);

      if (spec.paginated) {
        query['page'] = page;
        if (pageSizeSupported) query['page_size'] = pageSize;
      }

      const response = await client.get<unknown>(buildPath(spec.basePath), toQuery(query));
      const raw = unwrapList<Record<string, unknown>>(
        response.data,
        spec.listKey,
        `GET ${spec.basePath}`,
      );
      const items = projectFields(raw, args['fields'] as string[] | undefined);

      const envelope: ListEnvelope<Record<string, unknown>> = {
        ...(spec.paginated
          ? pageInfo(page, pageSize, items.length)
          : unpaginatedInfo(items.length)),
        items,
      };

      return {
        data: envelope,
        markdown:
          args['response_format'] === ResponseFormat.Markdown
            ? renderListMarkdown(spec.titlePlural, envelope, spec.titleField ?? 'name')
            : undefined,
      };
    },
  });
}

export function buildGetTool(spec: ResourceSpec): ToolDefinition {
  return defineTool({
    name: `hudu_get_${spec.singular}`,
    title: `Get ${spec.title}`,
    description:
      `Fetch one ${spec.title.toLowerCase()} by its numeric id. ${spec.summary}\n\n` +
      `Use hudu_list_${spec.key} first if you only know a name — ids are not guessable, and ` +
      'Hudu answers 404 identically for a missing record and an unrouted path.',
    inputSchema: { ...idArg(spec), ...responseFormatArg },
    operationClass: OperationClass.Read,
    handler: async (args, { client }) => {
      const response = await client.get<unknown>(
        buildPath(itemPathOf(spec), { id: args['id'] as number }),
      );
      const record = unwrapRecord(response.data, spec.recordKey);
      return {
        data: record ?? null,
        markdown:
          args['response_format'] === ResponseFormat.Markdown
            ? renderRecordMarkdown(spec.title, record)
            : undefined,
      };
    },
  });
}

export function buildCreateTool(spec: ResourceSpec): ToolDefinition | undefined {
  const create = spec.create;
  if (!create) return undefined;

  return defineTool({
    name: `hudu_create_${spec.singular}`,
    title: `Create ${spec.title}`,
    description:
      `Create a new ${spec.title.toLowerCase()} in Hudu. ${spec.summary}\n\n` +
      'Returns the created record, including the id Hudu assigned. Hudu answers 422 with the ' +
      'offending field named when validation fails.',
    inputSchema: create.fields,
    operationClass: OperationClass.Create,
    handler: async (args, { client }) => {
      const payload = compact(args, ['confirm', 'response_format']);
      const response = await client.post<unknown>(
        buildPath(spec.basePath),
        wrapBody(create.bodyKey, payload),
      );
      return { data: unwrapRecord(response.data, spec.recordKey) ?? null };
    },
  });
}

export function buildUpdateTool(spec: ResourceSpec): ToolDefinition | undefined {
  const update = spec.update;
  if (!update) return undefined;

  return defineTool({
    name: `hudu_update_${spec.singular}`,
    title: `Update ${spec.title}`,
    description:
      `Update an existing ${spec.title.toLowerCase()}. ${spec.summary}\n\n` +
      'Only the fields you supply are sent. Be aware that Hudu applies these as a PUT: for ' +
      'fields you do send, the new value replaces the old one outright — read the record ' +
      `first with hudu_get_${spec.singular} if you intend to append rather than overwrite.`,
    inputSchema: { ...idArg(spec), ...update.fields },
    operationClass: OperationClass.Update,
    impact: `Overwrites the supplied fields on this ${spec.title.toLowerCase()}.`,
    handler: async (args, { client }) => {
      const payload = compact(args, ['id', 'confirm', 'response_format']);
      const response = await client.put<unknown>(
        buildPath(itemPathOf(spec), { id: args['id'] as number }),
        wrapBody(update.bodyKey, payload),
      );
      return { data: unwrapRecord(response.data, spec.recordKey) ?? null };
    },
  });
}

export function buildDeleteTool(spec: ResourceSpec): ToolDefinition | undefined {
  if (!spec.deletable) return undefined;

  const impact =
    spec.deleteImpact ??
    `Permanently removes this ${spec.title.toLowerCase()} from Hudu. The REST API offers no ` +
      'undo.';

  return defineTool({
    name: `hudu_delete_${spec.singular}`,
    title: `Delete ${spec.title}`,
    description:
      `Permanently delete a ${spec.title.toLowerCase()}. ${impact}\n\n` +
      (spec.archivable
        ? `Prefer hudu_archive_${spec.singular} unless the user has explicitly asked for ` +
          'permanent deletion — archiving hides the record while keeping it recoverable.'
        : 'There is no archive equivalent for this resource; deletion is the only removal path.'),
    inputSchema: idArg(spec),
    operationClass: OperationClass.Destructive,
    impact,
    handler: async (args, { client }) => {
      const id = args['id'] as number;
      // Most Hudu deletes answer 204 with no body; DELETE /networks/{id} is
      // documented to answer 200 with a message. Both are success.
      const response = await client.delete<unknown>(buildPath(itemPathOf(spec), { id }));
      return {
        data: {
          deleted: true,
          resource: spec.key,
          id,
          status: response.status,
          ...(response.data === undefined ? {} : { response: response.data }),
        },
        notice: `Deleted ${spec.title.toLowerCase()} ${id}. This cannot be undone through the API.`,
      };
    },
  });
}

export function buildArchiveTool(spec: ResourceSpec): ToolDefinition | undefined {
  if (!spec.archivable) return undefined;

  return defineTool({
    name: `hudu_archive_${spec.singular}`,
    title: `Archive or Restore ${spec.title}`,
    description:
      `Archive or unarchive a ${spec.title.toLowerCase()}. Archiving hides the record from ` +
      'normal views without deleting it, and is reversible by calling this tool again with ' +
      '`archived: false`.\n\n' +
      'This is the reversible alternative to deletion and should be preferred whenever the ' +
      'user wants something "removed" without saying they want it gone permanently.',
    inputSchema: {
      ...idArg(spec),
      archived: z
        .boolean()
        .describe('true archives the record; false restores it from the archive.'),
    },
    operationClass: OperationClass.Update,
    impact: `Hides or restores this ${spec.title.toLowerCase()}. Reversible.`,
    handler: async (args, { client }) => {
      const id = args['id'] as number;
      const archived = args['archived'] as boolean;
      const action = archived ? 'archive' : 'unarchive';
      const response = await client.put<unknown>(
        buildPath(`${itemPathOf(spec)}/${action}`, { id }),
      );
      return {
        data: {
          [action === 'archive' ? 'archived' : 'unarchived']: true,
          resource: spec.key,
          id,
          record: unwrapRecord(response.data, spec.recordKey) ?? null,
        },
      };
    },
  });
}

/** Build every tool a resource description implies, in a stable order. */
export function buildResourceTools(spec: ResourceSpec): ToolDefinition[] {
  return [
    buildListTool(spec),
    buildGetTool(spec),
    buildCreateTool(spec),
    buildUpdateTool(spec),
    buildArchiveTool(spec),
    buildDeleteTool(spec),
  ].filter((tool): tool is ToolDefinition => tool !== undefined);
}
