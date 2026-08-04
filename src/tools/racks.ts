/**
 * Rack storages and rack storage items.
 *
 * Hudu's physical model of a server room. A *rack storage* is a rack — a
 * cabinet — and a *rack storage item* is one thing mounted inside it. The
 * vocabulary is the first trap: "storage" here has nothing to do with disks,
 * volumes or shares, so every description below spends its opening sentence
 * saying what the resource physically is.
 *
 * The second trap is what the specification does not contain. The item schema
 * carries no reference to the rack it sits in — there is no `rack_storage_id`
 * field anywhere in the API, and no list filter scopes items to a rack — so
 * "what is mounted in rack 12?" has no documented answer here. Article IV
 * forbids closing that gap with a guess, so the tools state it instead: the
 * `rack_storage_role_id` field is documented as a *role*, and is described as
 * one, rather than being presented as the missing rack link.
 */

import { z } from 'zod';

import { buildResourceTools, type ResourceSpec } from './resource.js';
import type { ToolDefinition } from './define.js';

const timestampRangeDescription =
  'ISO-8601 range as "start,end". Either side may be omitted — "2026-01-01T00:00:00Z," means ' +
  'everything since that moment, ",2026-01-01T00:00:00Z" everything before it. A bare ' +
  'timestamp with no comma matches that exact moment.';

/** Neither rack collection documents `page` or `page_size` (spec-defects C2). */
const noPagingNote =
  'This endpoint documents neither `page` nor `page_size`, so this tool sends neither and Hudu ' +
  'answers with everything matching in one response. The envelope reports `page_was_full: ' +
  'false` and `next_page: null` accordingly — there is no second page to ask for, and what you ' +
  'get back is the complete set for the filters given. If the result comes back marked ' +
  '`truncated`, that is this server trimming the response to fit its output budget, not the ' +
  'end of the data; narrow the filters or use `fields` to see the rest.\n\n' +
  'Sending them anyway is not a harmless no-op: Hudu rejects a query parameter an endpoint ' +
  'does not document rather than ignoring it — `GET /networks?page=1` answers 400 "page is not ' +
  'a valid filter parameter" on 2.34.2 — so an undocumented parameter fails the whole call.';

const undocumentedUnitNote =
  'Hudu states no unit for this number, so it is comparable with other values from the same ' +
  'instance and with nothing else.';

/**
 * Everything a caller needs to know before writing a unit position, said once.
 *
 * Both ends of the range need the whole warning: a caller who reads only
 * `end_unit` is exactly the caller who is about to assume the range is
 * exclusive.
 */
const unitRangeNote =
  'Two properties of this range are not documented, and assuming either will place hardware ' +
  'in the wrong slot. First, direction: the API never says which physical end of the cabinet ' +
  'holds the lowest-numbered unit, so bottom-up and top-down are equally consistent with the ' +
  'spec. Second, inclusivity: it does not say whether a 2U device starting at unit 10 ends at ' +
  '11 or at 12. Read an existing item from the same rack with hudu_list_rack_storage_items, ' +
  'compare it against hardware whose height you already know, and follow whatever convention ' +
  'that instance uses. Overlap is undocumented too — no conflict response is published for ' +
  'these endpoints, and create and update document only 422 "Unable to process request" — so ' +
  'do not rely on Hudu refusing to double-book a unit.';

const rackWritableFields = {
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Name of the rack as a person would refer to it, e.g. "DC1 Row A Cabinet 3".'),
  description: z.string().optional().describe('Free-text description of the rack.'),
  company_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the company that owns this rack. Resolve a customer name to an id with ' +
        'hudu_list_companies first.',
    ),
  location_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the location the rack physically stands in. This API publishes no ' +
        'locations endpoint at all, so there is nothing to look the id up in — take it from an ' +
        'existing rack at the same site via hudu_list_rack_storages.',
    ),
  height: z
    .number()
    .int()
    .optional()
    .describe(
      'How tall the rack is. The spec says only "the height of the rack storage" and gives no ' +
        'unit; rack height is conventionally a count of rack units, but the API does not ' +
        'confirm that. Read an existing rack and compare it against known hardware before ' +
        'trusting the interpretation.',
    ),
  width: z.number().int().optional().describe(`How wide the rack is. ${undocumentedUnitNote}`),
  starting_unit: z
    .number()
    .int()
    .optional()
    .describe(
      "The number this rack's own unit numbering begins at, which is why an item's start_unit " +
        'is not necessarily 1-based. The spec documents nothing further — not which physical ' +
        'end of the cabinet that unit is, and not what Hudu uses when the field is omitted.',
    ),
  max_wattage: z
    .number()
    .int()
    .optional()
    .describe(
      'Power the rack is documented as being able to handle. The spec names the quantity ' +
        '("the maximum wattage the rack storage can handle") but never states the unit, so ' +
        'whether it is watts or kilowatts is not published — match an existing rack rather ' +
        'than converting. Compare it against the `power_draw` of the items mounted inside; ' +
        'Hudu documents no automatic check of one against the other.',
    ),
};

export const rackStoragesSpec: ResourceSpec = {
  key: 'rack_storages',
  singular: 'rack_storage',
  title: 'Rack Storage',
  titlePlural: 'Rack Storages',
  basePath: '/rack_storages',
  summary:
    'A rack storage is a physical rack — a cabinet in a server room — owned by a company and ' +
    'standing at a location, with a height, a width, a starting unit number and a maximum ' +
    'wattage. It is the container only: the equipment mounted in it is modelled separately as ' +
    'rack storage items, via the hudu_*_rack_storage_item tools.',
  listNotes:
    "Filter by `company_id` for one customer's racks and `location_id` for one site. `height`, " +
    '`min_width` and `max_width` filter on the rack dimensions, whose units the API never ' +
    'states — they are still usable for relative comparison against values already in the ' +
    'instance.\n\n' +
    'No name or free-text search filter is documented. To find a rack by name, list the ' +
    "company's racks and match the `name` field yourself.\n\n" +
    noPagingNote,
  paginated: false,
  filters: {
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only racks belonging to this company, by numeric Hudu company id.'),
    location_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Return only racks at this location. No endpoint lists locations, so this id has to ' +
          'come from a rack you have already read.',
      ),
    height: z
      .number()
      .int()
      .optional()
      .describe('Return only racks whose height equals this value exactly. Unit undocumented.'),
    min_width: z
      .number()
      .int()
      .optional()
      .describe('Return only racks at least this wide. Unit undocumented.'),
    max_width: z
      .number()
      .int()
      .optional()
      .describe('Return only racks at most this wide. Unit undocumented.'),
    created_at: z.string().optional().describe(timestampRangeDescription),
    updated_at: z.string().optional().describe(timestampRangeDescription),
  },
  // Mirrors hudu_create_company: the API marks nothing required, but a rack with
  // no name cannot be picked out of a list by the person who has to find it.
  create: { bodyKey: 'rack_storage', fields: { ...rackWritableFields, name: z.string().min(1) } },
  update: { bodyKey: 'rack_storage', fields: rackWritableFields },
  deletable: true,
  deleteImpact:
    'Deletes the rack. What becomes of the rack storage items mounted in it is not documented ' +
    '— whether Hudu removes them with the rack or leaves them orphaned is unpublished, so deal ' +
    'with them deliberately first if it matters. Rack records carry a `discarded_at` ' +
    'timestamp, which suggests Hudu soft-deletes internally, but no archive or restore ' +
    'endpoint is documented for racks, so nothing here is recoverable through this API.',
};

const rackItemWritableFields = {
  rack_storage_role_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the "rack storage role" this item takes. Read this carefully: it is NOT ' +
        'the rack the item sits in. The spec documents it as "the unique ID of the rack ' +
        'storage role", and the item record echoes rack_storage_role_name, ' +
        'rack_storage_role_description and rack_storage_role_hex_color beside it, so a role ' +
        'behaves as a named, colour-coded classification of the mounted thing. No endpoint ' +
        'lists the available roles and no schema defines one, so take an id from an existing ' +
        'item via hudu_list_rack_storage_items rather than expecting to look one up.',
    ),
  asset_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the Hudu asset this mounted item represents — the device record carrying ' +
        'the serial, model and custom fields. Resolve it with hudu_list_assets, or read it ' +
        'with hudu_get_asset. The item record also returns asset_name and asset_url for ' +
        'display; those are outputs, not ways to identify the asset when writing.',
    ),
  start_unit: z
    .number()
    .int()
    .optional()
    .describe(
      "One end of the unit range this item occupies, in the rack's own numbering, which " +
        "begins at that rack's `starting_unit` and so is not necessarily 1-based. " +
        unitRangeNote,
    ),
  end_unit: z
    .number()
    .int()
    .optional()
    .describe(`The other end of the unit range this item occupies. ${unitRangeNote}`),
  side: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Which face of the rack the item is mounted on, as a lower-case string. The spec ' +
        'contradicts itself here (B7): the list filter types it as the string "Front" or ' +
        '"Rear" while the create and update body types it as an integer with no published ' +
        'mapping. Observation settles it — a live Hudu 2.34.2 instance stores "front", "rear" ' +
        'and "both", lower-cased strings, so the integer typing in the body schema is ' +
        'contradicted by the API itself and this argument takes a string. "both" appears in no ' +
        'Hudu documentation at all and is how a full-depth device is recorded. Read an ' +
        'existing item with hudu_get_rack_storage_item if your instance disagrees.',
    ),
  status: z
    .string()
    .min(1)
    .optional()
    .describe(
      'State of the mounted item, as a string. The spec types this as an integer and publishes ' +
        'no meaning for any value (D2); a live Hudu 2.34.2 instance returned the strings ' +
        '"reserved" and "used", so the documented integer is contradicted by observation the ' +
        'same way `side` is. Those two are the only values seen and Hudu names no others, so ' +
        'copy what an existing item on your instance uses rather than inventing a state. Send ' +
        'a numeric value as a string if your instance turns out to use one.',
    ),
  reserved_message: z
    .string()
    .optional()
    .describe(
      'Free-text message carried on the item. The spec documents it only as "the reserved ' +
        'message for the rack storage item" and says neither when Hudu displays it nor what ' +
        'marks an item as reserved.',
    ),
  max_wattage: z
    .number()
    .int()
    .optional()
    .describe(
      'Power ceiling recorded for this mounted item. As with the rack field of the same name, ' +
        `the spec names the quantity as wattage but never states the unit. ${undocumentedUnitNote}`,
    ),
  power_draw: z
    .number()
    .int()
    .optional()
    .describe(
      "Power this item draws, for planning against the rack's `max_wattage`. The spec gives " +
        `no unit for it at all. ${undocumentedUnitNote}`,
    ),
  company_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the company this item belongs to. Note that the list tool documents no ' +
        'company filter, so this scopes the record without giving you a way to select on it ' +
        'later.',
    ),
};

export const rackStorageItemsSpec: ResourceSpec = {
  key: 'rack_storage_items',
  singular: 'rack_storage_item',
  title: 'Rack Storage Item',
  titlePlural: 'Rack Storage Items',
  basePath: '/rack_storage_items',
  summary:
    'A rack storage item is one thing mounted in a rack: it points at the Hudu asset it ' +
    'represents, occupies the units from `start_unit` to `end_unit` on one `side` of the rack, ' +
    'and carries its own power figures. The rack itself is a rack storage — use the ' +
    'hudu_*_rack_storage tools for the cabinet.',
  listNotes:
    'Read this before answering a question about a specific rack: the API documents no way to ' +
    'list the items in one. The item schema has no rack field, and none of the filters scope ' +
    'to a rack — `rack_storage_role_id` filters by role, which is a classification, not the ' +
    'cabinet. The documented filters are role, asset, start_unit, end_unit, status, side and ' +
    'the two timestamps, all of them instance-wide. If you are asked what is in rack 12, say ' +
    "this API does not expose it rather than presenting an unscoped list as that rack's " +
    'contents. It is worth reading one record with hudu_get_rack_storage_item to see whether ' +
    'your Hudu version returns a rack reference the published schema omits, but do not assume ' +
    'one is there.\n\n' +
    'To go the other way — from a device to where it is racked — filter by `asset_id`, which ' +
    'is the one filter that ties an item to something you can identify elsewhere in Hudu.\n\n' +
    noPagingNote,
  paginated: false,
  titleField: 'asset_name',
  filters: {
    rack_storage_role_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Return only items holding this rack storage role. A role is a classification of the ' +
          'mounted item, not the rack it is in — this does not list the contents of a rack.',
      ),
    asset_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Return only items representing this Hudu asset, by numeric asset id from ' +
          'hudu_list_assets. This is how you find where a known device is racked.',
      ),
    start_unit: z
      .number()
      .int()
      .optional()
      .describe('Return only items whose start unit equals this value exactly.'),
    end_unit: z
      .number()
      .int()
      .optional()
      .describe('Return only items whose end unit equals this value exactly.'),
    status: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Return only items in this state. The filter is documented as an integer and no legal ' +
          'values are published (D2), but a live Hudu 2.34.2 instance stores the strings ' +
          '"reserved" and "used" — so this takes a string and passes it through verbatim. Read ' +
          'the values your instance uses from an unfiltered hudu_list_rack_storage_items first.',
      ),
    side: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Return only items mounted on this face. The filter is documented as "Front" or ' +
          '"Rear"; a live Hudu 2.34.2 instance stores "front", "rear" and "both", lower-cased. ' +
          'Match the casing your instance returns rather than the documented capitalisation, ' +
          'and note that "both" is undocumented but real.',
      ),
    created_at: z.string().optional().describe(timestampRangeDescription),
    updated_at: z.string().optional().describe(timestampRangeDescription),
  },
  // No field is required here, unlike racks: the API marks none, and
  // `reserved_message` implies items that hold space without an asset, so
  // demanding an asset_id would block a legitimate use.
  create: { bodyKey: 'rack_storage_item', fields: rackItemWritableFields },
  update: { bodyKey: 'rack_storage_item', fields: rackItemWritableFields },
  deletable: true,
  deleteImpact:
    'Removes the mounting record and frees the units it occupied. The Hudu asset it pointed at ' +
    'is untouched — this unmounts a device from a rack, it does not delete the device. Use ' +
    'hudu_delete_asset for that.',
};

export function rackTools(): ToolDefinition[] {
  return [...buildResourceTools(rackStoragesSpec), ...buildResourceTools(rackStorageItemsSpec)];
}
