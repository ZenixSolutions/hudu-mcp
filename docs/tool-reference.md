# Tool reference

Every tool this server can register, grouped by resource. The tables are
generated from the tool registry itself — names, operation classes, required
arguments and gates come from the same definitions the server registers, so they
cannot drift from the running code. The prose around them is written by hand.

To see what your own configuration registers, run:

```bash
HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=... hudu-mcp --list-tools
```

That prints the registered tools, then the withheld ones with the reason for
each. 89 tools exist in total: 67 are registered with the default settings, 40
under `HUDU_READ_ONLY=1`, and 41 under `HUDU_READ_ONLY=1` together with
`HUDU_ALLOW_PASSWORD_REVEAL=1`.

## How to read the tables

**Class** is the operation classification, which is what decides gating and the
MCP annotations a client sees:

| Class         | Meaning                                                        | Requires                                              | `destructiveHint` |
| ------------- | -------------------------------------------------------------- | ----------------------------------------------------- | ----------------- |
| `Read`        | Retrieves data. No side effects on the Hudu instance.          | Nothing                                               | `false`           |
| `Create`      | Brings a new record into existence. Reversible by deleting it. | Write mode                                            | `false`           |
| `Update`      | Modifies an existing record. Overwrites prior field values.    | Write mode                                            | `true`            |
| `Admin`       | Alters instance-wide configuration or extracts data in bulk.   | Write mode, `confirm: true`                           | `true`            |
| `Destructive` | Removes data. Not reversible through this API.                 | Write mode, `HUDU_ALLOW_DESTRUCTIVE`, `confirm: true` | `true`            |

The MCP annotations a client sees are derived from the class, never hand-set per
tool. `destructiveHint: true` is the protocol's "may perform destructive
updates"; `false` is "only additive", which is a stronger claim than "does not
delete" and one an overwrite cannot make. `Update` also carries
`idempotentHint: true` — replaying the same PUT lands in the same state, which is
about retry safety rather than about what the first call cost. Only `Read` tools
carry `readOnlyHint: true`, and every tool carries `openWorldHint: true`.

The Hudu API key's own scope is a separate axis from all of this. Reading a
credential and writing one are different gates in this server
(`HUDU_ALLOW_PASSWORD_REVEAL` and `HUDU_ALLOW_PASSWORD_WRITE`) but a single
scope on the key, which covers all REST actions on passwords. Both sides have to
permit an operation.

**Required arguments** lists the arguments with no default that the schema will
not accept a call without. Optional filters and body fields are not listed here;
the tool's own description and JSON schema carry those, and your client will show
them. `confirm` is omitted from this column because it appears in the gate
column instead.

**Gate** is what has to be true for the tool to be registered and to run.
"Write mode" means `HUDU_READ_ONLY` is not set. The named variables must be set
in the server's environment before it starts; no tool argument can enable one. A
gated tool is not registered at all rather than registered-and-refusing.

A gate opening in this server does not mean Hudu will allow the call. API keys
are scoped at creation for password access, destructive actions, exports, IP
allowlist and company scope, and those scopes cannot be changed afterwards. Both
sides have to permit an operation.

## Arguments every tool shares

- **`response_format`** — `json` (default) or `markdown`. Present on all 41
  `Read` tools, `hudu_reveal_password` included, and on nothing else. `json` is
  compact and machine-readable; `markdown` is easier for a person and larger.
- **`page` and `page_size`** — on list tools whose endpoint documents them.
  `page` is 1-based; `page_size` accepts 1 to 100 and defaults to 25. Hudu
  publishes no maximum (D12), so this client clamps at a value it has validated
  and rejects larger ones here rather than letting the server silently alter
  them. `hudu_list_asset_layouts` takes `page` alone (C3), and five list tools
  take neither (C2).
- **`fields`** — on all 22 list tools **and on all 16 `hudu_get_*` tools except
  `hudu_get_api_info`**, which returns two fields and takes no arguments. Returns
  only these top-level keys on each record. Unknown names are ignored rather than
  rejected, because the Hudu schema varies by version and by asset layout. It is
  worth using on a single record too: an asset or company can carry a
  multi-kilobyte HTML `notes` or `description` blob you did not ask for. The
  projection runs in this server after the record is fetched, so it reduces what
  you read, not what Hudu sends. One tool uses the same name for something
  entirely different: `fields` on `hudu_create_asset_layout` is the layout's
  field _definitions_, not a projection.
- **`confirm`** — on every `Destructive` and `Admin` tool, and on
  `hudu_reveal_password`. Must be exactly `true`. It is supplied by the model, so
  it is a prompt-level speed bump rather than human-in-the-loop control; the
  environment flag beside it is the real gate.

## What a list tool returns

Every list tool returns an object with `items` plus these facts about them:

| Field                  | Always present | Meaning                                                                                                                                       |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`                 | yes            | The page **requested**.                                                                                                                       |
| `page_size`            | yes            | The page size **requested**. It never changes to describe what came back. On an unpaginated endpoint it echoes `count`.                       |
| `count`                | yes            | The number of records in `items`, and nothing else. Never the number Hudu returned for the page.                                              |
| `page_was_full`        | yes            | The page came back full, so more records probably exist. Not a promise that they do — a collection of exactly `page_size` looks the same.     |
| `next_page`            | yes            | The page to request next, or `null`.                                                                                                          |
| `pagination_supported` | yes            | `false` when the endpoint documents no `page` parameter at all (C2), so there is no further page to request and no `page_size` to lower.      |
| `pagination_note`      | yes            | Plain-language statement of what is and is not known. Regenerated after a truncation so it describes what was actually emitted.               |
| `completeness_caveat`  | no             | A standing limit on what this list can contain at all, independent of paging. `hudu_list_companies` carries one: it omits archived companies. |
| `truncated`            | no             | `true` when this client dropped records to fit the response budget.                                                                           |
| `records_on_page`      | no             | Present with `truncated`: how many records the page held before the cut. `count` is how many survived it.                                     |
| `truncation_note`      | no             | What was dropped, and how to reach it.                                                                                                        |

There is deliberately no `total` and no `has_more`: no Hudu collection endpoint
returns a count (C1), so both would have to be invented.

`truncated`, `records_on_page` and `truncation_note` are emitted **before**
`items`, in JSON and in Markdown alike. Clients clip long tool results, and a
correction that sits below twenty-five kilobytes of records is not a correction.
`page_was_full: true` beside a smaller `count` is not a contradiction — it means
the page was full and this response does not carry all of it, and `next_page`
resumes after the whole page rather than after what you were shown. See
[user-guide.md](user-guide.md#pagination-and-why-a-full-page-means-nothing).

Parenthesised codes such as (A1) or (C4) refer to items in
[reference/spec-defects.md](reference/spec-defects.md), which records what the
captured Hudu API contract says and where it contradicts itself.

## Companies

A company is the root object in Hudu, and `hudu_list_companies` is the entry
point for nearly every task: resolve a customer name to a numeric id, then carry
that id forward. The two lookup tools go the other way, resolving an identifier
held by a connected PSA or RMM. Deleting a company cascades to everything filed
inside it, which makes it the widest-reaching delete in the API (A3).

**`hudu_list_companies` omits archived companies and Hudu offers no parameter
that includes them.** On the measured instance 27 companies existed and the tool
returned 22. No `archived` argument is offered, because `?archived=true` and
`?archived=false` both return the same 22 records and `/companies` ignores an
unrecognised parameter rather than rejecting it — the argument would look like a
working filter and do nothing. Every result carries the exclusion in
`completeness_caveat` and in `pagination_note`. `hudu_get_company` does reach an
archived company by id, so a `company_id` no listing accounts for is still
resolvable.

| Tool                               | Class       | Purpose                                                                                         | Required arguments | Gate                                                  |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `hudu_list_companies`              | Read        | Find companies by name, integration identifier or update time. Archived companies are excluded. | none               | none                                                  |
| `hudu_get_company`                 | Read        | Read one company record by id.                                                                  | `id`               | none                                                  |
| `hudu_create_company`              | Create      | Add a company.                                                                                  | `name`             | write mode                                            |
| `hudu_update_company`              | Update      | Replace the supplied fields on a company.                                                       | `id`               | write mode                                            |
| `hudu_archive_company`             | Update      | Hide or restore a company without deleting it.                                                  | `id`, `archived`   | write mode                                            |
| `hudu_delete_company`              | Destructive | Delete a company and cascade to everything filed under it (A3).                                 | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |
| `hudu_find_company_by_integration` | Read        | Resolve a PSA or RMM customer identifier to the Hudu company.                                   | `integration_slug` | none                                                  |
| `hudu_lookup_integration_cards`    | Read        | Read the integration cards Hudu holds against an external record.                               | `integration_slug` | none                                                  |

## Assets

Assets are read globally and written per company. There is no `/assets/{id}`
route, so every single-asset tool needs `company_id` as well as `id`, and an
asset id belonging to company A answers 404 under company B — indistinguishable
from a deleted asset. Custom values are asymmetric between read and write (D10):
a read returns them under `fields` as `{id, label, value, position}` objects,
while a write accepts `custom_fields` as an array holding one object of
snake_cased label to value. A fetched asset cannot be sent back unchanged.

| Tool                       | Class       | Purpose                                                                             | Required arguments                      | Gate                                                  |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| `hudu_list_assets`         | Read        | Search assets across every company. The only route that reads assets instance-wide. | none                                    | none                                                  |
| `hudu_list_company_assets` | Read        | Page one company's assets. Accepts paging and `archived` and nothing else (C10).    | `company_id`                            | none                                                  |
| `hudu_get_asset`           | Read        | Read one asset, including its layout-defined values under `fields`.                 | `company_id`, `id`                      | none                                                  |
| `hudu_create_asset`        | Create      | Create an asset from a layout, inside a company.                                    | `company_id`, `name`, `asset_layout_id` | write mode                                            |
| `hudu_update_asset`        | Update      | Replace the supplied fields on an asset, including `custom_fields`.                 | `company_id`, `id`                      | write mode                                            |
| `hudu_archive_asset`       | Update      | Hide or restore an asset.                                                           | `company_id`, `id`, `archived`          | write mode                                            |
| `hudu_delete_asset`        | Destructive | Delete an asset and the field values stored on it.                                  | `company_id`, `id`                      | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Asset layouts

A layout is the template behind an asset type: its icon and colour, what it can
hold, and the custom fields every asset built from it carries. Read the layout
before writing an asset — its field labels are the keys `custom_fields` expects.
There is no delete endpoint (C15); `active: false` on the update tool is the
only way to retire a layout. `fields` is deliberately absent from
`hudu_update_asset_layout`: the contract describes the field list two
incompatible ways between create and update (B6), and guessing wrong would
rewrite the field definitions of every asset on the layout. This is the only
endpoint in the contract that paginates by `page` with no `page_size` (C3).

| Tool                       | Class  | Purpose                                                                                             | Required arguments | Gate       |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------- | ------------------ | ---------- |
| `hudu_list_asset_layouts`  | Read   | List the asset templates on the instance. Paginates by `page` only (C3).                            | none               | none       |
| `hudu_get_asset_layout`    | Read   | Read one layout and the field labels its assets carry.                                              | `id`               | none       |
| `hudu_create_asset_layout` | Create | Create a layout, with its field definitions if you supply them.                                     | `name`             | write mode |
| `hudu_update_asset_layout` | Update | Change a layout, or set `active: false` to retire it. Field definitions cannot be edited (B6, C15). | `id`               | write mode |

## Articles

`content` is HTML. Hudu stores the string and renders it, so Markdown sent here
is shown to readers with its asterisks and pipes intact. An update replaces
`content` wholesale rather than appending. `enable_sharing: true` mints a
public, unauthenticated URL for the article and Hudu documents no audit of who
reads it (A6). `draft` is readable and filterable but appears in no write body
(D9), and the list documents no `archived` filter even though archive and
unarchive endpoints exist (C8).

| Tool                   | Class       | Purpose                                                                           | Required arguments | Gate                                                  |
| ---------------------- | ----------- | --------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `hudu_list_articles`   | Read        | Search knowledge-base articles, including which ones carry a public share URL.    | none               | none                                                  |
| `hudu_get_article`     | Read        | Read one article with its HTML body.                                              | `id`               | none                                                  |
| `hudu_create_article`  | Create      | Create an article, optionally scoped to a company and filed in a folder.          | `name`             | write mode                                            |
| `hudu_update_article`  | Update      | Replace the supplied fields. `content` is overwritten wholesale, not appended to. | `id`               | write mode                                            |
| `hudu_archive_article` | Update      | Hide or restore an article.                                                       | `id`, `archived`   | write mode                                            |
| `hudu_delete_article`  | Destructive | Delete an article and any public share URL it had.                                | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Folders

These are knowledge-base folders. Password records are organised by the separate
`password_folders` resource, and the ids are not interchangeable. The list
response is flat — rebuild the hierarchy from `parent_folder_id`, which is null
at the top level. What happens to the articles and subfolders inside a deleted
folder is unspecified (D11), and `hudu_list_articles` has no folder filter to
check with beforehand.

| Tool                 | Class       | Purpose                                                                                      | Required arguments | Gate                                                  |
| -------------------- | ----------- | -------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `hudu_list_folders`  | Read        | List knowledge-base folders. The response is flat; rebuild the tree from `parent_folder_id`. | none               | none                                                  |
| `hudu_get_folder`    | Read        | Read one folder.                                                                             | `id`               | none                                                  |
| `hudu_create_folder` | Create      | Create a folder, global or scoped to a company.                                              | `name`             | write mode                                            |
| `hudu_update_folder` | Update      | Rename, re-parent, or move a folder to another company.                                      | `id`               | write mode                                            |
| `hudu_delete_folder` | Destructive | Delete a folder. What happens to its contents is unspecified (D11).                          | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Procedures

A procedure is a Process in the Hudu interface: an ordered checklist with a
completion count. This API version exposes them read-only apart from kickoff
(C12) — templates are authored in the web UI. `hudu_kickoff_procedure` copies a
template into a live process and sends its two optional inputs as query
parameters, because that is what the contract documents; success answers 200
rather than the 201 every other create answers (B9).

| Tool                     | Class  | Purpose                                                                | Required arguments | Gate       |
| ------------------------ | ------ | ---------------------------------------------------------------------- | ------------------ | ---------- |
| `hudu_list_procedures`   | Read   | List process templates and the processes started from them.            | none               | none       |
| `hudu_get_procedure`     | Read   | Read one procedure with its task counts.                               | `id`               | none       |
| `hudu_kickoff_procedure` | Create | Start a live process from a template, optionally attached to an asset. | `id`               | write mode |

## Passwords

This is the most consequential surface in the Hudu API. The `Asset_Password`
model lists `password` and `otp_secret` among its **required** properties and
`GET /asset_passwords` returns an array of that model (A1), so one unfiltered
call would return every credential and every TOTP seed the key can see. Those
two fields are stripped from every tool result centrally, in `executeTool`, and
withheld from rendered Markdown too, which is built from the stripped payload.
`hudu_reveal_password` is the single exception: it needs the environment flag, an
explicit `confirm: true`, and one specific id. It is classed `Read` because it
does not modify Hudu, so it stays available in read-only mode when the flag is
set. Password folders are read-only in this API version (C11).

**What a withheld secret looks like.** A stripped field comes back as `null` with
a sibling `password_redacted: true` (or `otp_secret_redacted: true`). A field
that genuinely stores nothing comes back `null` with **no** flag, so "this record
documents an account with no stored password" stays distinguishable from "this
record's password was withheld from you". No field named `password` or
`otp_secret` ever holds a string. The explanation of the redaction is prepended
to the result text as a notice rather than carried in the payload.

**Writes are gated separately from reads.** `hudu_create_password`,
`hudu_update_password` and `hudu_archive_password` need
`HUDU_ALLOW_PASSWORD_WRITE`, and `hudu_delete_password` needs that _and_
`HUDU_ALLOW_DESTRUCTIVE`. Neither password gate opens the other: overwriting the
only copy of a working credential is a loss even though nothing leaks, and an
operator who wants an agent to document a newly issued credential should not have
to grant it read access to the whole vault. Under the default configuration the
only password tools registered are the two lists and the two gets.

| Tool                         | Class       | Purpose                                                                             | Required arguments   | Gate                                                                               |
| ---------------------------- | ----------- | ----------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `hudu_list_passwords`        | Read        | List credential records with their metadata. Secret values are withheld (A1).       | none                 | none                                                                               |
| `hudu_get_password`          | Read        | Read one credential record without its secret.                                      | `id`                 | none                                                                               |
| `hudu_create_password`       | Create      | Store a new credential.                                                             | `name`, `company_id` | `HUDU_ALLOW_PASSWORD_WRITE`, write mode                                            |
| `hudu_update_password`       | Update      | Replace the supplied fields on a credential.                                        | `id`                 | `HUDU_ALLOW_PASSWORD_WRITE`, write mode                                            |
| `hudu_archive_password`      | Update      | Hide or restore a credential.                                                       | `id`, `archived`     | `HUDU_ALLOW_PASSWORD_WRITE`, write mode                                            |
| `hudu_delete_password`       | Destructive | Delete a credential, including the stored secret and OTP seed.                      | `id`                 | `HUDU_ALLOW_PASSWORD_WRITE`, `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |
| `hudu_reveal_password`       | Read        | Return the stored secret and OTP seed for exactly one record, in clear text.        | `id`                 | `HUDU_ALLOW_PASSWORD_REVEAL`, `confirm: true`                                      |
| `hudu_list_password_folders` | Read        | List the folders credentials are grouped into. Read-only in this API version (C11). | none                 | none                                                                               |
| `hudu_get_password_folder`   | Read        | Read one password folder.                                                           | `id`                 | none                                                                               |

## Networks and IP addresses

Neither list endpoint documents `page` or `page_size` (C2), so both return the
whole filtered collection in one response — which matters most for addresses,
where a populated range is tens of thousands of records. Always send a filter.
`network_type` is an integer with no published mapping (D1) whose only observed
value is `0`; `location_id` refers to a locations collection this API does not
expose at all (C5). The six `status` values appear in the schema prose rather
than as an enum (D5) and a live instance returned them **capitalised** —
`Assigned`, `DHCP`, `Reserved`, `Unassigned` (F7) — so neither the write tools
nor the filter enforce a vocabulary that would reject values the API stores;
match the casing your instance returns. `DELETE /networks/{id}` answers 200 with
a message body where every other delete answers 204 (B8); both are treated as
success. Sending an undocumented query parameter to these endpoints fails the
call outright: `GET /networks?page=1` answers 400 (F4).

| Tool                     | Class       | Purpose                                                                     | Required arguments | Gate                                                  |
| ------------------------ | ----------- | --------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `hudu_list_networks`     | Read        | List documented subnets. Unpaginated (C2).                                  | none               | none                                                  |
| `hudu_get_network`       | Read        | Read one subnet record.                                                     | `id`               | none                                                  |
| `hudu_create_network`    | Create      | Document a subnet as a CIDR block.                                          | `name`, `address`  | write mode                                            |
| `hudu_update_network`    | Update      | Replace the supplied fields on a subnet.                                    | `id`               | write mode                                            |
| `hudu_delete_network`    | Destructive | Delete a subnet record. What becomes of its addresses is unspecified (D11). | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |
| `hudu_list_ip_addresses` | Read        | List documented addresses. Unpaginated, so always send a filter (C2).       | none               | none                                                  |
| `hudu_get_ip_address`    | Read        | Read one address record.                                                    | `id`               | none                                                  |
| `hudu_create_ip_address` | Create      | Document one address, optionally tied to a network and an asset.            | `address`          | write mode                                            |
| `hudu_update_ip_address` | Update      | Replace the supplied fields on an address, including `status`.              | `id`               | write mode                                            |
| `hudu_delete_ip_address` | Destructive | Delete an address record. Prefer setting `status: "unassigned"` instead.    | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Racks

"Storage" here means cabinet, not disk. A rack storage is the rack; a rack
storage item is one thing mounted in it. **To see what is in a rack, call
`hudu_get_rack_storage`**: the rack record carries `front_items` and `rear_items`,
one slot per rack unit on each face, each slot listing what is mounted there with
`asset_id` and `asset_name` — a complete per-unit elevation. Those fields are
absent from the `RackStorage` definition in the captured contract, which is why
C4 originally recorded a rack's contents as unlistable; that claim was wrong and
is now written up as a correction (C4, F8). What is genuinely missing is the
other direction: a rack storage item carries no rack id and no filter scopes
items to a cabinet — `rack_storage_role_id` is a colour-coded classification, not
the rack — so `hudu_list_rack_storage_items` is an instance-wide list, best used
with `asset_id` to find where a known device is racked. Unit numbering
direction and inclusivity are both undocumented and no conflict response is
published for a double-booking (D4) — though the elevation numbers every slot, so
the direction in use on your instance can be read off a rack record, and an
undocumented `descending_units` field is present whose contents nothing published
explains (F8); `side` is documented as a string in the list
filter and an integer in the write body (B7), and observation settles it as the
lower-case strings `front`, `rear` and `both` (F7), which is what the tools take;
`status` is documented as an integer with no published meanings (D2) and observed
as the strings `reserved` and `used` (F7); and `max_wattage` and `power_draw`
carry no unit (D3). Neither collection paginates (C2).

| Tool                            | Class       | Purpose                                                                                                                         | Required arguments | Gate                                                  |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `hudu_list_rack_storages`       | Read        | List racks, each with its full elevation. Unpaginated, and no name or search filter is documented (C2).                         | none               | none                                                  |
| `hudu_get_rack_storage`         | Read        | Read one rack, including its `front_items`/`rear_items` per-unit elevation.                                                     | `id`               | none                                                  |
| `hudu_create_rack_storage`      | Create      | Create a rack.                                                                                                                  | `name`             | write mode                                            |
| `hudu_update_rack_storage`      | Update      | Replace the supplied fields on a rack.                                                                                          | `id`               | write mode                                            |
| `hudu_delete_rack_storage`      | Destructive | Delete a rack. What happens to the items in it is unspecified (D11).                                                            | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |
| `hudu_list_rack_storage_items`  | Read        | List mounted items instance-wide; filter by `asset_id` to find where a device is racked. No filter scopes items to a rack (C4). | none               | none                                                  |
| `hudu_get_rack_storage_item`    | Read        | Read one mounted item.                                                                                                          | `id`               | none                                                  |
| `hudu_create_rack_storage_item` | Create      | Mount an asset in a unit range on one side of a rack.                                                                           | none               | write mode                                            |
| `hudu_update_rack_storage_item` | Update      | Replace the supplied fields on a mounted item.                                                                                  | `id`               | write mode                                            |
| `hudu_delete_rack_storage_item` | Destructive | Unmount an item. The asset it pointed at is untouched.                                                                          | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Websites

A website in Hudu is a live monitor rather than a documentation page: creating
one starts recurring outbound polling of the named host from the Hudu instance,
plus TLS, WHOIS and DNS checks, and arms the alerts that go with them. `paused:
true` stops the checks while keeping the history; deleting throws the history
away. The list documents no `company_id` filter (C9), so scoping to one customer
means matching `company_id` in the returned records. `POST /websites` documents
no success response at all (B2), so the created record may come back `null` even
though the write succeeded — confirm with `hudu_list_websites` rather than
retrying, which would create a second monitor.

| Tool                  | Class       | Purpose                                                                              | Required arguments | Gate                                                  |
| --------------------- | ----------- | ------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------- |
| `hudu_list_websites`  | Read        | List monitors with their last status. No company filter is documented (C9).          | none               | none                                                  |
| `hudu_get_website`    | Read        | Read one monitor.                                                                    | `id`               | none                                                  |
| `hudu_create_website` | Create      | Start monitoring a host. Outbound polling from the Hudu instance begins immediately. | `name`             | write mode                                            |
| `hudu_update_website` | Update      | Replace the supplied fields, including `paused` and the per-check switches.          | `id`               | write mode                                            |
| `hudu_delete_website` | Destructive | Delete a monitor and its accumulated uptime, certificate and DNS history.            | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Relations

A relation is an edge between two records, stored as a from/to pair of type and
id. There is no read-one route and no update route (C16), so changing a relation
means deleting it and creating a replacement. The list documents no filters
whatsoever (C7): finding the relations on one record means paging the whole set
and matching the `fromable_` or `toable_` pair yourself. Expect each link twice
— Hudu creates the mirror and marks it `is_inverse: true`.

| Tool                   | Class       | Purpose                                                                  | Required arguments                                         | Gate                                                  |
| ---------------------- | ----------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------- |
| `hudu_list_relations`  | Read        | Page every link on the instance. The endpoint documents no filters (C7). | none                                                       | none                                                  |
| `hudu_create_relation` | Create      | Link two records. Hudu creates the mirror link as well.                  | `fromable_type`, `fromable_id`, `toable_type`, `toable_id` | write mode                                            |
| `hudu_delete_relation` | Destructive | Remove a link and its mirror. Neither record is touched.                 | `id`                                                       | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Magic Dash

Magic dash items are the tiles across the top of a company page, normally
written by scripts. There is no read-one route, so the list is the only way to
read one. `POST /magic_dash` is an upsert keyed on title plus company name: a
title that already exists on that company is overwritten wholesale, with no
error and no way to recover what it said. The write endpoints address a company
by _name_ and the read filter by `company_id`, which is the asymmetry most
likely to send a caller in circles. The by-title delete matches rather than
addresses, so a wrong title silently matches nothing and a right-but-unintended
one destroys a tile that could not have been checked first (A4).

| Tool                                   | Class       | Purpose                                                                              | Required arguments                 | Gate                                                  |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------- |
| `hudu_list_magic_dash_items`           | Read        | List dashboard tiles. The only way to read one — there is no read-by-id route.       | none                               | none                                                  |
| `hudu_upsert_magic_dash_item`          | Update      | Create a tile, or replace the existing tile with the same title on the same company. | `title`, `company_name`, `message` | write mode                                            |
| `hudu_delete_magic_dash_item`          | Destructive | Delete a tile by id.                                                                 | `id`                               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |
| `hudu_delete_magic_dash_item_by_title` | Destructive | Delete whatever tile matches a title and company name (A4).                          | `title`, `company_name`            | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Matchers

A matcher is one row in the mapping table between a connected integration and
Hudu's companies. `integration_id` is required on the list — without it Hudu
answers in a way that reads as "no matchers exist" rather than "you left out a
parameter". The usual job is clearing the unmatched backlog: list with `matched:
false`, then resolve each row with `hudu_update_matcher`. Matchers cannot be
created through the API (C17); they appear when an integration syncs.

| Tool                  | Class       | Purpose                                                                                    | Required arguments | Gate                                                  |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------- |
| `hudu_list_matchers`  | Read        | List an integration's company mapping rows, matched or unmatched.                          | `integration_id`   | none                                                  |
| `hudu_update_matcher` | Update      | Point an integration record at a Hudu company, or correct which one it points at.          | `id`               | write mode                                            |
| `hudu_delete_matcher` | Destructive | Remove a mapping row. The record becomes unmatched and sync stops landing on that company. | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |

## Instance, users and audit trail

`hudu_get_api_info` is the cheapest check that a base URL and key work, and the
only way to tell an endpoint missing from your Hudu version from a record that
does not exist — both answer 404. Users are read-only (C13) and their records
carry `last_sign_in_ip`, `sign_in_count` and `otp_required_for_login`, so filter
rather than enumerate. Activity logs filter by actor, by record (`resource_type`
and `resource_id` must travel together) or from a `start_date`; there is no end
date. The purge takes a cutoff timestamp and no record id, offers no dry run,
returns no count and cannot be undone (A2). Expirations are read-only on this
contract (C14) and have no date-range filter, so "the next 30 days" is a
comparison you make against each entry's `date`.

Three things about the activity log will produce a wrong answer if nobody warns
you. **The filter names and the response field names are different words for the
same things**: you filter on `resource_type`, `resource_id` and `action_message`,
and entries come back carrying `record_type`, `record_id` and `action`. No field
called `action_message` exists on an entry. **`viewed` events dominate an active
instance and there is no changes-only filter** — `action_message` takes one value
at a time, so excluding views means one request per action value or dropping them
client-side, and the newest entry for a record is frequently a view rather than
its newest change. **`details` does not say what changed**: it is a JSON string
holding a snapshot of the record _after_ the action, with no before value and no
field-level diff, so answering "what changed" needs two consecutive `updated`
entries compared by hand.

| Tool                       | Class       | Purpose                                                                             | Required arguments | Gate                                                  |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `hudu_get_api_info`        | Read        | Report the version and build date of the instance. The cheapest connectivity check. | none               | none                                                  |
| `hudu_list_users`          | Read        | Find Hudu accounts. Records carry sign-in IP, sign-in count and MFA state.          | none               | none                                                  |
| `hudu_get_user`            | Read        | Read one account.                                                                   | `id`               | none                                                  |
| `hudu_list_activity_logs`  | Read        | Read the audit trail, filtered by actor, by record, or from a start date.           | none               | none                                                  |
| `hudu_purge_activity_logs` | Destructive | Delete audit-trail entries from a timestamp onward (A2).                            | `datetime`         | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |
| `hudu_list_expirations`    | Read        | List everything with an expiry date, gathered from across the modules.              | none               | none                                                  |

## Files

Read side only. `POST /uploads`, `POST /public_photos` and `PUT
/public_photos/{id}` are `multipart/form-data` and the contract documents no
request body for them, so file upload is not implemented (E1) — tell the user to
attach the file in the Hudu web UI rather than claiming an upload happened. `/uploads` documents neither pagination nor any filter (C2), so it
returns the instance's attachments in one response; match on `uploadable_type`
and `uploadable_id` yourself. Public photo URLs are public: anyone holding one
can fetch the image without authenticating.

| Tool                      | Class       | Purpose                                                               | Required arguments | Gate                                                  |
| ------------------------- | ----------- | --------------------------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `hudu_list_uploads`       | Read        | List file attachments instance-wide. Unpaginated and unfiltered (C2). | none               | none                                                  |
| `hudu_get_upload`         | Read        | Read one attachment's metadata and URL.                               | `id`               | none                                                  |
| `hudu_delete_upload`      | Destructive | Delete a file. This server cannot re-upload it (E1).                  | `id`               | `HUDU_ALLOW_DESTRUCTIVE`, write mode, `confirm: true` |
| `hudu_list_public_photos` | Read        | List images published at public, unauthenticated URLs.                | none               | none                                                  |

## Exports

Both tools are `Admin` class, which means write mode plus `HUDU_ALLOW_EXPORTS=1`
plus `confirm: true`, and the API key must also have been created with export
capability. Both extract documentation in bulk to somewhere Hudu's access
controls no longer apply, and `include_passwords` writes credential material
into that file. Once started, an export cannot be listed, polled, cancelled or
downloaded through this API (C6): there is no GET on either endpoint.
`hudu_start_s3_export` takes no arguments at all — its scope and its destination
bucket come from Hudu's own settings, which this API does not expose, so neither
this server nor a model can say in advance what will leave the instance.

| Tool                        | Class | Purpose                                                                                          | Required arguments | Gate                                              |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------- |
| `hudu_start_company_export` | Admin | Ask Hudu to package one company's documentation into a file.                                     | `company_id`       | `HUDU_ALLOW_EXPORTS`, write mode, `confirm: true` |
| `hudu_start_s3_export`      | Admin | Ask Hudu to export to its configured S3 bucket. Scope and destination are not visible here (C6). | none               | `HUDU_ALLOW_EXPORTS`, write mode, `confirm: true` |
