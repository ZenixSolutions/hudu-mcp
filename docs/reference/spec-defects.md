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

**Sections A–E are claims read out of the document. Section F is measured.** A
contract run against a live Hudu **2.34.2** instance found the captured document
wrong in ways that broke shipped tools, and where the two disagree the
observation wins. Items corrected by that run say so in place and point at F.

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

> **Resolved by observation (F5).** It is `401`. On Hudu 2.34.2, a key created
> without password access answered `401` on `/asset_passwords` and on
> `/password_folders`, and no `403` was seen anywhere on that
> instance. The `401` guidance in `src/api/errors.ts` therefore names key scope
> as a cause alongside a bad, expired or IP-blocked key; the `403` branch is
> kept for other Hudu versions and is marked unobserved. Note the practical
> consequence: `401` no longer means "your key is wrong", so an operator must
> not respond to one by reissuing a working key.

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

> **Resolved by observation (F7).** It is a lower-case string. Live records
> carry `front`, `rear` and `both` — so the body schema's integer typing is
> contradicted by the API itself, the filter's capitalisation is wrong, and
> `both` appears in no Hudu documentation at all. `hudu_create_rack_storage_item`
> and `hudu_update_rack_storage_item` take a string, and the filter is
> documented with the observed casing. An integer was never sendable in
> practice: there was no published mapping to send one from.

**B8. `DELETE /networks/{id}` answers `200` with a JSON message body**, where
every other delete in the API answers `204`.

**B9. `POST /procedures/{id}/kickoff` answers `200`**, where every other
creation answers `201`.

## C. Missing capability — the API cannot answer the question

**C1. No collection endpoint returns a total count.** There is no `total`, no
`X-Total-Count`, and no `Link` header. Whether more records exist can only be
inferred from a full page. This is why this server emits no `has_more` and no
`total`: both would have to be invented, and an agent reading `has_more: false`
would report a partial inventory as complete.

> **Half-corrected by observation (F1).** The claim as originally written also
> said "there is no envelope". That part is wrong: ten collections _do_ wrap
> their array in a single-key object. What they do not carry is a count — the
> envelope holds the array and nothing else, no sibling `total`, `meta` or
> `pagination` key, and no total-bearing header. So C1's consequence stands
> unchanged and `page_was_full` remains the only honest signal; only the
> statement about the response shape was wrong, and it was wrong in a way that
> cost six list tools their results. See F1.

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

**D1. `network_type` is "an integer" with no mapping published.** Still true:
the live run found `0` on every network on the instance and nothing else, which
says what is in use there rather than what the field means or what else is
legal. The value is recorded in the tool description as an observation, not as a
mapping (F7).

**D2. `status` on rack storage items is an integer with no meanings published.**

> **Contradicted by observation (F7).** Live records carry the strings
> `reserved` and `used`, not integers. The write and filter arguments therefore
> take a string. No meaning is published for either value and no other value was
> seen, so the underlying complaint — that the vocabulary is undocumented —
> stands; only the type was wrong.

**D3. `max_wattage` and `power_draw` carry no unit.**

**D4. Rack unit numbering is unexplained**: which end of the cabinet holds the
lowest unit, whether `start_unit`–`end_unit` is inclusive, and what happens on
overlap are all absent. No conflict response is documented for a double-booking.

**D5. `IpAddress.status` legal values appear only in prose** — "Must be one of:
unassigned, assigned, reserved, deprecated, dhcp, or slaac" — in the property
description, not as a schema `enum`.

> **Contradicted by observation (F7).** The prose is wrong about casing and
> possibly about content. Live records carry `Assigned`, `DHCP`, `Reserved` and
> `Unassigned` — capitalised, and `DHCP` upper-cased rather than merely
> title-cased. The six prose values were previously enforced as a `z.enum` on
> the write arguments, which would have **rejected every value this API actually
> stores**, locally, before Hudu saw the call. That enum is gone: `status` is a
> string whose description names both vocabularies and says which was observed.
> Losing strict validation is the right trade when the strictness is provably
> wrong — a client that refuses a legal value leaves the caller no way through,
> whereas a wrong value costs one 422 from the party that actually knows.

**D6. Relation `fromable_type`/`toable_type` values appear only in a
parenthetical** (`Asset`, `Website`, `Procedure`, `AssetPassword`, `Company`,
`Article`), not as a schema `enum`, so the list may not be exhaustive on newer
versions.

> **Confirmed non-exhaustive by observation (F7).** Live relations carry
> `Article`, `Asset`, `AssetPassword`, `Procedure` and **`IpAddress`** — the
> last of which is in no published list. `Website` and `Company` are documented
> but were not present on that instance, so neither set is complete and the
> union of the two is the best available answer. The `z.enum` on
> `hudu_create_relation` is therefore gone for the same reason as D5: it would
> have refused to create a relation to an IP address, which is a documented
> Hudu feature the API demonstrably supports.

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

## F. Observed behaviour — measured against a live instance

Everything above this line was read out of `api-docs.json`. Everything below it
was **measured** against a live Hudu instance on a read-only key, and where the
two disagree the measurement wins. That is a deliberate departure from the
"documented surface only" rule in `CLAUDE.md` invariant 6: that rule exists to
stop this server inventing behaviour the API does not promise, not to make it
keep shipping code that provably does not work.

**Instance:** Hudu **2.34.2**, reported by `GET /api_info`.

**The instance's own `date` field is malformed.** `GET /api_info` returned a
`date` of `2026-31-05` — month 31, day 05 — which is not a valid ISO-8601 date
in any interpretation and is presumably a `YYYY-DD-MM` mix-up upstream. Nothing
in this server parses it, and nothing should start: report it verbatim.
`hudu_get_api_info` passes both fields through unchanged.

**Scope of the run.** The key used had **password access disabled**, so
`/asset_passwords` and `/password_folders` answered `401` and their response
shapes were **not** observed. Every claim about those two endpoints in this
document is still document-derived. `/expirations`, `/uploads`, `/websites`,
`/magic_dash`, `/activity_logs`, `/ip_addresses`, `/rack_storages` and
`/rack_storage_items` returned bare arrays, matching what the code assumed.

### F1. Eleven list endpoints wrap their array; six were undeclared here

The "documented?" column is about Hudu's OpenAPI file; the "declared?" column
is about this client. They are different questions and the first version of this
table conflated them.

| Endpoint                         | Envelope key    | Documented?          | Declared here? |
| -------------------------------- | --------------- | -------------------- | -------------- |
| `/companies`                     | `companies`     | no — bare array      | **no**         |
| `/asset_layouts`                 | `asset_layouts` | no — a single object | **no**         |
| `/articles`                      | `articles`      | no — bare array      | **no**         |
| `/folders`                       | `folders`       | no — bare array      | **no**         |
| `/relations`                     | `relations`     | no — bare array      | **no**         |
| `/users`                         | `users`         | no — bare array      | **no**         |
| `/assets`                        | `assets`        | yes                  | yes            |
| `/companies/{company_id}/assets` | `assets`        | yes                  | yes            |
| `/procedures`                    | `procedures`    | yes                  | yes            |
| `/public_photos`                 | `public_photos` | yes                  | yes            |
| `/matchers`                      | `matchers`      | yes                  | yes            |

Six shipped list tools expected a bare array and declared no `listKey`.

**Correction, recorded rather than quietly amended.** This document and the
0.1.0 changelog first stated that those six tools therefore returned an empty
list. That was wrong, and it was asserted without being measured. `unwrapList`
already had a fallback for an undeclared key: when the body is an object with
exactly one array-valued property, it returns that array. Every one of the six
responses was checked against the live instance and each carries exactly one
array property and nothing else, so the fallback resolved all six correctly.
**The six list tools worked.**

What the missing declarations actually cost is fragility rather than breakage.
The fallback holds only while the envelope has a single array property; the day
Hudu adds a second one — a `meta`, a sibling collection — the ambiguity is
genuine, `unwrapList` refuses to guess, and the call fails. Declaring the key
removes the dependence on that coincidence. It is a real fix and it was not
fixing an outage.

The distinction matters beyond bookkeeping: "silently returned nothing" and
"worked by luck" call for different urgency, and the first claim would have sent
anyone reading this changelog looking for a failure that never happened.

Each envelope is now declared as a `listKey` on the owning `ResourceSpec`.
`unwrapList` was also corrected so that a declared key which is _absent_ from
the body falls through to the same tolerant handling as an undeclared one,
rather than short-circuiting to an empty list: the declaration must not make the
client more brittle than it was.

No envelope carries anything besides the array — no `total`, `meta` or
`pagination` sibling — so C1's consequence is unaffected.

### F2. Seven single-record endpoints wrap the record

`/companies/{id}` → `company` · `/companies/{company_id}/assets/{id}` → `asset`
(already correct) · `/asset_layouts/{id}` → `asset_layout` · `/articles/{id}` →
`article` · `/folders/{id}` → `folder` · `/procedures/{id}` → `procedure` ·
`/users/{id}` → `user`

`unwrapRecord` with no `recordKey` returns the body unchanged, so six get-tools
handed back `{"company": {...}}` where a company was asked for. Quieter than F1
and just as wrong: every field lookup on the result misses. Each key is now
declared. `unwrapRecord` also treats a declared key whose value is `null` as
"no record" rather than returning the wrapper — see F3.

### F3. "Record not found" is inconsistent, and two endpoints answer 200

| Request                    | Response                                 |
| -------------------------- | ---------------------------------------- |
| `GET /companies/999999999` | **HTTP 200**, body `null`                |
| `GET /articles/999999999`  | **HTTP 200**, body `null`                |
| `GET /networks/999999999`  | 404 `{"error":"Network not found"}`      |
| `GET /users/999999999`     | 404 `{"error":"User not found"}`         |
| `GET /no_such_endpoint`    | 404 `{"status":404,"error":"Not Found"}` |

Two consequences.

First, **a get can succeed and find nothing**. The 200 never reaches the error
path, so `hudu_get_company` and `hudu_get_article` previously returned a bare
`null` — which a model can read as "the record exists and its fields are empty"
as easily as "there is no such record". `buildGetTool` and the hand-written
`hudu_get_asset` now return `{found: false, resource, id, record: null}` with a
notice naming the id and saying the record does not exist on this instance. No
404 is fabricated: the call genuinely succeeded, so reporting it as an error
would be a different lie.

Second, **a 404 and an unrouted path are distinguishable after all**, contrary
to what the get-tool descriptions and the 404 guidance previously said: a
missing record names its resource, an unrouted path does not. The guidance in
`src/api/errors.ts` now says to read the body, and no longer claims the two are
identical.

### F4. Hudu rejects an unknown query parameter outright

`GET /networks?page=1` answers **`400 {"error":"page is not a valid filter
parameter."}`**.

This confirms `paginated: false` on the five collections that document no
paging (C2) — and it makes "send it anyway and let the server ignore it" an
unsafe pattern here, because one unrecognised parameter fails the whole call.
Recorded in the `ResourceSpec` documentation in `src/tools/resource.ts`, since
that is where a future author would otherwise add a parameter speculatively.

### F5. A scope failure is 401, not 403

`GET /asset_passwords` and `GET /password_folders` both answered `401` for a key
created without password access. No `403` was seen anywhere on the instance.
See A7 for what changed in the guidance.

### F6. `GET /matchers` without `integration_id` answers 500

Not 400, and not an empty list. With `integration_id` the same call answers 200.
The parameter is required by the Zod schema, which was already right, but the
failure mode was recorded as a 404 that "reads as no matchers exist" — the real
one reads as an instance fault. `hudu_list_matchers` now says that a 500 from
this endpoint means a missing parameter rather than an outage.

### F7. Values for fields the contract left undocumented

Each of these is one instance's data, not a published contract, and is worded as
such in the tool descriptions. Three of them contradict a schema this server was
enforcing.

| Field                       | Observed values                                               | Against the contract                                                   |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `ip_addresses.status`       | `Assigned`, `DHCP`, `Reserved`, `Unassigned`                  | **Contradicts D5**: prose lists six lower-case values. Enum removed.   |
| `relations.*able_type`      | `Article`, `Asset`, `AssetPassword`, `Procedure`, `IpAddress` | **Contradicts D6**: `IpAddress` is in no published list. Enum removed. |
| `rack_storage_items.side`   | `front`, `rear`, `both`                                       | **Contradicts B7**: body schema types it as an integer. Now a string.  |
| `rack_storage_items.status` | `reserved`, `used`                                            | **Contradicts D2**: schema types it as an integer. Now a string.       |
| `networks.network_type`     | `0` (the only value present)                                  | Consistent with D1; says nothing about the mapping.                    |

The two removed enums are the important entry. Both were derived from prose in
the contract, and both would have rejected values the API demonstrably stores —
locally, before the request was sent, with no way for the caller to get past
them. A client that refuses a legal value is worse than one that forwards an
illegal one: the second costs a 422 from the party that actually knows the
answer. Neither field is validated here now; both descriptions name the
documented vocabulary, name the observed vocabulary, and say which is which.
