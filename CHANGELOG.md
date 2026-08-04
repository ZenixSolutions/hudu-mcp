# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0, the tool surface is not yet stable: a minor version may add, rename or
remove tools.

## [Unreleased]

### Fixed

- **Six list tools returned nothing (correctness).** A contract run against a
  live Hudu 2.34.2 instance found that `GET /companies`, `/asset_layouts`,
  `/articles`, `/folders`, `/relations` and `/users` wrap their array in a
  single-key envelope, which the captured API document records for none of them.
  Those tools expected a bare array. `unwrapList` does not throw on a wrong
  shape — it returns an empty array — so `hudu_list_companies` reported a
  populated tenant as having no companies. Each envelope key is now declared,
  and `unwrapList` no longer short-circuits to an empty list when a declared key
  is missing from the body. Recorded as `docs/reference/spec-defects.md` F1.
- **Six get tools returned the envelope instead of the record.**
  `/companies/{id}`, `/asset_layouts/{id}`, `/articles/{id}`, `/folders/{id}`,
  `/procedures/{id}` and `/users/{id}` wrap the record under its singular name,
  so those tools handed back `{"company": {...}}` where a company was asked for
  and every field lookup on the result missed (F2).
- **A get could succeed and return nothing that said so.**
  `GET /companies/{id}` and `GET /articles/{id}` answer HTTP 200 with an empty
  body for an id that does not exist, which never reaches the error path. The
  get tools returned a bare `null`, readable as "the record is empty". They now
  return `found: false` with a notice naming the id and stating that no such
  record exists on the instance. No 404 is fabricated — the call succeeded (F3).
- **`401` guidance named the wrong cause.** A Hudu key that lacks a scope
  answers `401`, not `403`: a key without password access was rejected with
  `401` on `/asset_passwords` and `/password_folders`, and no `403` exists on
  that instance. The guidance now names key scope alongside a bad, expired or
  IP-blocked key, so an operator does not reissue a working key. The `403`
  branch is kept for other Hudu versions and marked unobserved (A7, F5).
- **`404` guidance claimed a missing record and an unrouted path were
  indistinguishable.** On 2.34.2 they are not: a missing record names its
  resource, an unrouted path answers a generic body. The guidance says to read
  the body (F3).

### Changed

- **`ip_addresses.status` is no longer a `z.enum`.** The six lower-case values
  came from the schema's prose; the API returns `Assigned`, `DHCP`, `Reserved`
  and `Unassigned`. The enum would have rejected every value the API actually
  stores, locally, before Hudu saw the call. It is now a string whose
  description names both vocabularies (D5, F7).
- **Relation `fromable_type`/`toable_type` are no longer a `z.enum`.** Live
  relations carry `IpAddress`, which appears in no published list, so the enum
  made a legitimate relation impossible to create (D6, F7).
- **`rack_storage_items.side` and `status` take strings, not integers.** The
  body schema types both as integers; the API stores `front`/`rear`/`both` and
  `reserved`/`used`. Observation wins, and there was no published integer
  mapping to send anyway (B7, D2, F7).
- `hudu_list_matchers` now explains that omitting `integration_id` produces an
  HTTP 500 rather than a validation error, so a 500 there is read as a missing
  parameter and not an outage (F6).
- Tool descriptions carrying undocumented values — IP status, relation types,
  rack side and status, `network_type` — name what was observed on Hudu 2.34.2
  and say plainly that it is one instance's data rather than a contract.

- **Credential leak through `response_format: "markdown"` (security).** Tool
  handlers rendered their Markdown view from the raw API record, before
  `stripSecrets` ran, and the rendered string was protected only by scrubbing
  the literal secret value out of it afterwards. That scrub could not match a
  secret the renderer had reshaped: a `password` nested inside another object is
  rendered via `JSON.stringify`, so any value containing a quote, a backslash or
  a newline appeared in escaped form, and any value crossing the 300-character
  display cut appeared as an unmatchable prefix. Either case returned real
  credential material with `HUDU_ALLOW_PASSWORD_REVEAL` unset. Markdown is now
  rendered by a callback that `executeTool` invokes on the already-stripped,
  already-budgeted payload; the by-value scrub is kept behind it.
- Markdown output is now derived from the character-budgeted payload, so it can
  no longer exceed the response budget or disagree with `structuredContent`.
- `notice` is scrubbed by value like the rest of a tool result. It is prepended
  to the model-visible text and no strip walked it.
- Upstream error bodies are redacted before being summarised into an error
  message. The error path never runs `stripSecrets`, so a 4xx or 5xx echoing the
  submitted attributes could carry `password` or `otp_secret` into the
  transcript.
- `--list-tools` named the wrong gate for tools withheld under `HUDU_READ_ONLY`.
  `hudu_reveal_password` is classed `Read`, so read-only never withholds it, yet
  it was reported as withheld by `HUDU_READ_ONLY` instead of by
  `HUDU_ALLOW_PASSWORD_REVEAL`.
- Markdown rendering shortens any single value to 300 characters. It now marks
  the cut and appends a note saying the values are incomplete, instead of
  returning the first 300 characters of an article body as if it were the whole
  thing.

## [0.1.0] - 2026-08-04

Initial release.

### Added

- 89 MCP tools covering the documented Hudu REST API surface: companies, assets
  and asset layouts, articles and folders, asset passwords and password folders,
  websites, networks and IP addresses, racks and rack storage items, relations,
  matchers, expirations, activity logs, procedures, magic dash, uploads, public
  photos, users, cards lookup, API info, and the export triggers.
- Secret-safe defaults. Hudu returns `password` and `otp_secret` as required
  properties of every record in `GET /asset_passwords`, so one unbounded call
  returns every stored credential and TOTP seed the key can see. Those fields
  are stripped recursively from every tool response in `executeTool`, leaving a
  placeholder so a model can tell that a value exists. Password metadata — name,
  username, URL, company — remains available.
- Capability gating through the environment only. `HUDU_READ_ONLY`,
  `HUDU_ALLOW_DESTRUCTIVE`, `HUDU_ALLOW_PASSWORD_REVEAL` and
  `HUDU_ALLOW_EXPORTS` all default to off, and a gated tool is not registered at
  all rather than registered-and-refusing. No tool argument can enable a gate,
  and no credential is accepted as a tool argument.
- Confirmation requirement on destructive operations: `confirm: true` in
  addition to the environment flag, with the impact stated in the tool
  description.
- Honest pagination. No Hudu collection endpoint returns a total count, and
  there is no envelope, no `X-Total-Count` and no `Link` header, so this server
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
  undocumented behaviour found in the captured Hudu API contract, including the
  five collections without pagination and the rack contents that cannot be
  listed through the documented API.

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

[Unreleased]: https://github.com/ZenixSolutions/hudu-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ZenixSolutions/hudu-mcp/releases/tag/v0.1.0
