# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0, the tool surface is not yet stable: a minor version may add, rename or
remove tools.

## [Unreleased]

### Fixed

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
