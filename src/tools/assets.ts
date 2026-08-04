/**
 * Assets and asset layouts.
 *
 * Assets are the one resource in the Hudu API whose read and write surfaces sit
 * at different paths. `GET /assets` lists across the whole instance, but there
 * is no `/assets/{id}` route at all: fetching, creating, updating, archiving and
 * deleting a single asset all happen under `/companies/{company_id}/assets`.
 * An asset id on its own is therefore not addressable, which is the single
 * mistake a caller is most likely to make here — hence the repetition about
 * `company_id` in the descriptions below. Only the global list is regular
 * enough for the CRUD factory; the rest are written out.
 *
 * The second trap is custom data. An asset returns its layout-defined values as
 * `fields` (objects carrying id, label, value and position) but only accepts
 * them back as `custom_fields` (label/value pairs). Reads and writes are not
 * symmetric and a fetched asset cannot be sent back unchanged.
 */

import { z } from 'zod';

import { unwrapList, unwrapRecord } from '../api/envelope.js';
import { buildPath } from '../api/paths.js';
import { DEFAULT_PAGE_SIZE } from '../config.js';
import {
  type ListEnvelope,
  pageInfo,
  projectFields,
  renderListMarkdown,
  renderRecordMarkdown,
  ResponseFormat,
} from '../presentation/format.js';
import { OperationClass } from '../security/classification.js';
import { defineTool, responseFormatArg, type ToolDefinition } from './define.js';
import {
  buildListTool,
  buildResourceTools,
  fieldsArg,
  paginationArgs,
  type ResourceSpec,
} from './resource.js';

const COMPANY_ASSETS_PATH = '/companies/{company_id}/assets';
const ASSET_ITEM_PATH = '/companies/{company_id}/assets/{id}';

const updatedAtDescription =
  'ISO-8601 range as "start,end". Either side may be omitted — "2026-01-01T00:00:00Z," means ' +
  'everything changed since that moment.';

const ASSET_SUMMARY =
  'An asset is any documented thing that belongs to a company — a server, a workstation, a ' +
  'firewall, a licence, a contact. The asset layout it was created from decides which custom ' +
  'fields it carries.';

const WRITE_PATH_WARNING =
  'Assets are read globally but written per company. This tool needs the owning company id as ' +
  'well as the asset id, because Hudu exposes no /assets/{id} route. If you found the asset ' +
  'with hudu_list_assets, take `company_id` straight from that record; if all you have is an ' +
  'asset id, call hudu_list_assets with `id` set to it and read `company_id` off the result.';

const companyIdArg = {
  company_id: z
    .number()
    .int()
    .positive()
    .describe(
      'Numeric id of the company that owns this asset. Not optional and not guessable — an ' +
        'asset id belonging to company A returns 404 under company B, indistinguishable from a ' +
        'deleted asset.',
    ),
};

const assetIdArg = {
  id: z
    .number()
    .int()
    .positive()
    .describe(
      'Numeric id of the asset, as returned by hudu_list_assets or hudu_list_company_assets.',
    ),
};

/**
 * The documented write shape for layout-defined values.
 *
 * `POST` documents this as an array of objects keyed by the layout field's label
 * and the `PUT` description gives the worked example. The spec's own type for it
 * is malformed (a stray `asset` wrapper on POST, a read-model `$ref` on PUT), so
 * the prose is the only usable source and it is reproduced faithfully here.
 */
const customFieldsArg = z
  .array(z.record(z.string()))
  .optional()
  .describe(
    'Values for the custom fields the asset layout defines, as an array holding one object ' +
      'that maps field label to value: [{"brand": "Apple", "model": "MacBook Pro"}]. Each key ' +
      'is a layout field label in snake_case — lower-cased with spaces replaced by underscores, ' +
      'so a field labelled "Serial Number" is the key "serial_number" — and Hudu requires each ' +
      'key to match a field that already exists on the layout given by asset_layout_id. Call ' +
      'hudu_get_asset_layout first to read the exact labels. Values are documented as strings, ' +
      'so send numbers and dates as strings ("42", "2026-01-01"). Note the asymmetry with ' +
      'reads: a fetched asset returns this data under `fields` as {id, label, value, position} ' +
      'objects, which is not a shape this parameter accepts — rebuild the label/value pairs ' +
      'yourself rather than sending back what you read.',
  );

const assetWritableFields = {
  name: z.string().min(1).optional().describe('Display name of the asset, e.g. a hostname.'),
  asset_layout_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the asset layout this asset uses. The layout is the template that decides ' +
        'which custom fields the asset has; list the choices with hudu_list_asset_layouts.',
    ),
  primary_serial: z.string().optional().describe('Serial number shown at the top of the asset.'),
  primary_mail: z.string().optional().describe('Primary email address associated with the asset.'),
  primary_model: z.string().optional().describe('Hardware or product model.'),
  primary_manufacturer: z.string().optional().describe('Manufacturer or vendor name.'),
  custom_fields: customFieldsArg,
};

/**
 * Only `GET /assets` is regular. Every other asset operation needs a second path
 * parameter, which the factory does not model, so this spec is fed to
 * `buildListTool` alone.
 */
const assetsListSpec: ResourceSpec = {
  key: 'assets',
  singular: 'asset',
  title: 'Asset',
  titlePlural: 'Assets',
  basePath: '/assets',
  listKey: 'assets',
  summary: ASSET_SUMMARY,
  listNotes:
    'This is the only route that reads assets across every company, and it is read-only: ' +
    'creating, updating, archiving and deleting an asset all happen under ' +
    '/companies/{company_id}/assets. Keep the `company_id` of any record you might write to — ' +
    'hudu_get_asset, hudu_create_asset, hudu_update_asset, hudu_archive_asset and ' +
    'hudu_delete_asset all require it, and it cannot be recovered from the asset id alone. If ' +
    'you narrow the response with `fields`, keep "company_id" in the list.\n\n' +
    'Custom field values come back under `fields` as {id, label, value, position} objects ' +
    'rather than as top-level keys. `search` is the right first filter for a hostname or a ' +
    'fragment of a name; `id` is how you turn a bare asset id into the company id needed to ' +
    'write to it.',
  paginated: true,
  filters: {
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only assets owned by this company.'),
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Return the single asset with this id. Useful when you hold an asset id and need its ' +
          '`company_id` before you can write to it.',
      ),
    name: z.string().optional().describe('Match against the asset name.'),
    primary_serial: z.string().optional().describe('Match against the serial number.'),
    asset_layout_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only assets built on this asset layout, e.g. only servers.'),
    archived: z
      .boolean()
      .optional()
      .describe('true returns archived assets instead of active ones.'),
    slug: z.string().optional().describe('URL slug, if you already know it.'),
    search: z
      .string()
      .optional()
      .describe('Broad text search across asset fields. The best first filter for a name.'),
    updated_at: z.string().optional().describe(updatedAtDescription),
  },
};

/** `GET /companies/{company_id}/assets`. */
const listCompanyAssetsTool = defineTool({
  name: 'hudu_list_company_assets',
  title: 'List Assets for a Company',
  description:
    `List the assets belonging to one company. ${ASSET_SUMMARY}\n\n` +
    'This route accepts paging and the archived flag and nothing else. To filter by name, ' +
    'serial, layout or free text within a company, call hudu_list_assets with `company_id` ' +
    'set instead — it reaches the same records and supports the full filter set.\n\n' +
    'Returns an object with `items` plus pagination facts. Hudu returns no total count for any ' +
    'collection, so `page_was_full` is the only honest signal that more records exist.',
  inputSchema: {
    ...companyIdArg,
    archived: z
      .boolean()
      .optional()
      .describe('true returns archived assets instead of active ones.'),
    ...paginationArgs,
    ...fieldsArg,
    ...responseFormatArg,
  },
  operationClass: OperationClass.Read,
  handler: async (args, { client }) => {
    const page = (args['page'] as number | undefined) ?? 1;
    const pageSize = (args['page_size'] as number | undefined) ?? DEFAULT_PAGE_SIZE;

    const response = await client.get<unknown>(
      buildPath(COMPANY_ASSETS_PATH, { company_id: args['company_id'] as number }),
      {
        page,
        page_size: pageSize,
        archived: args['archived'] as boolean | undefined,
      },
    );

    const raw = unwrapList<Record<string, unknown>>(
      response.data,
      'assets',
      `GET ${COMPANY_ASSETS_PATH}`,
    );
    const items = projectFields(raw, args['fields'] as string[] | undefined);
    const envelope: ListEnvelope<Record<string, unknown>> = {
      ...pageInfo(page, pageSize, items.length),
      items,
    };

    return {
      data: envelope,
      markdown:
        args['response_format'] === ResponseFormat.Markdown
          ? (data): string =>
              renderListMarkdown('Assets', data as ListEnvelope<Record<string, unknown>>, 'name')
          : undefined,
    };
  },
});

/** `GET /companies/{company_id}/assets/{id}`. */
const getAssetTool = defineTool({
  name: 'hudu_get_asset',
  title: 'Get Asset',
  description:
    `Fetch one asset with every value stored on it. ${ASSET_SUMMARY}\n\n` +
    `${WRITE_PATH_WARNING}\n\n` +
    'Layout-defined data comes back under `fields`: an array of {id, label, value, position} ' +
    'objects, one per field the layout defines. Read it here before any update, because a PUT ' +
    'replaces the values it is given.',
  inputSchema: { ...companyIdArg, ...assetIdArg, ...responseFormatArg },
  operationClass: OperationClass.Read,
  handler: async (args, { client }) => {
    const response = await client.get<unknown>(
      buildPath(ASSET_ITEM_PATH, {
        company_id: args['company_id'] as number,
        id: args['id'] as number,
      }),
    );
    const record = unwrapRecord(response.data, 'asset');
    return {
      data: record ?? null,
      markdown:
        args['response_format'] === ResponseFormat.Markdown
          ? (data): string => renderRecordMarkdown('Asset', data)
          : undefined,
    };
  },
});

/** Copy only documented writable keys into the body, so no control argument leaks. */
const WRITABLE_KEYS = [
  'name',
  'asset_layout_id',
  'primary_serial',
  'primary_mail',
  'primary_model',
  'primary_manufacturer',
  'custom_fields',
] as const;

const assetBody = (args: Record<string, unknown>): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  for (const key of WRITABLE_KEYS) {
    const value = args[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
};

/** `POST /companies/{company_id}/assets`. */
const createAssetTool = defineTool({
  name: 'hudu_create_asset',
  title: 'Create Asset',
  description:
    `Create an asset inside a company. ${ASSET_SUMMARY}\n\n` +
    'Every asset belongs to exactly one company and there is no global create route, so ' +
    'company_id is required. Choose asset_layout_id before calling: the layout fixes which ' +
    'custom fields the asset can hold and Hudu will not infer one. hudu_list_asset_layouts ' +
    'lists the layouts and hudu_get_asset_layout shows the field labels a layout defines, ' +
    'which are the keys `custom_fields` expects.\n\n' +
    'Returns the created asset, including the id Hudu assigned. Hudu answers 422 with the ' +
    'offending field named when validation fails, including when a custom field label does not ' +
    'exist on the chosen layout.',
  inputSchema: {
    ...companyIdArg,
    ...assetWritableFields,
    // Required here rather than merely documented: an asset without a layout has
    // nowhere to put its fields, and a nameless one is unusable in the Hudu UI.
    name: z.string().min(1).describe('Display name of the asset, e.g. a hostname.'),
    asset_layout_id: z
      .number()
      .int()
      .positive()
      .describe(
        'Numeric id of the asset layout to build this asset from. The layout decides which ' +
          'custom fields exist; list the choices with hudu_list_asset_layouts.',
      ),
  },
  operationClass: OperationClass.Create,
  handler: async (args, { client }) => {
    const response = await client.post<unknown>(
      buildPath(COMPANY_ASSETS_PATH, { company_id: args['company_id'] as number }),
      { asset: assetBody(args) },
    );
    return { data: unwrapRecord(response.data, 'asset') ?? null };
  },
});

/** `PUT /companies/{company_id}/assets/{id}`. */
const updateAssetTool = defineTool({
  name: 'hudu_update_asset',
  title: 'Update Asset',
  description:
    `Update an existing asset. ${ASSET_SUMMARY}\n\n` +
    `${WRITE_PATH_WARNING}\n\n` +
    'Only the arguments you supply are sent, but each one replaces the stored value outright — ' +
    'this is a PUT, not a merge. Read the asset with hudu_get_asset first whenever you intend ' +
    'to add to a field rather than overwrite it. The same applies to `custom_fields`: send the ' +
    'full label/value set you want the asset to end up with.',
  inputSchema: { ...companyIdArg, ...assetIdArg, ...assetWritableFields },
  operationClass: OperationClass.Update,
  impact: 'Overwrites the supplied fields on this asset with the values given.',
  handler: async (args, { client }) => {
    const response = await client.put<unknown>(
      buildPath(ASSET_ITEM_PATH, {
        company_id: args['company_id'] as number,
        id: args['id'] as number,
      }),
      { asset: assetBody(args) },
    );
    return { data: unwrapRecord(response.data, 'asset') ?? null };
  },
});

/** `PUT /companies/{company_id}/assets/{id}/archive` and `/unarchive`. */
const archiveAssetTool = defineTool({
  name: 'hudu_archive_asset',
  title: 'Archive or Restore Asset',
  description:
    'Archive or unarchive an asset. Archiving hides it from normal views and from the default ' +
    'listings without deleting anything, and is reversible by calling this tool again with ' +
    '`archived: false`. Archived assets are still readable through hudu_list_assets with ' +
    '`archived: true`.\n\n' +
    `${WRITE_PATH_WARNING}\n\n` +
    'This is the reversible alternative to hudu_delete_asset and should be preferred whenever ' +
    'the user wants a decommissioned machine "removed" without saying they want its ' +
    'documentation gone permanently.',
  inputSchema: {
    ...companyIdArg,
    ...assetIdArg,
    archived: z.boolean().describe('true archives the asset; false restores it from the archive.'),
  },
  operationClass: OperationClass.Update,
  impact: 'Hides or restores this asset. Reversible.',
  handler: async (args, { client }) => {
    const id = args['id'] as number;
    const archived = args['archived'] as boolean;
    const action = archived ? 'archive' : 'unarchive';

    const response = await client.put<unknown>(
      buildPath(`${ASSET_ITEM_PATH}/${action}`, {
        company_id: args['company_id'] as number,
        id,
      }),
    );

    return {
      data: {
        [archived ? 'archived' : 'unarchived']: true,
        resource: 'assets',
        id,
        record: unwrapRecord(response.data, 'asset') ?? null,
      },
    };
  },
});

const DELETE_IMPACT =
  'Permanently removes the asset and the custom field values stored on it. The Hudu REST API ' +
  'offers no undo.';

/** `DELETE /companies/{company_id}/assets/{id}`. */
const deleteAssetTool = defineTool({
  name: 'hudu_delete_asset',
  title: 'Delete Asset',
  description:
    `Permanently delete an asset. ${DELETE_IMPACT}\n\n` +
    `${WRITE_PATH_WARNING}\n\n` +
    'Prefer hudu_archive_asset unless the user has explicitly asked for permanent deletion — ' +
    'archiving hides the record while keeping it recoverable, which is almost always what ' +
    '"retire this machine" means.',
  inputSchema: { ...companyIdArg, ...assetIdArg },
  operationClass: OperationClass.Destructive,
  impact: DELETE_IMPACT,
  handler: async (args, { client }) => {
    const id = args['id'] as number;
    const response = await client.delete<unknown>(
      buildPath(ASSET_ITEM_PATH, { company_id: args['company_id'] as number, id }),
    );
    return {
      data: {
        deleted: true,
        resource: 'assets',
        id,
        company_id: args['company_id'] as number,
        status: response.status,
        ...(response.data === undefined ? {} : { response: response.data }),
      },
      notice: `Deleted asset ${id}. This cannot be undone through the API.`,
    };
  },
});

const layoutFieldTypeDescription =
  'Type of control the field renders as, e.g. "Text", "RichText", "Number". The API publishes ' +
  'no closed list of types; copy one from an existing layout via hudu_get_asset_layout rather ' +
  'than inventing a name.';

const layoutWritableFields = {
  name: z.string().min(1).optional().describe('Name of the layout, e.g. "Server" or "Licence".'),
  icon: z
    .string()
    .optional()
    .describe('Font Awesome icon class shown next to assets of this type, e.g. "fas fa-server".'),
  color: z.string().optional().describe('Background colour as a hex code, e.g. "#2E86C1".'),
  icon_color: z.string().optional().describe('Icon colour as a hex code, e.g. "#FFFFFF".'),
  include_passwords: z
    .boolean()
    .optional()
    .describe('Whether assets of this type can hold linked passwords.'),
  include_photos: z.boolean().optional().describe('Whether assets of this type can hold photos.'),
  include_comments: z
    .boolean()
    .optional()
    .describe('Whether assets of this type can hold comments.'),
  include_files: z
    .boolean()
    .optional()
    .describe('Whether assets of this type can hold file attachments.'),
  password_types: z
    .string()
    .optional()
    .describe(
      'Password categories offered on assets of this type, as one string with each category on ' +
        'its own line (newline-separated, not an array).',
    ),
};

/**
 * Layouts are ordinary CRUD minus a delete, so the factory covers them.
 *
 * `fields` is deliberately absent from the update tool: the spec documents it as
 * an array of bare names there and as an array of field objects on create, and
 * guessing wrong would rewrite the field definitions of every asset on the
 * layout. Reported as a spec defect rather than resolved by assumption.
 */
const assetLayoutsSpec: ResourceSpec = {
  key: 'asset_layouts',
  singular: 'asset_layout',
  title: 'Asset Layout',
  titlePlural: 'Asset Layouts',
  basePath: '/asset_layouts',
  summary:
    'An asset layout is the template behind an asset type: its icon and colour, whether its ' +
    'assets can hold passwords, photos, comments and files, and the set of custom fields every ' +
    'asset of that type carries. Layouts are instance-wide rather than per-company. Field ' +
    'definitions can be set when a layout is created; the documented shape for changing them ' +
    'afterwards contradicts the shape creation accepts, so this server does not expose field ' +
    'edits on update. There is no delete endpoint for layouts — set `active: false` to retire ' +
    'one.',
  listNotes:
    'Read this before writing any asset: the `fields` array on each layout gives the labels ' +
    'that hudu_create_asset and hudu_update_asset expect as `custom_fields` keys, in ' +
    'snake_case. This endpoint documents `page` but no `page_size`, so pages come back at the ' +
    "server's own size.",
  paginated: true,
  pageSizeSupported: false,
  filters: {
    name: z.string().optional().describe('Match against the layout name, e.g. "Server".'),
    slug: z.string().optional().describe('URL slug, if you already know it.'),
    updated_at: z.string().optional().describe(updatedAtDescription),
  },
  create: {
    bodyKey: 'asset_layout',
    fields: {
      ...layoutWritableFields,
      name: z.string().min(1).describe('Name of the layout, e.g. "Server" or "Licence".'),
      fields: z
        .array(
          z.object({
            label: z
              .string()
              .min(1)
              .describe(
                'Human label for the field, e.g. "Serial Number". Assets refer to it in ' +
                  'snake_case ("serial_number") when writing values.',
              ),
            field_type: z.string().min(1).describe(layoutFieldTypeDescription),
            required: z
              .boolean()
              .optional()
              .describe('Whether an asset must supply a value for this field.'),
            show_in_list: z
              .boolean()
              .optional()
              .describe('Whether the value appears in asset list views.'),
            position: z
              .number()
              .int()
              .optional()
              .describe('1-based ordering of this field on the asset page.'),
          }),
        )
        .optional()
        .describe(
          'The custom fields every asset on this layout will carry. This is the only documented ' +
            'point at which field definitions can be supplied, so include them here rather ' +
            'than planning to add them later.',
        ),
    },
  },
  update: {
    bodyKey: 'asset_layout',
    fields: {
      ...layoutWritableFields,
      active: z
        .boolean()
        .optional()
        .describe(
          'false retires the layout without deleting it. Layouts have no delete endpoint, so ' +
            'this is the only way to take one out of use.',
        ),
    },
  },
};

export function assetTools(): ToolDefinition[] {
  return [
    buildListTool(assetsListSpec),
    listCompanyAssetsTool,
    getAssetTool,
    createAssetTool,
    updateAssetTool,
    archiveAssetTool,
    deleteAssetTool,
    ...buildResourceTools(assetLayoutsSpec),
  ];
}
