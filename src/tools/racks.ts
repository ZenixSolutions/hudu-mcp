/**
 * Rack storages and rack storage items.
 *
 * Hudu's physical model of a server room. A *rack storage* is a rack — a
 * cabinet — and a *rack storage item* is one thing mounted inside it. The
 * vocabulary is the first trap: "storage" here has nothing to do with disks,
 * volumes or shares, so every description below spends its opening sentence
 * saying what the resource physically is.
 *
 * The second thing to know is where a rack's contents are, because the captured
 * contract hides it. `GET /rack_storages` and `GET /rack_storages/{id}` both
 * return `front_items` and `rear_items` on every rack: one entry per rack unit
 * per face, each entry carrying whatever is mounted at that unit, with
 * `asset_id` and `asset_name` on it. That is a complete per-unit elevation, and
 * it answers "what is mounted in rack 12?" directly — call
 * hudu_get_rack_storage and read the record.
 *
 * These descriptions used to say the opposite, at length, and
 * hudu_list_rack_storage_items told callers to refuse the question. The reason
 * is worth keeping in view: the `RackStorage` definition in
 * docs/reference/api-docs.json lists twelve scalar properties and declares no
 * arrays at all, so reading the schema produces exactly the wrong answer. The
 * reasoning also started from the wrong record — every true premise it used was
 * about `RackStorageItem`, and the link lives on the rack, not on the item. See
 * spec-defects.md C4, rewritten as a correction, and F8 for the observed shape.
 *
 * What is still true is the item→rack direction: a rack storage item carries no
 * `rack_storage_id`, no list filter scopes items to a rack, and
 * `rack_storage_role_id` is a colour-coded *role* rather than the cabinet — so
 * the instance-wide item list cannot be grouped by rack, and is described here
 * as what it is rather than as a rack listing.
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
 * The per-unit elevation, described concretely enough to be read without guessing.
 *
 * Said once and attached to the rack `summary`, so it reaches the list, get,
 * create and update descriptions alike — every one of those tools returns a
 * rack record, and this is the part of that record no schema declares.
 */
const elevationNote =
  'A rack record also carries its own contents. `front_items` and `rear_items` are arrays with ' +
  'one entry per rack unit — the front face and the rear face of the same cabinet — and each ' +
  'entry is a slot: `number` is the unit number, `has_items` says whether anything is mounted ' +
  'there, `is_reserved` and `reserved_messsage` describe a held slot, and `items` is the array ' +
  'of things mounted at that unit. Each entry in `items` carries `id`, `side`, `status`, ' +
  '`asset_id`, `asset_name`, `asset_url`, `reserved_message` and the three ' +
  '`rack_storage_role_*` display fields. Reading `front_items` and `rear_items` off one rack ' +
  'record is the way to answer "what is in rack 12?", and it is enough to lay the cabinet out ' +
  'unit by unit.\n\n' +
  '`asset_id` on a mounted item is the link onward: pass it to hudu_get_asset for the device ' +
  'record with its serial, model and custom fields, or to hudu_list_assets to resolve names.\n\n' +
  'Two spellings of one field are real and are passed through exactly as Hudu sends them: the ' +
  "slot uses `reserved_messsage`, with three s's, while the mounted item inside it uses " +
  '`reserved_message`, with two. This client does not normalise either, so read the key that ' +
  'is actually on the object you are looking at rather than the one you expect.\n\n' +
  'The elevation is in no published schema: the `RackStorage` definition lists scalar ' +
  'properties only and declares no arrays, so `front_items`, `rear_items` and the slot shape ' +
  'above are reported from a live Hudu 2.34.2 instance rather than from the contract ' +
  '(docs/reference/spec-defects.md C4 and F8). Read the elevation off the record you were ' +
  'given rather than assuming this shape holds on another version.';

/**
 * Fields the live rack record carries that the `RackStorage` definition omits.
 *
 * Named without meanings attached: what they contain was observed, what they
 * mean is unpublished, and inventing the second from the first is the mistake
 * that produced C4.
 */
const undocumentedRackFieldsNote =
  'A live 2.34.2 rack record carries several more fields the contract does not define at all: ' +
  '`descending_units`, `utilization`, `power_draw_utilization`, `power_utilization`, ' +
  '`serial_number`, `asset_tag`, `location_name` and `location_url`. Hudu publishes no meaning, ' +
  'type or value set for any of them, so treat each as a value to read rather than one to ' +
  'interpret. `location_name` and `location_url` are the useful pair in practice: this API ' +
  'exposes no locations endpoint (C5), and they name the location that `location_id` points ' +
  'at without one.';

/**
 * Everything a caller needs to know before writing a unit position, said once.
 *
 * Both ends of the range need the whole warning: a caller who reads only
 * `end_unit` is exactly the caller who is about to assume the range is
 * exclusive.
 */
const unitRangeNote =
  'Two properties of this range are not documented, and assuming either will place hardware ' +
  'in the wrong slot. First, direction: the contract never says which physical end of the ' +
  'cabinet holds the lowest-numbered unit, so bottom-up and top-down are equally consistent ' +
  'with it. Second, inclusivity: it does not say whether a 2U device starting at unit 10 ends ' +
  'at 11 or at 12. Settle both against the rack itself rather than against a convention — ' +
  'call hudu_get_rack_storage and read `front_items`/`rear_items`, which lay the cabinet out ' +
  'one slot per unit and show where existing hardware of a height you already know actually ' +
  'sits. That same record carries an undocumented `descending_units` field whose name points ' +
  'at the direction question; Hudu publishes nothing about it, and this server has not ' +
  'established what it contains or which way round it reads, so use it as a hint to check ' +
  'against the elevation rather than as an answer. Overlap is undocumented too — no conflict ' +
  'response is published for these endpoints, and create and update document only 422 "Unable ' +
  'to process request" — so do not rely on Hudu refusing to double-book a unit.';

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
        'existing rack at the same site via hudu_list_rack_storages. Live rack records echo ' +
        'an undocumented `location_name` and `location_url` beside the id, which is how you ' +
        'tell which site an id refers to without a locations collection.',
    ),
  height: z
    .number()
    .int()
    .optional()
    .describe(
      'How tall the rack is. The spec says only "the height of the rack storage" and gives no ' +
        'unit; rack height is conventionally a count of rack units, but the API does not ' +
        'confirm that. Read an existing rack with hudu_get_rack_storage and compare `height` ' +
        "against the number of slots in that record's `front_items` — the elevation has one " +
        'entry per unit, so the two are directly comparable on your own instance — before ' +
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
    'wattage. Equipment mounted in it is also modelled separately, as rack storage items ' +
    'reachable through the hudu_*_rack_storage_item tools, but you do not need those to see ' +
    "one rack's contents.\n\n" +
    `${elevationNote}\n\n${undocumentedRackFieldsNote}`,
  listNotes:
    "Filter by `company_id` for one customer's racks and `location_id` for one site. `height`, " +
    '`min_width` and `max_width` filter on the rack dimensions, whose units the API never ' +
    'states — they are still usable for relative comparison against values already in the ' +
    'instance.\n\n' +
    'No name or free-text search filter is documented. To find a rack by name, list the ' +
    "company's racks and match the `name` field yourself.\n\n" +
    'Every rack in this list carries its full `front_items`/`rear_items` elevation, so an ' +
    'unfiltered list of a large estate is a large response and is the case most likely to be ' +
    'cut by the output budget — and a budget cut here drops whole racks, not slots. When you ' +
    'want the inventory of cabinets rather than their contents, pass `fields` without the two ' +
    'item arrays, e.g. ["id","name","company_id","location_name","height"]. When you want one ' +
    "rack's contents, call hudu_get_rack_storage with its id instead: that record is returned " +
    'whole, with the elevation intact.\n\n' +
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
    'with them deliberately first if it matters. Read the rack with hudu_get_rack_storage ' +
    'before deleting it: `front_items` and `rear_items` are a per-unit record of exactly what ' +
    'was mounted, and after the delete there is no way to reconstruct it. Rack records carry a `discarded_at` ' +
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
    "hudu_*_rack_storage tools for the cabinet, and hudu_get_rack_storage for one rack's " +
    'contents, which arrive on the rack record as a per-unit elevation.',
  listNotes:
    'To see what is in a particular rack, use hudu_get_rack_storage, not this tool. That ' +
    'record carries `front_items` and `rear_items` — one slot per rack unit on each face, ' +
    'each slot listing the items mounted there with their `asset_id` and `asset_name` — which ' +
    'is a direct, complete answer to "what is in rack 12?".\n\n' +
    'This tool is the instance-wide view of mounted items: every rack storage item on the ' +
    'instance, optionally filtered by `asset_id`, `status`, `side`, `start_unit`, `end_unit`, ' +
    '`rack_storage_role_id` or the two timestamps. Its best use is "where is asset X mounted?" ' +
    '— filter by `asset_id` and read the unit range and side off the result. It is also how ' +
    'you survey one class of mounting across the estate, e.g. every item whose `status` is ' +
    '"reserved".\n\n' +
    'What it cannot do is group its own results by cabinet. A rack storage item carries no ' +
    'rack id — `rack_storage_id` appears nowhere in this API — and no filter scopes items to a ' +
    'rack; `rack_storage_role_id` is a colour-coded role, a classification of the mounted ' +
    'thing, not the cabinet it sits in. So an unfiltered list here is a flat instance-wide set ' +
    "with no cabinet on it, and it must never be presented as one rack's contents. When you " +
    'need the rack an item belongs to, work from the rack side: list racks with ' +
    'hudu_list_rack_storages and look for the `asset_id` in their elevations.\n\n' +
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
        'Return only items holding this rack storage role. A role is a colour-coded ' +
          'classification of the mounted item, not the rack it is in — filtering on it selects ' +
          "a kind of mounting across every cabinet. For one rack's contents, call " +
          'hudu_get_rack_storage and read the elevation on the record.',
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
