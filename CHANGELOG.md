# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0, the tool surface is not yet stable: a minor version may add, rename or
remove tools.

## [0.2.0] - 2026-08-04

This release exists because an external usability review of the published 0.1.0,
run against a live Hudu 2.34.2 instance, found real defects. Two of them are
security defects.

**Password writes were ungated while password reads were gated.** `hudu_create_password`,
`hudu_update_password` and `hudu_archive_password` were registered by default,
so a deployment whose key could not read a stored credential could still
overwrite or archive one — the destructive direction open while the read
direction was locked.

**Every mutating tool told MCP clients it was not destructive.** All 32 tools
that change something and are not classed `Destructive` — 13 `Create`, 17
`Update`, 2 `Admin` — carried `destructiveHint: false`, `hudu_archive_company`
and `hudu_update_password` included. A client that decides what to prompt about
from annotations prompted for none of them.

A third finding is not a vulnerability but reads like one in a transcript: a
withheld secret came back as a plausible 54-character string in a field named
`password`. The reviewer established it was not a credential by noticing that
all sixteen records carried the same value.

The rest of the review found tool descriptions that were wrong about the API,
a `--check` that reported a revoked key as working, and a list envelope that
described a response it had not sent. Those are below.

This is a minor bump rather than a patch. The registered tool surface changed
and the response shape of every password field changed; both are breaking for
anyone running 0.1.0.

### Migrating from 0.1.0

- **If you relied on creating, updating or archiving password records**, set
  `HUDU_ALLOW_PASSWORD_WRITE=1` in the server's environment. Without it those
  three tools are not registered and `hudu_delete_password` needs this gate and
  `HUDU_ALLOW_DESTRUCTIVE` together. Run `hudu-mcp --list-tools` to confirm what
  your environment registers.
- **If any code reads the withheld string** `[withheld: password reveal is disabled on this server]`,
  switch it to the `password_redacted` / `otp_secret_redacted` booleans. No field
  named `password` or `otp_secret` ever holds a string again; a withheld value is
  `null` with a sibling flag set to `true`, and a field that genuinely stores
  nothing is `null` with no flag.
- **If your client prompts from MCP annotations**, expect prompts on 19 tools
  that did not produce them before — every `Update` and `Admin` tool.
- **If you parse `count` on a list result**, it is now always the number of
  records in `items`. Where the output budget dropped records, the page's own
  figure is reported separately as `records_on_page`.
- Nothing else in the environment or the tool names changed. No tool was
  renamed or removed.

### Security

- **Password writes now need `HUDU_ALLOW_PASSWORD_WRITE`, which defaults off.**
  It gates `hudu_create_password`, `hudu_update_password` and
  `hudu_archive_password`, and combines with `HUDU_ALLOW_DESTRUCTIVE` on
  `hudu_delete_password`. It is deliberately a separate gate from
  `HUDU_ALLOW_PASSWORD_REVEAL`: documenting a newly issued credential without
  being able to read existing ones is a legitimate posture, and folding the two
  together would force an operator to grant vault-wide reads in order to permit
  one write. Neither gate opens the other. Default registration drops from 70
  tools to 67. **Breaking.**
- **`Update` and `Admin` tools now carry `destructiveHint: true`.** The MCP
  definition is that `true` means the tool may perform destructive updates and
  `false` means it performs **only additive** ones, which is a wider claim than
  "deletes something". A PUT replaces the prior value of every field it carries
  and this API offers no undo, so `Read` and `Create` are the only classes that
  can honestly claim otherwise. `Update` keeps `idempotentHint: true` —
  replaying the same PUT lands in the same state, which is a statement about
  retry safety and not about what the first call cost. **Breaking for clients
  that branch on annotations.**
- **A withheld secret is now `null` plus a flag, not a string.**
  `hudu_list_passwords` returned a field literally named `password` holding
  `[withheld: password reveal is disabled on this server]` — 54 characters that
  look like a credential, once per record. Establishing that those were not
  credentials required noticing that every record's value was identical, and
  nothing downstream does that: a model that trusts a field name pastes the
  value into a ticket, and a script that treats a non-empty `password` as a
  password is correct to do so. The rule is now structural and absolute: no
  field named `password` or `otp_secret` ever holds a string again. A withheld
  value becomes `null` with a sibling `password_redacted: true`, and a field
  that was already null, empty or absent is passed through untouched with **no**
  flag — so "this record documents an account with no stored password" stays
  distinguishable from "this record's password was withheld from you". The
  human-readable explanation moved to the response notice, where it sits under
  no key at all. `hudu_reveal_password` is unaffected and still returns the real
  value. **Breaking.**
- `findSecretFields` and `collectSecretValues` no longer exempt any string under
  a secret's name. A walker with an exemption list is a walker that can be
  fooled into ignoring a value by making it resemble the exemption.

### Added

- `HUDU_ALLOW_PASSWORD_WRITE`, the fifth capability gate. Documented in
  `README.md`, `SECURITY.md`, `docs/security.md`, `--help` and `.env.example`.
- `pagination_supported` on every list envelope: a boolean stating what the
  prose in `pagination_note` used to state only in prose.
- `records_on_page` on a truncated list envelope, present only when fewer
  records were emitted than the page held.
- `completeness_caveat` on a list envelope whose contents are limited
  independently of paging. It is carried as its own key as well as appended to
  `pagination_note`, so regenerating that note under truncation cannot silently
  drop it.
- `--check --offline`, which keeps 0.1.0's syntax-only behaviour for a container
  build with no network and says explicitly that nothing was verified.
- Exit code 69 (`EX_UNAVAILABLE`) from `--check` for the case where the
  environment is well-formed and Hudu refused or could not be reached. A bad
  environment still exits 78.
- `fields` on 15 of the 16 `hudu_get_*` tools. It was accepted and silently
  ignored before. The exception is `hudu_get_api_info`, which returns two fields
  and takes no arguments at all.
- New defect F8 in `docs/reference/spec-defects.md`: the rack record returns ten
  fields the `RackStorage` definition omits — `front_items`, `rear_items`,
  `descending_units`, `utilization`, `power_draw_utilization`,
  `power_utilization`, `serial_number`, `asset_tag`, `location_name` and
  `location_url` — recorded with the observed slot shape. `location_name` and
  `location_url` soften C5 for racks; `descending_units` is named but
  deliberately left uninterpreted, since what it contains was not established.
  Hudu misspells one key: a slot carries `reserved_messsage` with three s's
  while the item nested inside it uses `reserved_message` with two. Both
  spellings are passed through unchanged rather than normalised.
- `docs/adr/ADR-003-security-posture-corrections.md`, which records the two
  security corrections above and supersedes the parts of ADR-002 that produced
  them.

### Changed

- **`--check` now makes a real request.** It issues `GET /api_info` — the one
  endpoint that needs no ids and no scope beyond a working key — reports the
  Hudu version it reached, and on failure prints the existing `HuduApiError`
  guidance, which already distinguishes a bad key from an unreachable host from
  a scope problem. 0.1.0 validated the shape of `HUDU_BASE_URL` and the
  non-emptiness of `HUDU_API_KEY` and printed "configuration is valid"; a
  reviewer whose key had been rotated mid-session spent nine calls and a
  near-filed bug report on empty lists that a one-second check would have
  explained. The string "configuration is valid" no longer appears in the
  binary: nothing that has not talked to Hudu says a configuration works.
  Neither mode prints the API key.
- **Truncation metadata is emitted before `items`.** `hudu_list_rack_storages`
  answered `page_size: 21`, `count: 5`, `page_was_full: false` and a
  `pagination_note` calling the result "the complete set for the filters given",
  with the correcting `truncated: true` at the very end of the object, after
  `items`. Clients clip long tool results, so the claim was read and the
  correction was not. `truncated`, `records_on_page` and `truncation_note` now
  precede `items` in both JSON and Markdown output.
- **`pagination_note` is regenerated after a cut**, so it describes what was
  actually emitted and can no longer claim completeness. On a paginated endpoint
  it also says that `next_page` resumes after everything on the page rather than
  after the records shown, so paging on alone never recovers what was dropped.
  On an unpaginated endpoint it says plainly that narrowing the filters is the
  only remedy, and that where no filter is narrow enough the dropped records
  cannot be reached at all.
- **`count` is unambiguously "records in `items`"** everywhere, with the page's
  own figure reported as `records_on_page` when the two differ.
- `hudu_list_companies` now discloses that it omits archived companies. On
  2.34.2 the instance held 27 companies and the tool returned 22; the five
  missing ones were archived, and 64 assets pointed at them. No `archived`
  argument was added, because there is nothing behind it: `?archived=true` and
  `?archived=false` both return the same 22 records, and `/companies` ignores
  unrecognised query parameters instead of rejecting them the way `/networks`
  does (F4 is per-endpoint, not global), so the argument would look like a
  working filter and do nothing. The exclusion is disclosed in the tool
  description and in every result's `pagination_note` and `completeness_caveat`,
  pointing at `hudu_get_company`, which does reach archived companies by id.
- Rack tool descriptions state where a rack's elevation is and describe a slot
  concretely enough to read without guessing. `hudu_list_rack_storage_items` is
  described as what it is — the instance-wide "where is asset X mounted?" view.
- `hudu_list_activity_logs` describes what its entries actually carry.
  `action_message` is a filter name and no such field exists on an entry; the
  matching value is read back as `action`, and `resource_type`/`resource_id` are
  read back as `record_type`/`record_id`. The description now also states that
  there is no "changes only" filter, so `viewed` events — which dominate an
  active instance — must be excluded one `action_message` value at a time or
  client-side, and that the newest entry for a record is frequently a view and
  therefore not its newest change. `details` is a JSON string holding a
  post-state snapshot with no before value and no field-level diff, so "what
  changed" needs two consecutive `updated` entries compared by hand. The
  Markdown heading field moved from `action_message`, which never existed on a
  record, to `action`.
- `hudu_get_api_info` says that `date` is not reliably a date: Hudu 2.34.2
  answers `2026-31-05`, apparently year-day-month. The field was already passed
  through unparsed; the description now tells a caller not to compare or convert
  it.
- `search` and `name` are no longer described as if they behaved the same. On
  2.34.2 `hudu_list_assets{name:"UDM Pro"}` matched whole and
  case-insensitively, excluding "UDM Pro Max", while `{search:"UDM"}` matched as
  a substring and returned more. `hudu_list_users` offers `search` and no
  exact-name filter at all, and now says so and points at `email`.

### Fixed

- **A rack's contents can be listed, and this server said they could not.**
  Every rack record from `GET /rack_storages` and `GET /rack_storages/{id}`
  carries `front_items` and `rear_items`: one slot per rack unit on each face,
  each slot listing what is mounted there with `asset_id`, `asset_name` and
  `asset_url`. That is a complete per-unit elevation, and `hudu_get_rack_storage`
  was already returning it — while `hudu_list_rack_storage_items` told the caller
  that "this API does not expose it" and to decline the question. An external
  reviewer called the endpoint and found the elevation after nearly refusing an
  answerable question on that instruction. The refusal instruction is gone.
  Defect C4 is rewritten as a correction rather than deleted, because the
  reasoning that produced it is reusable: the `RackStorage` definition in the
  captured contract declares twelve scalar properties and no arrays, so reading
  the schema alone gives exactly the wrong answer, and a schema that omits a
  field is indistinguishable from an API that lacks it. What remains true is
  narrower — a rack storage _item_ still carries no rack id, and no filter scopes
  items to a cabinet.
- `fields` on a `hudu_get_*` tool is no longer accepted and discarded. A caller
  who had learned the argument from the list tools passed it, had it dropped by
  schema validation without a word, and received the whole record — and a single
  asset or company can carry a multi-kilobyte HTML `notes` blob. Projection runs
  after the fetch, so it reduces what is read rather than what Hudu sends, and
  unknown field names are still ignored rather than rejected.

## [0.1.0] - 2026-08-04

Initial release.

### Added

- 89 MCP tools covering the documented Hudu REST API surface: companies, assets
  and asset layouts, articles and folders, asset passwords and password folders,
  websites, networks and IP addresses, racks and rack storage items, relations,
  matchers, expirations, activity logs, procedures, magic dash, uploads, public
  photos, users, cards lookup, API info, and the export triggers.
- Secret-safe defaults. Hudu returns `password` and `otp_secret` as required
  properties of every record in `GET /asset_passwords` — confirmed against a live
  instance, not merely documented — so one unbounded call returns every stored
  credential and TOTP seed the key can see. Those fields are stripped recursively
  from every tool response in `executeTool`, leaving a placeholder so a model can
  tell that a value exists. Password metadata — name, username, URL, company —
  remains available.
- Capability gating through the environment only. `HUDU_READ_ONLY`,
  `HUDU_ALLOW_DESTRUCTIVE`, `HUDU_ALLOW_PASSWORD_REVEAL` and
  `HUDU_ALLOW_EXPORTS` all default to off, and a gated tool is not registered at
  all rather than registered-and-refusing. No tool argument can enable a gate,
  and no credential is accepted as a tool argument.
- Confirmation requirement on destructive operations: `confirm: true` in
  addition to the environment flag, with the impact stated in the tool
  description.
- Honest pagination. No Hudu collection endpoint returns a total count — no
  `total`, no `X-Total-Count`, no `Link` header, and none of the thirteen
  endpoints that wrap their array carries a count beside it — so this server
  emits neither `total` nor `has_more`. List responses report `page_was_full`,
  and the five collections that document no pagination at all report that
  instead of implying a page.
- Percent-encoding of every interpolated path segment, with malformed segments
  rejected before a request is issued.
- Client-side rate limiting and concurrency control. Hudu publishes a limit of
  300 requests per minute but documents no `429` and no rate-limit headers, so
  the client stays under the line rather than reacting to being told it crossed
  it. Defaults are 120 requests per minute and 4 concurrent requests.
- Error translation that turns API failures into guidance a model can act on,
  with request headers — including the API key — redacted from every message.
- Response shaping: `json` or `markdown` output, top-level field projection, and
  a character budget on large lists.
- CLI diagnostics: `--version`, `--help`, `--check` to validate configuration,
  and `--list-tools` to print what would be registered under the current
  environment along with what is withheld and why.
- `docs/reference/spec-defects.md`, recording every contradiction, gap and
  undocumented behaviour found in the captured Hudu API contract, and — in
  section F — every place the live API differs from it.
- An opt-in contract suite (`npm run test:contract`) that checks the claims in
  that document against a running instance, and
  `scripts/contract-recon.mjs`, a read-only walk of every documented `GET` that
  records observed shapes. Both are `GET`-only by construction.

### Verified before release

This release was built against Hudu's published OpenAPI document and then
checked against a running Hudu 2.34.2 instance and reviewed by readers who had
not written the code. Both passes found defects. None of them ever reached a
user, because none of this had shipped — but a package asking to be trusted with
a credential vault should say what its own testing caught, so:

**Found by contract testing against a live instance.** The published document is
wrong about response shape. Thirteen list endpoints wrap their array and nine
single-record endpoints wrap the record; the document records the envelope for
only five of them. Eight get-tools were returning `{"company": {...}}` where a
company was asked for — including `hudu_reveal_password`, whose entire purpose is
to return one specific credential and which was returning an object containing
one. Three Zod schemas were built from the document's prose and would have
rejected values the API actually returns: `ip_addresses.status` comes back
capitalised where the prose is lower-case, relations carry an `IpAddress` type
the prose omits, and `rack_storage_items.side` returns strings where the schema
says integer. Each is now a documented string rather than a provably wrong enum.
`GET /companies/{id}` answers `200` with an empty body for an id that does not
exist, so a get could succeed and return nothing that said so; get-tools now
report `found: false` rather than a bare `null`. A key that lacks a scope
receives `401`, not `403` — no `403` exists on the instance at all — so the `401`
guidance names key scope alongside a bad or expired key, and an operator does not
reissue a working one.

**Found by independent review.** `response_format: "markdown"` returned real
credential material with `HUDU_ALLOW_PASSWORD_REVEAL` unset: handlers rendered
their Markdown from the raw record before stripping ran. The first fix scrubbed
the rendered string for the literal secret value, and a second reviewer showed
that was not enough — the renderer reshapes the value first, so a password
containing a quote, a backslash or a newline appeared escaped and matched
nothing. Markdown is now rendered by a callback invoked on the already-stripped,
already-budgeted payload, so no unstripped value can reach a renderer. Also
fixed: `buildPath` allowed a `..` segment to escape the API prefix, since
`encodeURIComponent` leaves dots alone and the URL parser collapses them; the
generic error path did not scrub the API key; upstream error bodies were never
stripped, so a `422` echoing a submitted password carried it into the transcript;
and `notice` text bypassed every strip.

Each of these is pinned by a regression test that fails without its fix.

### Known limitations

- File upload (`POST /uploads`, `POST /public_photos`) is not implemented; those
  endpoints are `multipart/form-data` and the contract documents no request
  body. The read side of both is implemented.
- `GET /cards/jump` is not implemented. It is a browser redirect helper and is
  documented as working without API key authentication.
- `fields` is deliberately absent from `hudu_update_asset_layout`: the contract
  describes the field list two incompatible ways between create and update, and
  guessing wrong would rewrite the field definitions of every asset on the
  layout.
- Exports can be started but not retrieved or tracked. This Hudu version
  documents no export status endpoint.
- A rack storage item carries no reference to its rack anywhere in the API, so
  `hudu_list_rack_storage_items` is instance-wide and cannot be grouped by
  cabinet. (This entry originally said a rack's contents could not be listed at
  all. That was wrong — see 0.2.0.)
- stdio transport only. ChatGPT and Grok connectors cannot execute a local stdio
  server and are not supported in this release.
- Everything above was verified against a single instance running Hudu 2.34.2.
  A different version may differ; `hudu_get_api_info` reports yours, and
  `npm run test:contract` will tell you whether this server's assumptions still
  hold against it.

[0.2.0]: https://github.com/ZenixSolutions/hudu-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ZenixSolutions/hudu-mcp/releases/tag/v0.1.0
