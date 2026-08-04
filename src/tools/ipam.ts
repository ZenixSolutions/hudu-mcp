/**
 * IP address management: networks and the addresses inside them.
 *
 * These two resources are one subject and are read together in practice — "what
 * is 10.20.0.14?" starts at the address and ends at the asset, "what is left in
 * the guest VLAN?" starts at the network. They therefore share a module and
 * name each other in their descriptions.
 *
 * The property that shapes everything here is that neither list endpoint
 * documents `page` or `page_size`. Both are `paginated: false`, which means
 * every call returns the whole filtered collection in one response. That is
 * harmless for networks and dangerous for addresses, so the list descriptions
 * push the caller towards filtering rather than fetching.
 */

import { z } from 'zod';

import type { ToolDefinition } from './define.js';
import { buildResourceTools, type ResourceSpec } from './resource.js';

const timestampRangeDescription =
  'ISO-8601 range as "start,end". Either side may be omitted — "2026-01-01T00:00:00Z," means ' +
  'everything since that moment, ",2026-01-01T00:00:00Z" everything before it. A bare ' +
  'timestamp with no comma matches that exact moment.';

/**
 * Repeated verbatim on both lists.
 *
 * `applyCharacterBudget` will silently halve an oversized response, and with no
 * `page` parameter to advance there is no way to reach what it cut. A caller who
 * does not know that reads a truncated list as the whole answer.
 */
const noPagingNote =
  'This endpoint documents neither `page` nor `page_size`, so there is no paging: the call ' +
  'returns everything matching your filters in a single response. If `truncated` comes back ' +
  'true the client cut records to stay inside its response budget, and because there is no ' +
  'next page the only ways to see the rest are narrower filters or a shorter `fields` list.';

const networkTypeDescription =
  'Network type, as an integer. Hudu does not publish what each number means, and the mapping ' +
  'is not derivable from the API — read an existing network on this instance with ' +
  'hudu_list_networks to see which values are in use before setting one.';

const locationIdDescription =
  'Numeric id of the Hudu location this network serves, for tenants that split a company ' +
  'across sites. The v1 API exposes no locations endpoint, so this server cannot list or ' +
  'resolve location ids; read an existing network at the same site to find the value.';

const networkWritableFields = {
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Name of the network as people refer to it, e.g. "Head Office LAN" or "Guest WiFi".'),
  address: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The network as a CIDR block — the whole range, not one host. "10.20.0.0/24", ' +
        '"192.168.1.0/24", "2001:db8::/64". A single address belongs on an ip_address record ' +
        'instead; see hudu_create_ip_address.',
    ),
  network_type: z.number().int().optional().describe(networkTypeDescription),
  company_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the company that owns this network. Resolve a customer name to an id with ' +
        'hudu_list_companies first.',
    ),
  location_id: z.number().int().positive().optional().describe(locationIdDescription),
  description: z
    .string()
    .optional()
    .describe('Free-text notes about the network — its purpose, VLAN, gateway, whatever helps.'),
};

export const networksSpec: ResourceSpec = {
  key: 'networks',
  singular: 'network',
  title: 'Network',
  titlePlural: 'Networks',
  basePath: '/networks',
  summary:
    'A network is one IP range documented in Hudu — a subnet in CIDR form, owned by a company, ' +
    'holding the individual ip_address records allocated inside it.',
  listNotes:
    `${noPagingNote}\n\n` +
    'Filter by `company_id` when you are working for one customer; instances that document ' +
    'every client hold networks for all of them here. `address` matches the stored CIDR text, ' +
    'so it finds a subnet you already know the notation of rather than telling you which ' +
    'network a given host falls in — Hudu does not offer containment search. To see what is ' +
    'allocated inside a network, call hudu_list_ip_addresses with `network_id` set.',
  paginated: false,
  filters: {
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only networks owned by this company. The most useful filter here.'),
    name: z.string().optional().describe('Match against the network name.'),
    address: z
      .string()
      .optional()
      .describe('Match against the stored CIDR text, e.g. "10.20.0.0/24".'),
    network_type: z.number().int().optional().describe(networkTypeDescription),
    location_id: z.number().int().positive().optional().describe(locationIdDescription),
    slug: z.string().optional().describe('URL slug, if you already know it.'),
    created_at: z.string().optional().describe(timestampRangeDescription),
    updated_at: z.string().optional().describe(timestampRangeDescription),
  },
  create: {
    bodyKey: 'network',
    fields: {
      ...networkWritableFields,
      name: z.string().min(1).describe('Name of the network, e.g. "Head Office LAN".'),
      address: z
        .string()
        .min(1)
        .describe(
          'The network as a CIDR block, e.g. "10.20.0.0/24". This is the range itself; ' +
            'individual hosts are separate ip_address records created with ' +
            'hudu_create_ip_address.',
        ),
    },
  },
  update: { bodyKey: 'network', fields: networkWritableFields },
  deletable: true,
  deleteImpact:
    'Removes the network record. What happens to the ip_address records inside it is NOT ' +
    'documented by Hudu: they may be deleted along with the network, or left behind pointing ' +
    'at a network_id that no longer resolves. This server cannot tell which, and neither ' +
    'outcome is undoable. Before deleting, list the contents with hudu_list_ip_addresses ' +
    '(network_id set) so you can tell the user what is at stake and can re-check afterwards ' +
    'what actually survived.',
};

/**
 * The status vocabulary is documented in the IpAddress schema's prose — "Must be
 * one of: unassigned, assigned, reserved, deprecated, dhcp, or slaac" — and not
 * as a JSON Schema `enum`. It is enforced on the write bodies, which is where
 * that sentence applies, and left as free text on the list filter, whose query
 * parameter the spec types as a plain string. Enforcing it on the filter too
 * would be this client legislating past the spec on an endpoint that costs
 * nothing to get wrong.
 */
const IP_STATUSES = ['unassigned', 'assigned', 'reserved', 'deprecated', 'dhcp', 'slaac'] as const;

const statusWriteDescription =
  'Allocation state of the address. "assigned" means a host is using it, "reserved" means it ' +
  'is held back from allocation, "unassigned" means it is free, "deprecated" means it is on ' +
  'its way out, and "dhcp" and "slaac" mean it is handed out dynamically rather than set on ' +
  'the device. These six are the values Hudu documents.';

const statusFilterDescription =
  'Return only addresses in this state. Hudu documents six: "unassigned", "assigned", ' +
  '"reserved", "deprecated", "dhcp", "slaac". The filter itself is typed as free text, so a ' +
  'value your instance uses but Hudu has not documented will still be passed through.';

const fqdnDescription =
  'Fully qualified domain name for this address, e.g. "dc01.corp.example.com". Hudu stores ' +
  'whatever you write and does not resolve or verify it against DNS, so treat a value here as ' +
  'documentation rather than as evidence the record is current.';

const assetIdDescription =
  'Numeric id of the asset that holds this address — the server, firewall or printer it is ' +
  'configured on. This is the join that answers "what is on 10.20.0.14?". Find the id with ' +
  'hudu_list_assets (its `search` filter takes a hostname); note that hudu_get_asset needs the ' +
  "asset's company_id as well, which hudu_list_assets returns.";

const ipCompanyIdDescription =
  'Numeric id of the company this address is documented for. Resolve a customer name with ' +
  'hudu_list_companies. Setting it consistently with the parent network is what keeps a ' +
  'company-scoped IPAM view complete.';

const networkIdDescription =
  'Numeric id of the network this address belongs to. Find it with hudu_list_networks — Hudu ' +
  'does not infer the network from the address, so an address created without this is not ' +
  'linked to its subnet.';

const ipWritableFields = {
  address: z
    .string()
    .min(1)
    .optional()
    .describe(
      'One IP address, not a range — "10.20.0.14" or "2001:db8::14". A CIDR block belongs on a ' +
        'network record instead; see hudu_create_network.',
    ),
  status: z.enum(IP_STATUSES).optional().describe(statusWriteDescription),
  fqdn: z.string().optional().describe(fqdnDescription),
  description: z.string().optional().describe('Short description of what this address is for.'),
  comments: z.string().optional().describe('Longer free-text notes about the address.'),
  asset_id: z.number().int().positive().optional().describe(assetIdDescription),
  network_id: z.number().int().positive().optional().describe(networkIdDescription),
  company_id: z.number().int().positive().optional().describe(ipCompanyIdDescription),
};

export const ipAddressesSpec: ResourceSpec = {
  key: 'ip_addresses',
  singular: 'ip_address',
  title: 'IP Address',
  titlePlural: 'IP Addresses',
  basePath: '/ip_addresses',
  titleField: 'address',
  summary:
    'An ip_address record documents one address: its allocation status, its FQDN, the network ' +
    'it sits in and the asset it is configured on.',
  listNotes:
    `${noPagingNote} That matters more here than anywhere else in this API: an unfiltered call ` +
    'against a large IPAM deployment returns every documented address in the instance, and a ' +
    '/16 that has been filled in can be tens of thousands of records. Always send a filter — ' +
    '`network_id` for one subnet, `company_id` for one customer, `address` or `fqdn` when you ' +
    'are chasing a single host.\n\n' +
    '`address` matches the stored text of one address, so it will not find every host in a ' +
    'subnet; use `network_id` for that. To go from an address to the machine, read `asset_id` ' +
    'and look it up with hudu_list_assets.',
  paginated: false,
  filters: {
    network_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Return only addresses inside this network. The narrowest and safest filter; get the ' +
          'id from hudu_list_networks.',
      ),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only addresses documented for this company.'),
    address: z
      .string()
      .optional()
      .describe('Match one stored address exactly, e.g. "10.20.0.14". Not a range or prefix.'),
    status: z.string().optional().describe(statusFilterDescription),
    fqdn: z.string().optional().describe('Match against the stored FQDN.'),
    asset_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return the addresses recorded against one asset — every IP a device holds.'),
    created_at: z.string().optional().describe(timestampRangeDescription),
    updated_at: z.string().optional().describe(timestampRangeDescription),
  },
  create: {
    bodyKey: 'ip_address',
    fields: {
      ...ipWritableFields,
      address: z
        .string()
        .min(1)
        .describe(
          'One IP address, e.g. "10.20.0.14" or "2001:db8::14". Ranges belong on a network ' +
            'record; see hudu_create_network.',
        ),
    },
  },
  update: { bodyKey: 'ip_address', fields: ipWritableFields },
  deletable: true,
  deleteImpact:
    'Removes the documentation for this address, including its FQDN and its link to the asset ' +
    'using it. Nothing on the network changes — the host keeps the address, Hudu simply stops ' +
    'recording it, and the range will read as free. If the address is being retired rather ' +
    'than mis-documented, prefer hudu_update_ip_address with `status: "unassigned"` so the ' +
    'record and its history survive.',
};

export function ipamTools(): ToolDefinition[] {
  return [...buildResourceTools(networksSpec), ...buildResourceTools(ipAddressesSpec)];
}
