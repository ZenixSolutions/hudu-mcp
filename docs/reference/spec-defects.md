# Findings against the captured Hudu API contract

Every item below was found by reading `docs/reference/api-docs.json`, captured
from a live Hudu instance's `/api-docs.json` on 2026-08-04, and cross-checked
while implementing the tool surface. This file is the evidence base for
`docs/limitations.md` and for the defect report owed to Hudu.

**Captured contract:** Swagger 2.0, `info.version` 1.0, `basePath /api/v1`,
56 paths, 96 operations, 23 definitions. Auth is `x-api-key`. The published
rate limit is 300 requests/minute and the published default page size is 25.

Nothing here is inferred from a third-party client or from another instance.
Where a behaviour is undocumented, it is recorded as undocumented rather than
guessed at — Constitution Article IV.

---

## A. Security-relevant

**A1. Stored secrets are returned in list responses.**
`Asset_Password` lists `password` ("The actual password string") and
`otp_secret` ("Secret key for one-time passwords") among its **required**
properties, and `GET /asset_passwords` returns an array of that model. A single
unfiltered call therefore returns every credential and every TOTP seed visible
to the key. This is the single most consequential fact about the Hudu API and
drives the whole design of `src/security/secrets.ts`.

**A2. `DELETE /activity_logs` destroys the audit trail with no id.**
It takes a required `datetime` query parameter and deletes everything from that
point, plus an optional `delete_unassigned_logs`. No id, no dry run, no
documented count returned, no undo. It is precisely the call an attacker makes
to cover their tracks.

**A3. `DELETE /companies/{id}` cascades to every record inside the company.**
The widest-reaching delete in the API.

**A4. `DELETE /magic_dash` deletes by match, not by id.**
Keyed on `title` + `company_name` in the request body. A wrong title silently
matches nothing; a right-but-unintended one destroys a tile with no way to have
checked first.

**A5. `GET /cards/jump` is documented as working without API key authentication**
— "only requiring authentication at the time of jump". Not implemented by this
server; recorded because it belongs in any security review of a Hudu instance.

**A6. `enable_sharing` on an article mints a public, unauthenticated URL.**
The spec documents the field and the resulting `share_url`. It documents no
audit of who reads it.

**A7. No `403` is documented anywhere**, despite API keys being scoped at
creation for password access, destructive actions, exports, IP allowlist and
company scope. A scope failure therefore arrives as something else — most
likely `401` or `404` — which makes "the key lacks this permission" and "the
record does not exist" hard to tell apart.

**A8. `429` is documented nowhere**, and no `Retry-After` or `X-RateLimit-*`
header appears in the contract, even though the description states a 300/minute
limit. Rate-limit handling must therefore be defensive and client-side; the
server cannot be relied upon to say when the line has been crossed.

## B. Contract defects — the document contradicts itself or the endpoint

**B1. `GET /asset_layouts` documents its 200 response as a single
`Asset_Layout` object** where the endpoint returns a collection. Absorbed by
`unwrapList`.

**B2. `GET /activity_logs`, `POST /websites` and
`PUT /asset_passwords/{id}/unarchive` document no 2xx response at all** — only
error codes. Each of the three works; the success case is simply missing from
the document.

**B3. `PUT /rack_storage_items/{id}` has a structurally invalid body schema:**
`{"type":"object","properties":{"$ref":"#/definitions/RackStorageItem"}}` — a
`$ref` placed under `properties`, so the update body has no usable schema.

**B4. `POST /companies/{company_id}/assets` has a malformed `custom_fields`
schema** — a stray `"asset"` wrapper around the array type.

**B5. `PUT /companies/{company_id}/assets/{id}` documents its request body as
`$ref #/definitions/Asset`**, i.e. the read model, including server-assigned
`id`, `slug`, `url` and `created_at`.

**B6. `POST /asset_layouts` takes `fields` as an array of field objects;
`PUT /asset_layouts/{id}` documents `fields` as an array of bare strings.**
These cannot both be right, and guessing wrong would rewrite the field
definitions of every asset on the layout. `fields` is therefore deliberately
absent from `hudu_update_asset_layout`.

**B7. `side` on a rack storage item is typed as a string ("Front or Rear") as a
query filter and as an integer in the body schema**, with no mapping given for
the integer.

**B8. `DELETE /networks/{id}` answers `200` with a JSON message body**, where
every other delete in the API answers `204`.

**B9. `POST /procedures/{id}/kickoff` answers `200`**, where every other
creation answers `201`.

## C. Missing capability — the API cannot answer the question

**C1. No collection endpoint returns a total count.** There is no envelope, no
`total`, no `X-Total-Count`, and no `Link` header. Whether more records exist
can only be inferred from a full page. This is why this server emits no
`has_more` and no `total`: both would have to be invented, and an agent reading
`has_more: false` would report a partial inventory as complete.

**C2. Five collections have no pagination whatsoever** — `/networks`,
`/ip_addresses`, `/rack_storages`, `/rack_storage_items`, `/uploads` document
neither `page` nor `page_size`. On a populated IPAM range that is a very large
single response with no way to page it.

**C3. `GET /asset_layouts` documents `page` but not `page_size`** — the only
endpoint in the contract that paginates without a size control.

**C4. A rack's contents cannot be listed.** `RackStorageItem` carries no
reference to its rack: the string `rack_storage_id` does not appear anywhere in
the contract, `rack_storage_role_id` is documented as "the unique ID of the rack
storage role" and travels beside `rack_storage_role_name`, `_description` and
`_hex_color` — a colour-coded classification, not the cabinet. No list filter
scopes items to a rack, and no roles endpoint exists to resolve role ids
either. **"What is mounted in rack 12?" is not answerable through the documented
API.**

**C5. No locations endpoint exists**, yet networks and racks both carry a
`location_id`. Those ids can be copied from an existing record and nothing else.

**C6. Exports cannot be retrieved.** `POST /exports` and `POST /s3_exports`
start an export; this version documents no `GET /exports`, no
`GET /exports/{id}`, and no status endpoint. `POST /s3_exports` documents no
parameters at all, so what it exports and where it goes are both invisible.

**C7. `GET /relations` documents no filters** beyond `page`/`page_size`.
Finding the relations on one record means paging the entire set.

**C8. `GET /articles` has no `archived` filter**, although archive and unarchive
endpoints exist. Archived articles can be neither selected for nor excluded.

**C9. `GET /websites` has no `company_id` filter** — only `search`, `name`,
`slug`, `updated_at`.

**C10. `GET /companies/{company_id}/assets` documents only `page`, `page_size`
and `archived`** — none of the name, serial or layout filters available on the
global `/assets`.

**C11. `password_folders` are read-only.** No create, update or delete.

**C12. `procedures` have no create, update or delete.** Only list, get, and
kickoff.

**C13. `users` are read-only.**

**C14. `expirations` are read-only on this instance.** No `PUT` or `DELETE
/expirations/{id}` appears in the captured contract.

**C15. `asset_layouts` cannot be deleted.** Deactivation via `active: false` is
the only removal path.

**C16. `relations` cannot be updated.** Changing one means delete then create.

**C17. `matchers` cannot be created** — they are produced by integration sync.

## D. Under-documented — present but unexplained

**D1. `network_type` is "an integer" with no mapping published.**

**D2. `status` on rack storage items is an integer with no meanings published.**

**D3. `max_wattage` and `power_draw` carry no unit.**

**D4. Rack unit numbering is unexplained**: which end of the cabinet holds the
lowest unit, whether `start_unit`–`end_unit` is inclusive, and what happens on
overlap are all absent. No conflict response is documented for a double-booking.

**D5. `IpAddress.status` legal values appear only in prose** — "Must be one of:
unassigned, assigned, reserved, deprecated, dhcp, or slaac" — in the property
description, not as a schema `enum`.

**D6. Relation `fromable_type`/`toable_type` values appear only in a
parenthetical** (`Asset`, `Website`, `Procedure`, `AssetPassword`, `Company`,
`Article`), not as a schema `enum`, so the list may not be exhaustive on newer
versions.

**D7. `in_company` on `GET /folders` is described in eight words** — "When true,
only returns company-specific KB articles" — on the folders endpoint, describing
articles, with nothing said about `false` or about its interaction with
`company_id`.

**D8. Most definitions carry no `required` array**, including `Company`,
`Network`, `IpAddress`, `RackStorage` and `RackStorageItem`. Which fields a
create actually needs is not derivable from the contract.

**D9. `draft` on an article is readable and filterable but not writable** — it
appears as a query parameter and a response property, but not in the `POST` or
`PUT` body schema.

**D10. Asset custom fields are asymmetric between read and write.** Writes take
`custom_fields`, an array of objects keyed by snake_cased field _label_
(`{"custom_fields":[{"brand":"Apple","model":"MacBook Pro"}]}`); reads return
`fields`, an array of `{id, label, value, position}`.

**D11. Cascade behaviour is unspecified for every delete except companies.**
Whether deleting a network removes its IP addresses or orphans them, whether
deleting a folder takes its contents, and what happens to items in a deleted
rack are all absent from the contract.

**D12. No maximum `page_size` is published.** The description states a default
of 25 and nothing else. This server clamps at 100 rather than assume a ceiling.

## E. Not implemented in 0.1.0, by decision

**E1. `POST /uploads`, `POST /public_photos`, `PUT /public_photos/{id}` are
`multipart/form-data`.** The contract documents no request body for them. File
upload is out of scope for 0.1.0; the read side of both is implemented.

**E2. `GET /cards/jump`** is a browser redirect helper, not a data endpoint, and
is documented as bypassing API key authentication (A5). `GET /cards/lookup` is
implemented; `jump` is not.
