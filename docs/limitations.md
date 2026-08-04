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
identically for a missing record and for an endpoint that does not exist on that
build, so the version is often the only way to tell the two apart.

## Counting and pagination

**No collection endpoint returns a total count (C1).** There is no envelope, no
`total`, no `X-Total-Count` and no `Link` header anywhere in the contract.
Whether more records exist can only be inferred from whether a page came back
full.

This server therefore emits no `total` and no `has_more`. Both would have to be
invented, and an agent reading `has_more: false` would report a partial inventory
as complete. `page_was_full` is the honest signal, and `pagination_note` states in
plain language what is and is not known. "How many assets does this client have?"
is not a question the API answers; it is a question you answer by paging to the
end and counting.

**Five collections have no pagination whatsoever (C2).** `/networks`,
`/ip_addresses`, `/rack_storages`, `/rack_storage_items` and `/uploads` document
neither `page` nor `page_size`. The corresponding tools send neither and report
in the envelope that there is no further page to request. On a populated IPAM
range that is a very large single response with no way to page it — filter, or
accept a client-side truncation you cannot page past.

**One collection paginates without a size control (C3).**
`GET /asset_layouts` documents `page` but not `page_size`, so
`hudu_list_asset_layouts` offers no `page_size` argument. Offering one would
invite a caller to ask for 100 records, receive the server's own default, and
read the short page as the end of the data.

**No maximum `page_size` is published (D12).** The API describes a default of 25
and nothing else. This client clamps at 100 — a value it has validated — and
rejects larger requests at the schema rather than letting the server silently
alter them. If your instance accepts more, this client will still not send it.

## Questions the API cannot answer

**A rack's contents cannot be listed (C4).** This is the sharpest gap in the
contract. `RackStorageItem` carries no reference to its rack: the string
`rack_storage_id` does not appear anywhere in the API, and no list filter scopes
items to a rack. `rack_storage_role_id` is documented as "the unique ID of the
rack storage role" and travels beside `rack_storage_role_name`, `_description`
and `_hex_color` — a colour-coded classification, not the cabinet. **"What is
mounted in rack 12?" has no documented answer.** The reverse direction works:
filter rack items by `asset_id` to find where a known device is racked.

**There is no locations endpoint (C5).** Networks and racks both carry a
`location_id`, and nothing lists or resolves those ids. They can be copied from
an existing record and nothing else.

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

## Not implemented in 0.1.0

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

**No remote transport.** 0.1.0 speaks stdio only. See
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

**No `403` is documented anywhere (A7)**, despite keys being scoped at creation
for password access, destructive actions, exports, IP allowlist and company
scope. A scope failure therefore arrives as something else, most often `401` or
`404`. That makes "the key lacks this permission" and "the record does not exist"
hard to tell apart. If reads work but one family of records is consistently
empty, suspect the key's scope before you conclude the data is missing. The
client still translates a `403` into scope-specific guidance if one ever arrives.

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

- `network_type` is an integer with no published mapping (D1).
- Rack item `status` is an integer with no published meanings (D2).
- `max_wattage` and `power_draw` carry no unit (D3).
- Rack unit numbering is unexplained: which end of the cabinet holds the lowest
  unit, whether `start_unit`–`end_unit` is inclusive, and what happens on overlap
  are all absent, and no conflict response is documented (D4).
- `IpAddress.status` values appear only in prose, not as a schema enum (D5).
- Relation `fromable_type`/`toable_type` values appear only in a parenthetical
  (D6), so the list may not be exhaustive on newer versions.
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
