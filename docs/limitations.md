# Limitations

What this server cannot do, and why. Most of it is not a gap in this software: it
is a property of the Hudu v1 REST API, which this project reports rather than
papers over.

Every item cites a numbered finding in
[reference/spec-defects.md](reference/spec-defects.md), where the evidence sits.

## Where this comes from

The contract behind these findings was captured from one live Hudu instance's
`/api-docs.json` on **2026-08-04**: Swagger 2.0, `info.version` 1.0, `basePath
/api/v1`, 56 paths, 96 operations, 23 definitions, `x-api-key` authentication, a
published rate limit of 300 requests per minute and a published default page size
of 25.

That is evidence about one instance on one day. **A different Hudu version may
differ.** Nothing in this document is inferred from a third-party client or from
another instance, and where the contract is silent this document records it as
undocumented rather than guessing.

`hudu_get_api_info` reports the version and build date of whatever instance you
are pointed at. Call it when something behaves unexpectedly: Hudu answers `404`
both for a missing record and for an endpoint that does not exist on that build,
so the version is often the only way to tell the two apart. On Hudu 2.34.2 the
response bodies do differ — a missing record names its resource ("Network not
found"), an unrouted path answers a generic `{"status":404,"error":"Not
Found"}` — but that distinction is an observation, not a published contract.
Note also that `GET /api_info` on 2.34.2 returned a **malformed `date`** of
`2026-31-05`; the field is passed through verbatim rather than parsed (F).

## Counting and pagination

**No collection endpoint returns a total count (C1).** There is no `total`, no
`X-Total-Count` and no `Link` header anywhere in the contract, and none appeared
on a live instance either. Whether more records exist can only be inferred from
whether a page came back full. Ten collections _do_ wrap their array in a
single-key envelope (F1) — that envelope carries the array and nothing else, so
it adds no counting.

This server therefore emits no `total` and no `has_more`. Both would have to be
invented, and an agent reading `has_more: false` would report a partial inventory
as complete. `page_was_full` is the honest signal, and `pagination_note` states in
plain language what is and is not known. "How many assets does this client have?"
is not a question the API answers; it is a question you answer by paging to the
end and counting.

**Nor does the API aggregate anything, anywhere.** There is no count endpoint, no
`group_by`, no sum, no facet and no summary of any kind on any collection — not
just no total on a page. Every "how many", "which is most", "what is the
breakdown by" and "how has this changed over time" is client-side arithmetic over
records you paged through yourself. Combined with C2 below, that means some of
those questions have no answer at all through this API: where a collection does
not paginate and its full response does not fit the output budget, there is no
way to enumerate it and therefore no way to count it.

**Five collections have no pagination whatsoever (C2).** `/networks`,
`/ip_addresses`, `/rack_storages`, `/rack_storage_items` and `/uploads` document
neither `page` nor `page_size`. The corresponding tools send neither and report
in the envelope that there is no further page to request. On a populated IPAM
range that is a very large single response with no way to page it — filter, or
accept a client-side truncation you cannot page past.

**Six tools have no paging controls, and on some of them a truncated record is
unreachable.** The five list tools above — `hudu_list_networks`,
`hudu_list_ip_addresses`, `hudu_list_rack_storages`,
`hudu_list_rack_storage_items`, `hudu_list_uploads` — plus
`hudu_lookup_integration_cards`, whose `/cards/lookup` endpoint documents no
`page` either. All six report `pagination_supported: false` in the envelope.

The consequence is worth stating separately from C2, because it is the case where
this server cannot show you data that exists. When one of those responses exceeds
the 25,000-character output budget, records are dropped to make it fit. There is
no next page to fetch them from and no `page_size` to lower, so the only remedy
is a narrower filter — and where the endpoint offers no filter narrow enough, the
dropped records cannot be reached through this server at all.
`hudu_list_rack_storage_items` is the worst of them: its filters are all
instance-wide, and none of them scopes to a rack. `/uploads` documents no filter
whatsoever. The envelope says so in `truncation_note` and in a regenerated
`pagination_note` rather than implying a page that would fetch them; do not
describe a truncated response from one of these tools as a full inventory.

**One collection paginates without a size control (C3).**
`GET /asset_layouts` documents `page` but not `page_size`, so
`hudu_list_asset_layouts` offers no `page_size` argument. Offering one would
invite a caller to ask for 100 records, receive the server's own default, and
read the short page as the end of the data.

**No maximum `page_size` is published (D12).** The API describes a default of 25
and nothing else. This client clamps at 100 — a value it has validated — and
rejects larger requests at the schema rather than letting the server silently
alter them. If your instance accepts more, this client will still not send it.

## A correction: a rack's contents can be listed (C4)

**A rack's contents can be listed after all — C4 was wrong.** This page
previously called it the sharpest gap in the contract: `RackStorageItem` carries
no reference to its rack, no filter scopes items to a rack, therefore "what is
mounted in rack 12?" had no answer. Every premise was true and the conclusion was
not. The link is on the **rack**, not on the item: `GET /rack_storages` and
`GET /rack_storages/{id}` return `front_items` and `rear_items` on each rack —
one slot per rack unit on each face, each slot listing what is mounted there with
`asset_id` and `asset_name` — which is a complete per-unit elevation. Call
`hudu_get_rack_storage` with the rack id and read it. The claim survived because
those fields are absent from the `RackStorage` definition in the captured
contract, and a schema that omits a field looks exactly like an API that lacks
one; it was corrected by an external reviewer calling the endpoint. See C4 and F8
in [spec-defects.md](reference/spec-defects.md).

What remains true is narrower: `hudu_list_rack_storage_items` is instance-wide
and cannot be grouped by cabinet, because a rack storage item still carries no
rack id. It answers "where is asset X mounted?" — filter it by `asset_id` — and
it is not a way to list one rack.

## Questions the API cannot answer

**Archived companies cannot be listed, and their absence is silent.**
`GET /companies` returns only unarchived companies and documents no parameter
that changes that. On the Hudu 2.34.2 instance this was measured against, 27
companies existed, `hudu_list_companies` returned 22, and 64 assets belonged to
the five it left out. Sending `archived` does not help: `?archived=true` and
`?archived=false` both returned the same 22 records, and `/companies` ignores an
unrecognised query parameter rather than rejecting it the way `/networks` does
(F4 is per-endpoint, not global) — so an `archived` argument would look like a
working filter and do nothing, which is why none was added. The exclusion is
disclosed instead: `hudu_list_companies` says so in its description, and every
result carries it in `completeness_caveat` and in `pagination_note`.
`hudu_get_company` does reach an archived company by id, so a `company_id` that
no listing accounts for is resolvable that way. Never quote the length of this
list as the number of companies on the instance.

**The activity log records what happened, not what changed.** Each entry's
`details` is a JSON _string_ holding a snapshot of the record **after** the
action — a post-state, with no before value and no field-level diff. A single
`updated` entry therefore cannot answer "what changed"; that needs two
consecutive `updated` entries for the same record, compared by hand. There is no
diff endpoint and no version history in this API.

**`viewed` events swamp the activity log and there is no changes-only filter.**
The `action` values observed on 2.34.2 are `created`, `viewed` and `updated`, and
`viewed` dominates an active instance. Nothing in the API narrows the log to
modifications: the only server-side control is the `action_message` filter, which
takes one value at a time, so excluding views means either one request per action
value or dropping them client-side. The consequence to hold on to is that **the
newest log entry for a record is frequently a view, and is therefore not its
newest change** — answering "when was this last modified" from the first entry
returned will usually be wrong. There is also no end-date filter, only
`start_date`.

**Articles with no company cannot be selected for.** An article created without a
`company_id` is global, and `GET /articles` documents no filter that isolates
those — `company_id` selects one company's articles and omitting it returns
everything. Request without `company_id` and select on a null `company_id`
yourself.

**Neither `password_type` nor `network_type` classifies anything usable.** Both
look like the field that would answer "which of these are network device
credentials?" or "which of these subnets are guest networks?", and neither does.
`password_type` is free text with no published vocabulary and came back `null` on
every password record on the measured instance, so it classifies nothing there.
`network_type` is an integer with no published mapping (D1) and every network on
the same instance carried `0` (F7) — as a filter it would have selected every
network or none. Both are single-instance observations rather than published
contract, and both are a reason to populate the fields consistently rather than a
reason to ignore them; but as things stand, searching `name` and `description`
text is the only route to either question.

**There is no locations endpoint (C5).** Networks and racks both carry a
`location_id`, and nothing lists or resolves those ids. They can be copied from
an existing record and nothing else — though a live rack record does echo an
undocumented `location_name` and `location_url` beside the id (F8), so a rack's
site can at least be named.

**Exports cannot be retrieved (C6).** `POST /exports` and `POST /s3_exports`
start an export. This version documents no `GET /exports`, no `GET /exports/{id}`
and no status endpoint, so there is no id to poll, no progress, and no download
URL. The tools say so and refuse to promise otherwise; collect the result where
Hudu delivers it. `POST /s3_exports` documents no parameters at all, so what it
exports and where it goes are both invisible from here.

**Relations cannot be filtered (C7).** `GET /relations` documents `page` and
`page_size` and nothing else, so finding the relations on one record means paging
the entire set and matching yourself.

**Archived articles cannot be selected for or against (C8).** `GET /articles` has
no `archived` filter, although archive and unarchive endpoints exist.

**Websites cannot be filtered by company (C9).** Only `search`, `name`, `slug`
and `updated_at`. Scoping to one customer means matching `company_id` in the
returned records.

**The per-company asset list is filter-poor (C10).**
`GET /companies/{company_id}/assets` documents only `page`, `page_size` and
`archived` — none of the name, serial or layout filters the global `/assets`
route offers. Use `hudu_list_assets` with `company_id` when you need those.

## Resources that are read-only in this contract

No create, update or delete endpoints are documented for these, so no such tools
exist. None of them is being withheld by a gate.

| Resource               | Finding | What to do instead                                                        |
| ---------------------- | ------- | ------------------------------------------------------------------------- |
| Password folders       | C11     | Manage them in the Hudu web interface                                     |
| Procedures             | C12     | Author templates in the web UI; `hudu_kickoff_procedure` is the one write |
| Users                  | C13     | Create and change accounts in the web admin UI                            |
| Expirations            | C14     | Change the record that produced the entry                                 |
| Asset layouts (delete) | C15     | Set `active: false` to retire a layout                                    |
| Relations (update)     | C16     | Delete and recreate                                                       |
| Matchers (create)      | C17     | They appear when an integration syncs                                     |

## Not implemented

**File upload (E1).** `POST /uploads`, `POST /public_photos` and
`PUT /public_photos/{id}` are `multipart/form-data`, and the contract documents
no request body for any of them. This server speaks JSON everywhere and does not
implement multipart, so there is no way to attach a file through this interface.
The read side of both resources is implemented. Attach files in the Hudu web UI.

**`GET /cards/jump` (E2, A5).** A browser redirect helper rather than a data
endpoint, and documented as working without API key authentication — "only
requiring authentication at the time of jump". Not implemented.
`GET /cards/lookup` is.

**Field definitions on layout update (B6).** `POST /asset_layouts` takes `fields`
as an array of field objects; `PUT /asset_layouts/{id}` documents `fields` as an
array of bare strings. These cannot both be right, and guessing wrong would
rewrite the field definitions of every asset on the layout. `fields` is therefore
absent from `hudu_update_asset_layout`. Supply field definitions at creation, or
edit them in the web UI.

**No remote transport.** This server speaks stdio only. See
[compatibility.md](compatibility.md).

## Errors, rate limits and scope

**No `429` and no rate-limit headers are documented (A8)**, even though the API
description states a limit of 300 requests per minute. No `Retry-After` and no
`X-RateLimit-*` header appears anywhere in the contract. Rate-limit handling is
therefore defensive and client-side: the client paces itself under a ceiling you
set (`HUDU_RATE_LIMIT_PER_MINUTE`, default 120) and bounds concurrency
(`HUDU_MAX_CONCURRENCY`, default 4), rather than waiting to be told it has
crossed a line. If a `429` does arrive it is retried with backoff, honouring
`Retry-After` when the response happens to carry one — but nothing in the
contract promises it will.

**A scope failure is a `401`, not a `403` (A7, F5).** No `403` is documented
anywhere in the contract, despite keys being scoped at creation for password
access, destructive actions, exports, IP allowlist and company scope — and a
live Hudu 2.34.2 run settled what arrives instead: a key created without
password access answered **`401`** on `/asset_passwords` and `/password_folders`,
and no `403` was seen at all.

The practical consequence matters. A `401` on this API does not mean "your key
is wrong". If every endpoint fails, including `hudu_get_api_info`, the key is
bad, expired or calling from outside its IP allowlist. If most endpoints work
and one family answers `401`, the key simply lacks that scope — reissuing it
will not help unless the new key is created with that capability, which cannot
be added afterwards. The `401` guidance names both causes. The `403` branch is
kept for other Hudu versions and is marked unobserved.

## Behaviour the contract does not specify

These are cases where an endpoint exists but the documentation does not say what
it does. The tools describe the uncertainty rather than resolving it by
assumption.

**Cascade behaviour is unspecified for every delete except companies (D11).**
Whether deleting a network removes its IP addresses or orphans them, whether
deleting a folder takes its articles and subfolders with it, and what happens to
the items in a deleted rack are all absent from the contract. Only
`DELETE /companies/{id}` is documented as cascading, and it cascades to
everything inside the company (A3). For the rest, list the contents first so you
know what was at stake, and re-check afterwards what survived.

Other undocumented semantics, each recorded in the tool that exposes it:

- `network_type` is an integer with no published mapping (D1). The only value
  seen on a live instance was `0`, which says what is in use there rather than
  what it means (F7).
- Rack item `status` has no published meanings (D2). It is typed as an integer
  in the contract and observed as the strings `reserved` and `used` (F7), so the
  tools take a string.
- `max_wattage` and `power_draw` carry no unit (D3).
- Rack unit numbering is unexplained: which end of the cabinet holds the lowest
  unit, whether `start_unit`–`end_unit` is inclusive, and what happens on overlap
  are all absent, and no conflict response is documented (D4). The elevation on
  the rack record numbers every slot, so the direction in use on your instance
  can be read off `hudu_get_rack_storage`; an undocumented `descending_units`
  field is also present, but nothing published says what it contains (F8).
- `IpAddress.status` values appear only in prose, not as a schema enum (D5), and
  the prose is wrong about casing: a live instance stored `Assigned`, `DHCP`,
  `Reserved` and `Unassigned` (F7). Neither vocabulary is enforced here.
- Relation `fromable_type`/`toable_type` values appear only in a parenthetical
  (D6), and that list is provably incomplete — a live instance carried
  `IpAddress`, which it omits (F7). Not enforced here either.
- `in_company` on `GET /folders` is described in eight words (D7).
- Most definitions carry no `required` array (D8), so which fields a create
  actually needs is not derivable from the contract.
- `draft` on an article is readable and filterable but not writable (D9).
- Asset custom fields are asymmetric between read and write (D10).

## Endpoints that exist elsewhere but not here

Hudu's API changes between releases. Several endpoints exist only on newer
builds, and an older instance answers `404` for them — the same `404` it returns
for a record that does not exist, so the two are indistinguishable without
knowing the version.

This document does not name those endpoints, because the only artefact this
project has is the contract captured from one instance on 2026-08-04. Listing
endpoints from any other source would be exactly the kind of guess the rest of
this document exists to avoid. What can be said precisely is what is _absent from
the captured contract_, and that is the list above: no locations collection (C5),
no export status or retrieval (C6), no writes for password folders, procedures,
users or expirations (C11–C14), no layout delete (C15), no relation update (C16),
no matcher create (C17), and no filters on relations, websites-by-company or
archived articles (C7–C9). If your instance offers any of those, this server does
not use them, and the honest way to close the gap is to recapture
`/api-docs.json` from your instance and open an issue with the difference.

The reverse case also exists: an endpoint present in this contract may have
changed or been removed on a newer build. `hudu_get_api_info` is the first thing
to check when a tool that should work does not.

## Reporting

If you find behaviour that contradicts this document, or a contract difference
between your instance and the captured one, open an issue at
<https://github.com/ZenixSolutions/hudu-mcp/issues> with the endpoint, the field
and the Hudu version from `hudu_get_api_info`. Defects in the Hudu API itself
belong with Hudu; `reference/spec-defects.md` is the evidence base for that
report as well.
