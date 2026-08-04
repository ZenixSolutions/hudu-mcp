/**
 * Rack tools: the elevation survives, and no description tells a caller to refuse.
 *
 * Both halves of this file exist because of one defect. `spec-defects.md` C4
 * concluded, from the `RackStorage` definition declaring twelve scalar
 * properties and no arrays, that a rack's contents could not be listed — and
 * `hudu_list_rack_storage_items` went on to instruct callers to *say this API
 * does not expose it*. Live Hudu 2.34.2 returns a complete per-unit elevation on
 * every rack record (C4 as rewritten, F8), so the instruction talked a reader
 * out of a question the API answers in one call.
 *
 * The first test pins the data path: an elevation that arrives from Hudu has to
 * reach the tool result intact, nested arrays and Hudu's own misspelled
 * `reserved_messsage` included. The second pins the wording, because the defect
 * was never in the code — it was in a string, and a string regresses silently.
 */

import { describe, expect, it } from 'vitest';

import { testServer, toolJson } from '../helpers/fixtures.js';

/**
 * A rack as Hudu 2.34.2 really returns it, trimmed to one unit.
 *
 * The two spellings are deliberate and are not a typo in this file: the slot
 * carries `reserved_messsage` with three s's, the item nested inside it carries
 * `reserved_message` with two. Both occur in the same response and this server
 * normalises neither (F8).
 */
const rackWithElevation = (): Record<string, unknown> => ({
  id: 12,
  name: 'DC1 Row A Cabinet 3',
  company_id: 3,
  location_id: 4,
  location_name: 'Leeds DC1',
  location_url: '/l/leeds-dc1',
  height: 42,
  width: 19,
  starting_unit: 1,
  descending_units: false,
  max_wattage: 5000,
  utilization: 12.5,
  power_draw_utilization: 4.2,
  power_utilization: 3.1,
  serial_number: 'RK-0001',
  asset_tag: 'ZS-RK-12',
  front_items: [
    {
      is_reserved: false,
      reserved_messsage: '',
      has_items: true,
      number: 1,
      items: [
        {
          id: 92,
          side: 'front',
          status: 'used',
          asset_id: 231,
          asset_name: 'Fortigate-40F',
          asset_url: '/a/3cbcff',
          reserved_message: '',
          rack_storage_role_name: null,
          rack_storage_role_description: null,
          rack_storage_role_hex_color: null,
        },
      ],
    },
    {
      is_reserved: true,
      reserved_messsage: 'Held for switch',
      has_items: false,
      number: 2,
      items: [],
    },
  ],
  rear_items: [
    { is_reserved: false, reserved_messsage: '', has_items: false, number: 1, items: [] },
  ],
});

describe('hudu_get_rack_storage returns the rack elevation', () => {
  it('passes front_items through to the tool result unchanged', async () => {
    const rack = rackWithElevation();
    const server = testServer({ json: rack });

    const result = toolJson(await server.call('hudu_get_rack_storage', { id: 12 })) as Record<
      string,
      unknown
    >;

    expect(server.http.last().path).toBe('/api/v1/rack_storages/12');

    // The whole elevation, not a field-by-field spot check: the failure this
    // guards against is a layer quietly dropping or reshaping nested arrays.
    expect(
      result['front_items'],
      'the per-unit elevation is the answer to "what is in rack 12?" and must reach the caller ' +
        'exactly as Hudu sent it',
    ).toEqual(rack['front_items']);
    expect(result['rear_items']).toEqual(rack['rear_items']);

    const slot = (result['front_items'] as Record<string, unknown>[])[0]!;
    const mounted = (slot['items'] as Record<string, unknown>[])[0]!;

    expect(slot['number']).toBe(1);
    expect(slot['has_items']).toBe(true);
    // Hudu's spelling, three s's at slot level and two on the nested item.
    // Normalising either would hide a vendor defect and break on a fix upstream.
    expect(Object.keys(slot)).toContain('reserved_messsage');
    expect(Object.keys(mounted)).toContain('reserved_message');

    // The link onward to the asset tools, which the descriptions point at.
    expect(mounted['asset_id']).toBe(231);
    expect(mounted['asset_name']).toBe('Fortigate-40F');
  });

  it('keeps the elevation when a rack arrives through the list tool', async () => {
    const rack = rackWithElevation();
    const server = testServer({ json: [rack] });

    const result = toolJson(await server.call('hudu_list_rack_storages', {})) as Record<
      string,
      unknown
    >;
    const items = result['items'] as Record<string, unknown>[];

    expect(items[0]?.['front_items']).toEqual(rack['front_items']);
  });

  it('keeps the undocumented rack fields the contract omits', async () => {
    const server = testServer({ json: rackWithElevation() });

    const result = toolJson(await server.call('hudu_get_rack_storage', { id: 12 })) as Record<
      string,
      unknown
    >;

    // F8. None of these is in the `RackStorage` definition; dropping them to
    // match the schema would be the same mistake C4 made, in the other
    // direction.
    for (const field of [
      'descending_units',
      'utilization',
      'power_draw_utilization',
      'power_utilization',
      'serial_number',
      'asset_tag',
      'location_name',
      'location_url',
    ]) {
      expect(Object.keys(result), `${field} was dropped from the rack record`).toContain(field);
    }
  });
});

describe('no rack tool description instructs a refusal', () => {
  const server = testServer(
    { json: {} },
    { allowDestructive: true, allowExports: true, allowPasswordReveal: true },
  );
  const rackTools = server.built.tools.filter((tool) => tool.name.includes('rack'));

  it('registers the rack tools this file is about', () => {
    expect(rackTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'hudu_list_rack_storages',
        'hudu_get_rack_storage',
        'hudu_list_rack_storage_items',
        'hudu_get_rack_storage_item',
      ]),
    );
  });

  /**
   * Wording that either states the corrected claim or tells a caller to decline.
   *
   * A string check rather than a semantic one, deliberately: the exact sentence
   * that caused the incident was "say this API does not expose it", and the
   * cheapest way to keep it from returning is to name it.
   */
  const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
    [/does not expose/i, 'C4 was corrected: the rack record does expose its contents (F8)'],
    [/rather than presenting an unscoped list/i, 'the refusal instruction removed after C4'],
    [
      /(rack'?s? contents|contents of (?:a|the) rack)[^.]{0,80}cannot be listed/i,
      'a rack’s contents can be listed, from front_items/rear_items on the rack record',
    ],
    [
      /no (?:documented )?way to list the items in one/i,
      'hudu_get_rack_storage is the documented-by-observation way to list them',
    ],
    [
      /not answerable|has no documented answer/i,
      '"what is in rack 12?" is answerable and must not be described as unanswerable',
    ],
  ];

  it.each(FORBIDDEN.map(([pattern, why]) => [pattern.source, pattern, why] as const))(
    'no rack description matches /%s/',
    (_source, pattern, why) => {
      const offenders = rackTools
        .filter((tool) => pattern.test(tool.description))
        .map((tool) => tool.name);

      expect(
        offenders,
        `${offenders.join(', ')} tells a caller something that is false: ${why}. This is the ` +
          'regression this test exists for — the original defect was a tool description, and ' +
          'it cost a reviewer an answerable question.',
      ).toEqual([]);
    },
  );

  it('points the item list tool at the rack record instead', () => {
    const items = server.tool('hudu_list_rack_storage_items').description;

    expect(items).toContain('hudu_get_rack_storage');
    expect(items).toContain('front_items');
    // Still honest about the half of C4 that survived.
    expect(items).toContain('rack_storage_id');
  });

  it('describes the slot shape on both rack read tools', () => {
    for (const name of ['hudu_get_rack_storage', 'hudu_list_rack_storages']) {
      const description = server.tool(name).description;
      for (const fragment of ['front_items', 'rear_items', 'asset_id', 'has_items', 'number']) {
        expect(description, `${name} does not describe ${fragment}`).toContain(fragment);
      }
    }
  });
});
