# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0, the tool surface is not yet stable: a minor version may add, rename or
remove tools.

## [Unreleased]

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
- A rack's contents cannot be listed. Rack storage items carry no reference to
  their rack anywhere in the documented API.
- stdio transport only. ChatGPT and Grok connectors cannot execute a local stdio
  server and are not supported in this release.
- Everything above was verified against a single instance running Hudu 2.34.2.
  A different version may differ; `hudu_get_api_info` reports yours, and
  `npm run test:contract` will tell you whether this server's assumptions still
  hold against it.

[Unreleased]: https://github.com/ZenixSolutions/hudu-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ZenixSolutions/hudu-mcp/releases/tag/v0.1.0
