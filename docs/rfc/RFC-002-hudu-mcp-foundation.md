# RFC-002: Hudu MCP Server — Foundation, Surface, and Secret Handling

- **Status:** Approved — implementation complete. Recorded for traceability, not
  as a blocking gate. See Approval Requested for why, and for the lifecycle
  deviation that entails.
- **Author:** Claude (acting as Repository Architect / API-MCP Architect /
  Security Engineer per `ACTIVATION_MATRIX.md`)
- **Date:** 2026-08-04
- **Related issue:** None. No tracked issue was opened; the work was directed
  conversationally by the Project Owner. This is a deviation from lifecycle
  stage 1 and is recorded rather than concealed.
- **Reviewers:** Independent review was performed against the implementation, by
  a reviewer that was not the implementing author. It found three defects, all
  security-relevant; they are listed in full under Security Impact. This
  _document_ has had no Chief Architect or Devil's Advocate review.
- **Owner decision:** Approved in advance. Josh pre-approved the foundational
  decisions — carried over from the already-approved RFC-001 stack — and
  directed that implementation proceed in the same session.

---

## Summary

This RFC records the foundational engineering decisions for
`@zenixsolutions/hudu-mcp`, a public MCP server for the Hudu IT documentation
REST API: language and runtime, repository layout, transport, distribution,
tool design, security posture, release conventions, and identity.

It differs from RFC-001 in one important respect, and the difference should be
stated at the top rather than buried. RFC-001 was written before implementation
and requested approval as a gate. This document was written after a working
0.1.0 existed. The Project Owner explicitly pre-approved the foundational
decisions and instructed that the build proceed in a single session, so the
normal sequence — RFC, architecture review, owner approval, then implementation
— was not followed. This RFC is therefore a **traceability record under Article
XII**, not a request for permission. Pretending otherwise would make the
governance record less useful than no record at all.

Four decisions were made by the Project Owner and are recorded as approved
inputs rather than open questions:

| Decision            | Owner selection                                                                      |
| ------------------- | ------------------------------------------------------------------------------------ |
| Positioning         | Full-surface complement to Hudu's own first-party MCP server, not a competitor to it |
| API contract source | Captured from the authenticated `/api-docs.json` of a live instance via browser      |
| Password handling   | Metadata by default; single-record reveal behind an environment gate                 |
| Scope               | Build through to a working 0.1.0 in one session                                      |

Everything else in this document is a decision made under those four, by the
roles named above, and is open to revision by the owner at any time.

---

## Problem

**Hudu already ships an MCP server.** It is first-party, built into the product
at `/mcp`, authenticated with OAuth, and covers knowledge base articles,
read-only asset access, and activity logs. It does not expose passwords. For a
user who wants an assistant to read their documentation, that server is the
right answer and this one is not.

A second server needs a reason. There are three, and only the third is a
durable differentiator.

1. **Surface.** The captured contract documents 56 paths and 96 operations. The
   official server reaches a small fraction of them. Networks, IP addresses,
   racks and rack storage items, relations, matchers, expirations, magic dash,
   websites, folders, procedures, asset layouts, uploads, exports and every
   write path are outside it. An MSP that wants an assistant to _maintain_
   documentation rather than read it cannot do that work through the
   first-party server.

2. **Deployment shape.** The official server is OAuth-brokered and tied to the
   hosted product. An API-key server runs wherever the operator puts it, scoped
   by a key whose permissions are fixed at creation — which, as it happens, is a
   stronger control than anything this codebase can implement (see Security
   Impact). Some environments cannot or will not run an OAuth flow to a vendor.

3. **Everyone else is doing it wrong, and nobody is doing it visibly.** Every
   community Hudu MCP server surveyed exposes the passwords API in full: a
   single `hudu_list_passwords` call returns `password` and `otp_secret` for
   every record, because that is what `GET /asset_passwords` returns and nobody
   intercepted it. None of them appear on a public MCP registry. None show
   meaningful automated test coverage. **That is the differentiator, and it
   should be stated as one:** the value of this project is not the tool count,
   it is being the Hudu MCP server that is safe by default, published where
   people can find it, and demonstrably tested. Surface is table stakes;
   nobody gets credit for wrapping 96 endpoints.

If the third reason does not hold — if the tests are thin or the secret handling
leaks — then this project has no justification that the first-party server does
not already satisfy. That framing is what drove the security design, and it is
also why the three defects found in review are reported here without softening.

---

## Goals

- Full coverage of the documented Hudu REST API surface, typed and validated.
- Secret-safe by default: no configuration, and no stored credential or OTP seed
  reaches a model.
- Tool design an LLM can use correctly on first attempt, per
  `standards/ai-interface-standard.md` and Article X.
- A repository meeting `standards/repository-standard.md` and credible enough
  for a security-conscious MSP to read the source before installing.
- Test coverage that is evidence, not decoration — specifically including
  regression tests pinning every security defect found.
- An honest, committed record of what the Hudu contract actually says, including
  where it is wrong.

## Non-Goals

- Competing with or replacing Hudu's first-party MCP server. Where the official
  server is sufficient, the README should say so.
- OAuth, multi-tenancy, or credential brokering. API key from the environment,
  one instance per process.
- Remote HTTP transport in 0.1.0. Deferred; see ADR-001 and Open Questions.
- Undocumented API surface. Article IV: documented interfaces only, gaps
  reported rather than guessed around.
- File upload. `POST /uploads` and `POST /public_photos` are
  `multipart/form-data` and the contract documents no request body for them
  (`spec-defects.md` E1).
- Convenience parity with community servers where that parity is the thing that
  makes them unsafe.

---

## Current State

**Repository:** `/home/claude/hudu-mcp`. Functionally complete, not yet clean.
Measured at the time of writing: 16 test files, **731 tests passing** and 6
skipped (the opt-in contract suite); `typecheck` and `build` pass. `lint`
reports **21 errors** and `format:check` reports **13 unformatted files**, so
`npm run validate` — which is what CI runs, on Node 20 and Node 22, alongside an
install smoke test and a committed-credential scan — **does not currently
pass**. These are lint and formatting failures rather than behavioural ones, and
several are in files still being edited elsewhere in the same session, but they
are stated as measured rather than as intended: Article XIV requires objective
evidence for a completion claim, and "validate passes" is a completion claim. It
must be true before the initial commit, not after it.

**Implementation as built:** 89 tools. Under the default configuration 70
register and 19 are withheld (16 Destructive, 2 export-gated Admin, 1 password
reveal). Under `HUDU_READ_ONLY=1`, 40 register. By class: 41 Read, 17 Update,
16 Destructive, 13 Create, 2 Admin. Runtime dependencies are
`@modelcontextprotocol/sdk` and `zod`, and nothing else.

**API contract:** captured from a live instance's authenticated
`/api-docs.json` on 2026-08-04 and committed at
`docs/reference/api-docs.json`. Swagger 2.0, `info.version` 1.0, `basePath`
`/api/v1`, **56 paths, 96 operations, 23 definitions**. Auth is the `x-api-key`
header. The description publishes a rate limit of 300 requests/minute and a
default page size of 25.

### What the captured contract changed about the design

Full findings are in `docs/reference/spec-defects.md`. These are the ones that
materially changed what was built. The numbering is that file's.

| #   | Finding                                                                                                                                                                        | Consequence for this server                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `Asset_Password` lists `password` and `otp_secret` among its **required** properties, and `GET /asset_passwords` returns an array of that model                                | One unfiltered list call returns every credential and every TOTP seed the key can see. This single fact drove the whole architecture: `src/security/secrets.ts` exists because of it, stripping is central rather than per-tool, and reveal is one record at a time behind an environment gate |
| A2  | `DELETE /activity_logs` takes a required `datetime` and deletes everything from that point — no id, no dry run, no documented count, no undo                                   | Classified Destructive, gated on `HUDU_ALLOW_DESTRUCTIVE` **and** `confirm: true`, with the impact stated in the description. It is the call an attacker makes to erase their tracks, so it gets the strongest gate available                                                                  |
| A4  | `DELETE /magic_dash` deletes by matching `title` + `company_name` in the body, not by id                                                                                       | Shipped as a separate tool (`hudu_delete_magic_dash_item_by_title`) rather than folded into the id-based delete, so its different failure mode — a wrong title silently matches nothing, a right-but-unintended one destroys a tile — is visible in the name and the description               |
| A7  | No `403` is documented anywhere, despite keys being scoped at creation for password access, destructive actions, exports, IP allowlist and company                             | A scope failure arrives as `401` or `404`. Error messages cannot claim to distinguish "the key lacks this permission" from "the record does not exist", and `SECURITY.md` states this as a limitation rather than papering over it                                                             |
| A8  | `429` is documented nowhere, and no `Retry-After` or `X-RateLimit-*` header appears, despite the published 300/minute limit                                                    | Rate limiting is client-side and pre-emptive. Defaults are 120 req/min and 4 concurrent — under half the published ceiling — because the server cannot be relied on to say when the line is crossed                                                                                            |
| B1  | `GET /asset_layouts` documents its 200 response as a single object where the endpoint returns a collection                                                                     | `unwrapList` tolerates both shapes rather than trusting the declared schema. The same helper absorbed the wrapped-vs-bare-array inconsistency across the other list endpoints                                                                                                                  |
| B6  | `POST /asset_layouts` takes `fields` as an array of objects; `PUT /asset_layouts/{id}` documents it as an array of bare strings. Both cannot be right                          | `fields` is **deliberately absent** from `hudu_update_asset_layout`. Guessing wrong would rewrite the field definitions of every asset on the layout. A capability was dropped rather than a coin flipped on destructive input                                                                 |
| B8  | `DELETE /networks/{id}` answers `200` with a JSON body where every other delete answers `204`                                                                                  | The delete factory treats both as success and reports the status back, rather than encoding one endpoint's exception into a special case                                                                                                                                                       |
| C1  | No collection endpoint returns a total. No envelope, no `total`, no `X-Total-Count`, no `Link` header                                                                          | `total` and `has_more` are **never emitted**, because both would have to be invented. `page_was_full` is the only honest signal. An agent reading `has_more: false` would report a partial inventory as complete, and that is a correctness failure disguised as a convenience feature         |
| C2  | Five collections document no pagination at all — `/networks`, `/ip_addresses`, `/rack_storages`, `/rack_storage_items`, `/uploads`                                             | Those list tools have no `page` or `page_size` arguments and say so, rather than offering parameters the endpoint ignores. On a populated IPAM range this is a large single response with no way to page it, and the tool description says that too                                            |
| C4  | A rack's contents cannot be listed. `RackStorageItem` carries no reference to its rack; `rack_storage_id` does not appear anywhere in the contract                             | "What is mounted in rack 12?" is not answerable through the documented API. No tool claims to answer it. Article IV forbids inventing the relationship, and inventing it would produce a confidently wrong rack diagram                                                                        |
| D10 | Asset custom fields are asymmetric: writes take `custom_fields` (array of objects keyed by snake_cased label), reads return `fields` (array of `{id, label, value, position}`) | Both shapes are modelled explicitly and the asymmetry is documented in the tool descriptions, because a model that assumes symmetry will write a field that reads back as nothing                                                                                                              |
| D12 | No maximum `page_size` is published — only the default of 25                                                                                                                   | `MAX_PAGE_SIZE` is clamped at 100, a value validated rather than assumed, and values above it are rejected at the schema rather than silently altered by the server                                                                                                                            |

**Documentation is being written in the same session and is incomplete at the
time of writing.** `README.md`, `docs/quickstart.md` and `docs/installation.md`
exist; `docs/limitations.md` does not, and it is referenced by `src/config.ts`,
by `docs/reference/spec-defects.md`, and twice by the README. A dangling
reference in a shipped file is a real gap rather than a formality, and it is
called out again under Documentation Impact.

---

## Evidence and Assumptions

**Evidence.** The Swagger document served by a live Hudu instance at
`/api-docs.json`, captured through an authenticated browser session and
committed verbatim at `docs/reference/api-docs.json` alongside a derived
96-entry operation inventory. A read of Hudu's published documentation for its
own MCP server. A survey of the community Hudu MCP servers findable on GitHub
and of the public MCP registries. The Engineering OS corpus. The MCP
specification. The implementation itself, and the independent review of it.

**Assumptions requiring validation.** Numbered locally to this RFC; these are
unrelated to the `A`-prefixed items in `spec-defects.md`.

- **A1. The captured contract matches live behaviour on the captured instance.**
  Partially validated: an opt-in contract suite exists at `tests/contract/`
  behind `HUDU_CONTRACT_TESTS=1`. It has not been run against the live Zenix
  tenant as part of this work, so at the time of writing this is asserted, not
  demonstrated. See Open Questions.
- **A2. The contract differs across Hudu versions.** Treated as near-certain
  rather than assumed. A third-party OpenAPI snapshot of a newer Hudu version,
  consulted during discovery, listed **78 paths against our 56** — a difference
  far too large to be capture error. Consequence: this server targets the
  contract it captured and says which instance it came from. It must not
  advertise endpoints it has never seen a document for, and it should not
  silently break when a newer instance adds them. That snapshot is not vendored
  in this repository; the comparison is recorded here as a discovery finding,
  not as a committed artifact.
- **A3. Rate-limit behaviour is undocumented in every respect that matters.**
  The 300/minute figure appears in prose only; no `429`, no headers, no window
  semantics (`spec-defects.md` A8). Mitigation is to stay well under it rather
  than react to it. Validating this properly needs a deliberate load test
  against a scratch instance, which has not been done.
- **A4. A permission failure is indistinguishable from a missing record.** No
  `403` is documented (A7). This is an assumption about how the API reports
  scope failures, and it is the assumption behind every "Hudu answers 404 for
  both a missing record and an unrouted path" line in the tool descriptions. It
  can only be validated by deliberately calling an endpoint with an
  insufficiently scoped key.
- **A5. `page_was_full` is a sufficient completeness signal for a model.**
  Unvalidated behaviourally. It is honest, which `has_more` would not be, but
  whether models actually act on it correctly is an empirical question nobody
  has answered.
- **A6. Undocumented cascade behaviour is real.** `spec-defects.md` D11 records
  that cascade is unspecified for every delete except companies. The delete
  tools state the uncertainty in their impact text instead of asserting a
  behaviour. Validation requires destructive testing on a scratch instance.

---

## Constraints

- `CONSTITUTION.md` Article III priority order: Security, Correctness,
  Maintainability, then usability. Feature completeness ranks seventh, which is
  the licence for every capability reduction in D6.
- Article IV: only documented API surface.
- Article VI: the implementation author may not be the sole reviewer.
- Article VIII: secrets never committed, logged, echoed, exposed in errors, or
  in examples; controls verified rather than assumed.
- Article IX: destructive and materially consequential actions require explicit
  confirmation and described impact.
- `standards/security-standard.md`: classify every public operation as Read,
  Create, Update, Admin, or Destructive.
- `standards/typescript-standard.md` is Engineering OS's only language
  standard, and it requires transport/domain/API/presentation layer separation
  and review of material dependencies.
- **The Hudu API key's scope is fixed at creation and cannot be widened later.**
  This is not our control, it sits outside this software, and it is stronger
  than anything in this codebase. Every design decision below is
  defence-in-depth on top of it, and `SECURITY.md` says so in those words.
- A single session for design and implementation. The owner set this; it is a
  real constraint on how much could be validated rather than asserted.

---

## Alternatives Considered

**Wrapping the official Hudu MCP server.** _Rejected._ It exposes articles,
read-only assets and activity logs over OAuth. Wrapping it would inherit that
surface exactly and add a hop — it cannot produce write access, IPAM, racks,
relations or passwords, because those are not behind it. A wrapper is the right
answer when the underlying server has the capability and the wrong interface;
here the capability is absent.

**Forking a community Hudu MCP server.** _Rejected._ The surveyed servers share
the defect that motivated this project: unmediated passwords. Fixing that is not
a patch, it is an inversion of the response path — stripping has to be
structural and central, applied on the way out of every tool, or the next tool
someone adds leaks again. On top of that, none carry tests to preserve, and a
fork inherits a git history and a licence posture we would have to audit anyway.
Rewriting against a freshly captured contract was lower risk than repairing
someone else's reverse-engineered understanding of it.

**Python / FastMCP.** _Rejected, and not on technical grounds._ Engineering OS
defines exactly one language standard, `standards/typescript-standard.md`.
Choosing Python would require authoring and getting a second language standard
approved _first_ — that is a governance prerequisite, not a preference, and
`governance/decision-hierarchy.md` does not permit skipping it because the
alternative is convenient. FastMCP is a perfectly good framework; it is simply
not available to this project yet.

**Exposing passwords in full, as the community servers do.** _Rejected._ It is
the single most consequential property of the Hudu API (`spec-defects.md` A1)
and the reason a careful buyer would refuse to install any of the existing
servers. Article III ranks security above feature completeness, and this is
precisely the case that ordering exists for. The reduction is real: an agent
cannot audit password hygiene in bulk through this server. That trade is
accepted and documented rather than hidden.

**Remote HTTP transport in 0.1.0.** _Rejected for this release._ It is a
materially larger security surface — bearer auth, DNS-rebinding protection,
origin allowlisting, bind address, rate limiting on the listener itself — and
each of those is a control that has to be built and tested, not just enabled.
Shipping it half-built alongside a server that holds a Hudu API key would
contradict the entire premise of the project. The cost of deferring is
concrete and stated plainly: **ChatGPT and Grok cannot use this server at all**
until it lands. See ADR-001.

---

## Proposed Design

Recorded as built. D1–D8 mirror RFC-001's structure so the two repositories can
be read against each other.

### D1 — Language, runtime, tooling

| Decision              | As built                                                                                                                                  | Rationale                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language              | TypeScript 5.9, `strict: true`                                                                                                            | The only language standard Engineering OS defines                                                                                                                                                                         |
| Runtime               | Node.js ≥ 20 (`engines`), CI on 20 and 22                                                                                                 | 18 is end-of-life                                                                                                                                                                                                         |
| Modules               | ESM, `module: NodeNext`, `verbatimModuleSyntax`                                                                                           | Correct for `"type": "module"`; the last catches import elision surprises                                                                                                                                                 |
| Target                | ES2023, `lib: ES2023`                                                                                                                     | No DOM lib, so browser globals cannot be reached for by accident                                                                                                                                                          |
| Additional strictness | `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters` | The first two catch real defects in code that walks untyped API responses, which is most of this codebase                                                                                                                 |
| Package manager       | npm, lockfile committed                                                                                                                   | Lowest friction for outside contributors                                                                                                                                                                                  |
| Lint / format         | ESLint 9 flat config + Prettier, both enforced in CI                                                                                      | Familiarity, per Article III's ranking of contributor friendliness                                                                                                                                                        |
| Tests                 | Vitest 3, HTTP mocked at the `fetch` boundary                                                                                             | Native ESM and TS                                                                                                                                                                                                         |
| Validation            | Zod at every tool boundary                                                                                                                | The SDK's idiom; schemas double as model-facing documentation                                                                                                                                                             |
| HTTP client           | Native `fetch`                                                                                                                            | No dependency                                                                                                                                                                                                             |
| Runtime dependencies  | `@modelcontextprotocol/sdk`, `zod` — **two, total**                                                                                       | `standards/typescript-standard.md` requires reviewing material dependencies. A server holding an API key should have a supply chain a reader can audit in an afternoon. `CLAUDE.md` makes adding a third require an issue |

### D2 — Repository layout and layer separation

Implements `standards/repository-standard.md`, and the transport / domain / API
/ presentation separation `standards/typescript-standard.md` requires. A layer
may import from those below it and never from those above.

```
src/
  index.ts         CLI: argv, exit codes, usage. Importable without starting a listener.
  server.ts        buildServer(): tool definitions + config -> McpServer.
  transport/       stdio wiring. Swappable; the core holds no session assumptions.
  tools/           Declarations only. define.ts is the factory; resource.ts
                   generates the repeated CRUD shapes; per-resource modules
                   state only what is genuinely different.
  presentation/    Markdown, field projection, page info, character budget. No I/O.
  security/        Operation classification and secret stripping. Pure.
  api/             client, paths, envelope, errors, rate-limit, redact. Knows
                   nothing about MCP.
  config.ts        Environment parsing. Nothing read from disk.
docs/
  rfc/ adr/ reference/    reference/ holds the captured contract as a committed artifact
tests/             unit/ integration/ security/ installation/ contract/
```

`src/domain/` is reserved and empty at 0.1.0; `CLAUDE.md` requires an issue
before anything is put in it. The boundaries are stated as invariants in
`CLAUDE.md` and as a table in `CONTRIBUTING.md`, so a reviewer has something
specific to check rather than an aesthetic to appeal to.

The load-bearing decision here is that **`src/tools/` declares and never
implements policy**. `defineTool` and `buildResourceTools` are the only ways to
create a tool, and `executeTool` is the only path a result takes. Ninety-odd
operations written by hand would have been ninety chances to forget encoding, or
a page-size clamp, or secret stripping. Centralising it means a new tool
inherits the security posture instead of having to remember it — which is also
exactly why the one place stripping _was_ bypassed became a leak (see Security
Impact).

### D3 — Transport

stdio only in 0.1.0, over a transport-independent core. `buildServer()` is
exported and takes no transport, so the whole tool surface is testable
in-process; `src/transport/stdio.ts` is the only file that knows a transport
exists. Adding Streamable HTTP is a new file in that directory plus its
controls, not a refactor. Recorded as ADR-001. Consequence, stated without
hedging: ChatGPT and Grok connectors cannot execute a stdio server, so they
cannot use this release.

### D4 — Distribution

npm as `@zenixsolutions/hudu-mcp`, invoked with `npx`, `bin: hudu-mcp`. This
reaches Claude Code, Claude Desktop, and Codex. The package publishes `dist`
without source maps plus README, LICENSE and CHANGELOG. `prepublishOnly` does a
clean build; the release workflow validates, builds, checks that version's
changelog section, and publishes with provenance on a `v*` tag.

The CLI carries four flags that exist for operators rather than for the
protocol: `--version`, `--help`, `--check` to validate configuration without
starting, and `--list-tools` to print exactly what would register under the
current environment **and what is withheld and why**. The last is the honest
answer to "what can this thing actually do to my Hudu?" and it is answerable
without granting it a key's worth of trust first.

### D5 — AI-first tool design

Per `standards/ai-interface-standard.md` and Article X, treating the contract's
rough edges as this server's problem rather than the model's.

1. **No invented pagination.** No `total`, no `has_more`, ever (C1).
   `page_was_full` plus a `pagination_note`, and the five unpaginated
   collections report that they are unpaginated (C2) rather than offering
   parameters the endpoint ignores.
2. **Page size clamped at 100 and rejected above it**, since no maximum is
   published (D12). Rejection at the schema, not silent adjustment: a caller who
   asks for 500 should learn that, not receive 25 and infer the data ended.
3. **Descriptions state the thing that will trip the caller up.** Every tool
   names the sibling tool to use when it is the wrong choice, and mentions the
   real quirk — that Hudu answers 404 identically for a missing record and an
   unrouted path, that assets are read globally but written per-company, that a
   PUT replaces the fields you send.
4. **Operation class, impact and gating are appended to every description by the
   factory**, not left to each author. An undocumented gate reads to a model as
   a broken tool.
5. **Response shaping.** `response_format` of `json` (default, compact) or
   `markdown`; top-level field projection via `fields`; a character budget
   applied to large lists. Raw pretty-printed dumps are a token problem and a
   comprehension problem at the same time.
6. **`updated_at` range filters** are documented as the ISO-8601 `"start,end"`
   string the API actually takes, with the useful application named — "anything
   not touched since 2025" is a stale-credential report.
7. **Asymmetric field shapes are modelled explicitly**, not smoothed over
   (D10).
8. **Irregular endpoints stay irregular.** Delete-by-title, the activity-log
   purge, and the split asset read/write paths are hand-written rather than
   forced through the CRUD factory, because their failure modes differ and the
   tool name should say so.

### D6 — Security posture

Recorded in full as ADR-002. In outline:

- **Five operation classes** — Read, Create, Update, Admin, Destructive — per
  `standards/security-standard.md`, with `src/security/classification.ts`
  defining what each _obliges_ (the standard names the classes but does not
  define their obligations) and deriving the MCP annotations from the class
  rather than hand-setting them per tool.
- **Four environment gates**, and gates are environment-only: `HUDU_READ_ONLY`,
  `HUDU_ALLOW_DESTRUCTIVE`, `HUDU_ALLOW_PASSWORD_REVEAL`, `HUDU_ALLOW_EXPORTS`.
  No tool argument may enable, override or soften one, and no credential is ever
  accepted as a tool argument.
- **A gated tool is not registered at all**, rather than registered and
  refusing. A tool a model cannot see is a tool it cannot be talked into
  calling. `HUDU_READ_ONLY=1` and `HUDU_ALLOW_DESTRUCTIVE=1` together is a
  configuration error and is rejected at startup, because it almost certainly
  means the operator believes something untrue about their deployment.
- **Central secret stripping.** `stripSecrets` runs in `executeTool` on every
  result, recursively, on unknown shapes — an endpoint-by-endpoint allowlist
  would leak the first time Hudu nested a password object somewhere new. A
  placeholder is left behind so a model can tell a value exists; a genuinely
  null password stays null rather than being disguised as a redaction.
- **Passwords withheld by default, revealed one record at a time.**
  `hudu_reveal_password` requires the environment flag _and_ `confirm: true`
  _and_ a single specific id. There is no bulk reveal and, per the module
  comment, deliberately never will be.
- **Percent-encoding of every interpolated segment**, with dot segments
  _rejected_ rather than encoded — see the second defect under Security Impact
  for why encoding is not sufficient there.
- **Redaction at the error boundary**, both by key name and by registered
  literal value, so a key interpolated into a URL or echoed by an upstream error
  body is caught too.
- **Nothing on stdout but protocol frames.** `no-console` is an ESLint error in
  `src/` and `tests/`.

### D7 — Workflow, versioning, release

Trunk-based on `main`, short-lived branches, Conventional Commits, squash merge.
CI on every push and pull request across Node 20 and 22: typecheck, lint, format
check, test, build, install smoke test, and a pattern-based committed-credential
scan. Semantic versioning, `vX.Y.Z` tags, Keep a Changelog format with a
`check:changelog` gate on the release workflow. Initial release 0.1.0 — pre-1.0
signals that the tool surface may still move.

`CONTRIBUTING.md` carries a table of what CI enforces and what is only
convention. Branch protection on `main` was applied after the initial commit:
the three CI checks, one approving review, dismissal of stale reviews, resolved
conversations, linear history, and no force-pushes or deletion — with
`enforce_admins` deliberately off. The exemption and its reasoning are recorded
in Open Question 1 rather than presented as full enforcement. Claiming a control
that does not exist is worse than having no control, and Article XIV's demand
for objective evidence cuts both ways.

### D8 — Licensing and identity

MIT, full canonical text. Repository `ZenixSolutions/hudu-mcp`; npm
`@zenixsolutions/hudu-mcp`; `CODE_OF_CONDUCT.md` (Contributor Covenant) as
`standards/repository-standard.md` requires for public repositories. Positioned
as a community server, non-affiliated with and not endorsed by Hudu, with no use
of their marks beyond nominative reference. Given that Hudu ships a first-party
server, the non-affiliation statement is not boilerplate — a reader could
otherwise reasonably assume this is the official one, and that assumption would
be a security-relevant mistake about who to trust with an API key.

The full-MIT-versus-Engineering-OS's-abridged-MIT discrepancy noted in RFC-001
applies here identically and remains a gap report item.

---

## Security Impact

The design intent is stated in D6 and ADR-002. What follows is what the intent
was actually worth, which is a different question.

### The two-gate model, and what a `confirm` argument is worth

Destructive work passes two independent gates: an operator-set environment flag
and a model-supplied `confirm: true`. They are not redundant, and they are not
equal. **An agent-supplied `confirm` is a prompt-level speed bump, not
human-in-the-loop control.** The model decides whether to set it; a confused or
prompt-injected agent will set it as readily as a careful one. Article IX asks
for explicit confirmation and described impact, and `confirm` plus the impact
text in the description satisfies the letter of that — but the environment flag
is the gate a compromised agent cannot open, because it is not in the agent's
world at all. This is stated in `SECURITY.md` in those terms, in
`classification.ts`, and here, because a reader who mistakes the speed bump for
the control will deploy this wrongly.

Above both gates sits a control this codebase does not own: **a Hudu API key's
scope is fixed at creation.** A key created without password access, destructive
actions or export capability cannot be widened by any configuration, tool
argument, prompt injection, or bug in this code. `SECURITY.md` leads with that
and describes everything else as defence-in-depth, which is the honest ordering.

### Central stripping

`GET /asset_passwords` returns `password` and `otp_secret` as required
properties of every record (A1). `stripSecrets` therefore runs in `executeTool`
on every tool result — not in the passwords module, not per tool. Two properties
follow. First, a tool added next year inherits the protection without its author
knowing the protection exists. Second, and this is the part that matters, the
protection has exactly one bypass: the `requiresPasswordReveal` flag on a tool
definition. A single flag on a declaration is auditable; a second code path
would not be.

### Three defects found by independent review

All three were found during implementation by a reviewer that was not the
author. All three are fixed, and all three are pinned by regression tests. They
are reported here in full because Article VI exists precisely for this, and
because a governance record that only lists the controls that worked is
marketing.

**1. Credential leak through `response_format: "markdown"`.** Tool handlers
render their Markdown view from the _raw_ record, before stripping runs. The
rendered string was returned as-is, so `stripSecrets` — which walks keys —
never saw it: a rendered string has no keys to walk. The result was that
`response_format: "markdown"` returned every stored password and every OTP seed
in the response, **with no gate set at all**. This is the exact defect the whole
architecture was built to prevent, reintroduced by a presentation feature that
looked orthogonal to security. Fixed by scrubbing the rendered string _by value_
— `collectSecretValues` gathers the literals from the raw payload and
`redactSecretsInText` removes them with `split`/`join` rather than a regular
expression, since a stored password is arbitrary text and an escaping mistake in
that position is itself a leak. Pinned by tests covering single-record, list, and
embedded-password Markdown rendering.

**2. `buildPath` allowed a `..` segment to escape the API prefix.**
`encodeURIComponent` leaves `.` and `..` untouched, and the WHATWG URL parser
inside `fetch` collapses them before the request is sent — so
`/api/v1/companies/..` is requested as `/api/v1/`. Encoding cannot fix this,
because the same parser decodes `%2e` back to `.` and collapses it anyway. The
percent-encoding invariant, which the repository states as invariant 1, was
therefore not sufficient for the case it was written to cover. Fixed by
_rejecting_ dot segments outright, in plain and percent-encoded form, since
refusal is the only control that works here. Pinned by a unit test asserting no
resolved pathname can contain `..`.

**3. The generic error path did not scrub the API key.** `HuduApiError` redacts
itself at construction, but an arbitrary error thrown anywhere below the tool
boundary had no such treatment, and its message was interpolated verbatim into
the agent-facing error text. Fixed by scrubbing the whole result in
`toAgentError` rather than the branch that looked risky — a boundary rather than
a list of remembered cases, which is what Article VIII asks for. Pinned by tests
asserting a registered secret is scrubbed from an arbitrary error and from both
the message and the detail of an API error.

The pattern across all three is worth naming: **each was a place where a general
control had a specific hole, and in each case the author could not see the hole
because the author was the person who believed the control was general.** That
is the entire argument for Article VI, and this is the concrete evidence for it
in this repository. It is also the argument for applying branch protection,
which has not been done — see Open Questions.

### Residual risk

- The server does not authenticate the model. Anything that can call it can call
  every tool the operator enabled.
- It cannot detect an over-scoped or compromised key, and cannot reliably
  distinguish a permission failure from a missing record (A7).
- It cannot prevent a model repeating a revealed secret. When
  `HUDU_ALLOW_PASSWORD_REVEAL` is set, where that value goes is the model's
  transcript, not this server's. The tool description instructs the model to
  hand it to the user and nowhere else; that is an instruction, not a control.
- The committed-credential scan is a pattern list and will not catch a novel
  shape. `CONTRIBUTING.md` says so rather than implying completeness.
- Contract drift across Hudu versions (A2) could mean a tool addresses an
  endpoint that has changed meaning.

## Testing Impact

Layers per `standards/testing-standard.md`, in `tests/{unit,integration,
security,installation,contract}/`: 16 files, 731 tests passing, 6 skipped. Unit
covers path building and encoding, config parsing, redaction, secret stripping,
rate limiting, and formatting. Integration exercises the client, envelope
unwrapping, and the tool surface against mocked HTTP. Security is its own
directory — tool surface, capability gates, error leakage, secret exposure —
because Article VIII requires controls to be verified rather than assumed, and a
control without a test is an assertion. Installation asserts the published
package contents and that the CLI runs. Contract tests hit a live instance,
require `HUDU_CONTRACT_TESTS=1`, and are never enabled in CI.

No coverage threshold is set. Engineering OS sets none, and RFC-001's proposal
of one was left open. A number is proposed again under Open Questions.

## Documentation Impact

Shipped: `CLAUDE.md` (agent-facing invariants and layer rules), `CONTRIBUTING.md`
(lifecycle plus the enforced-versus-convention table), `SECURITY.md` (reporting,
supported versions, and an explicit "what this server does not do" section),
`CODE_OF_CONDUCT.md`, `CHANGELOG.md` including a Known limitations section, the
GitHub issue and PR templates, and `docs/reference/spec-defects.md` — 60-odd
numbered findings, committed so the contract this code targets is auditable and
so drift becomes visible.

User-facing documentation was written in the same session and is still moving as
this RFC is finalised: `README.md`, `docs/quickstart.md` and
`docs/installation.md` exist. The README carries the relationship to Hudu's
first-party server, the non-affiliation statement, and the least-privilege key
recommendation.

Not shipped, and required before release: **`docs/limitations.md` does not
exist**, and three shipped files link to it — `src/config.ts` in its
`MAX_PAGE_SIZE` comment, `docs/reference/spec-defects.md` in its opening
paragraph, and the README twice, including from its documentation index.
Article VII makes a feature incomplete when required documentation is missing,
so 0.1.0 is not releasable until it is written. It must carry, at minimum: the
absent total count and what `page_was_full` does and does not tell you (C1), the
five unpaginated collections (C2), the rack contents that cannot be listed (C4),
the withheld `fields` on layout update (B6), the absent file upload (E1), the
un-retrievable exports (C6), and the client compatibility gap — no ChatGPT, no
Grok. Every one of those is already evidenced in `spec-defects.md`; the work is
translating it for an operator rather than discovering it.

## Compatibility Impact

Greenfield; no backward-compatibility obligations. Forward-looking, the tool
surface is the public contract, so `standards/ai-interface-standard.md`'s
stability requirement applies from 0.1.0 onward. Pre-1.0 permits breaking tool
changes with a minor bump and a changelog notice; after 1.0, Article III gives
backward compatibility substantially greater weight. Two compatibility surfaces
beyond the tools: the environment variable names, which are effectively public
API for anyone who has written a client config, and the shape of the list
envelope. Runtime floor is Node 20; CI proves 20 and 22.

## Migration Plan

None. Greenfield, no prior version, no users, no data. There is no prototype to
retire and nothing to repoint.

## Risks

| Risk                                                                     | Severity | Mitigation                                                                                                                                                                              |
| ------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Another secret-exposure path exists that review did not find             | High     | Central stripping plus by-value scrubbing plus a dedicated security suite. The Markdown leak proves this class is real and not hypothetical, so it is listed as High rather than Medium |
| Contract drift across Hudu versions (A2: 78 paths versus our 56)         | High     | Committed contract artifact; opt-in contract tests; documented as targeting the captured version                                                                                        |
| Contract tests have not been run against a live tenant                   | Medium   | Open question below; must be resolved before 0.1.0 is published                                                                                                                         |
| `npm run validate` does not pass — 21 lint errors, 13 unformatted files  | Medium   | Mechanical, not behavioural; `npm run lint:fix` and `npm run format` plus a re-read of whatever `lint:fix` cannot resolve. Blocks the initial commit, since CI runs the same command    |
| Independent review is unenforced — branch protection is not applied      | Medium   | Stated plainly in `CONTRIBUTING.md`; resolvable only by the repository owner                                                                                                            |
| `docs/limitations.md` missing while three shipped files link to it       | Medium   | Blocks release under Article VII; contents already evidenced in `spec-defects.md`                                                                                                       |
| Undocumented rate-limit behaviour causes failures at scale               | Medium   | Client-side limiting at 120/min against a published 300/min, concurrency 4                                                                                                              |
| Deferring HTTP transport means ChatGPT and Grok never land               | Medium   | Documented as an absence, not implied support. ADR-001 keeps the core transport-independent so it stays a small change                                                                  |
| Withholding bulk password reveal blocks a real audit use case            | Medium   | Accepted deliberately; single-record reveal exists. Revisit only with evidence, and never as a bulk endpoint                                                                            |
| The first-party server expands and removes the reason to exist           | Low      | The safety and testing differentiator survives a surface expansion; the surface argument does not                                                                                       |
| Engineering OS remains unratified, leaving this repo's basis provisional | Low      | Recorded as a Milestone 6 gap report item, as with RFC-001                                                                                                                              |

## Constitutional Compliance

**Article III (priority order) — met.** Security over feature completeness is
the recurring trade: withheld passwords, no bulk reveal, no file upload, `fields`
dropped from layout update, no raw error passthrough. Each cost a capability and
each was taken deliberately.

**Article IV (documented interfaces) — met.** Only the captured contract's
surface is exposed. Where the contract is silent the server records it as
undocumented (`spec-defects.md` D-series) rather than guessing, and where it
contradicts itself the server declines to pick a side that could destroy data
(B6). C4 is the cleanest case: a question the API cannot answer gets no tool
rather than an invented join.

**Article VI (independent review) — met for the implementation, not enforced
structurally.** A reviewer that was not the author reviewed the code and found
three security defects. But branch protection has not been applied, so a
maintainer with write access can merge their own unreviewed change tomorrow.
Review happened; it is not _guaranteed_ to happen. That distinction is stated in
`CONTRIBUTING.md` and repeated in Open Questions, and it is the weakest
compliance claim in this document.

**Article VIII (secrets and verification) — met, after correction.** No secret
material in the repository; `.env.example` carries placeholders only; redaction
is structural at the error boundary; nothing but protocol frames reaches stdout.
Controls are verified by a dedicated security test suite rather than asserted.
The honest qualifier is that this Article was _violated_ by the Markdown
rendering path and by the unscrubbed generic error path until review caught
both. Compliance here is the state after the fix, not a claim that the first
attempt was clean.

**Article IX (high-impact actions) — met, with a stated limit.** Every operation
is classified; Destructive and Admin operations require `confirm: true` and
carry impact text; Destructive additionally requires an operator-set environment
flag and is not registered without it. The limit, stated rather than hidden: the
model supplies the confirmation, so the confirmation is not human-in-the-loop.

**Article X (AI-first interfaces) — met.** D5. Descriptions, schemas, operation
class, impact and gating are treated as the interface contract and generated
uniformly by the factory. The pagination decision is the clearest instance: the
interface refuses to emit a field a model would find convenient and would be
wrong to trust.

**Article XII (traceability) — partially met, and this document is the
remedy.** There is no tracked issue, no architecture review, and no
pre-implementation approval record. The chain from request to implementation
exists in the session and in this RFC, not in the artifacts the lifecycle
expects. That is a real gap in traceability, not a formality, and it is the
honest cost of building in one session.

**Article XIV (evidence-based quality) — met where claimed.** Counts in this
document are from the build (`--list-tools`) and the test run, not estimates.
Where something is asserted but not demonstrated — contract tests against a live
tenant, rate-limit behaviour, cascade behaviour — it is listed as an assumption
with the validation method named, rather than as a completion claim.

---

## Open Questions

Owner input needed. The rest of this document is a record; these are live.

1. **The admin exemption on branch protection.** _Partially resolved._ `main`
   now requires the three CI checks, one approving review, resolved
   conversations and linear history, and forbids force-pushes and deletion. But
   `enforce_admins` is off, because GitHub does not permit self-approval and a
   hard rule on a single-maintainer repository yields either a stuck queue, a
   second account rubber-stamping the same person's work, or the rule being
   disabled under pressure — none of which is review.

   So the control is real for contributors and advisory for administrators. The
   substance of Article VI was met in this build by adversarial review agents
   with no stake in the code being correct, which is what found all four
   security defects; the checkbox was not the thing doing the work. **Owner
   decision needed:** accept the exemption as standing policy, or close it once
   a second reviewer with write access exists — which is the point at which the
   exemption stops costing nothing.

2. **npm publication.** Publish as `@zenixsolutions/hudu-mcp` (clear provenance,
   weaker discoverability) or not publish to npm at all for 0.1.0 and distribute
   from the repository while the surface settles? Note that publishing is also
   what makes the "none of the community servers are on a registry"
   differentiator real rather than theoretical.
3. **Contract tests against the live Zenix tenant.** Assumption A1 is currently
   asserted, not demonstrated. Run them in CI with a stored Hudu key — a
   standing credential in GitHub, against a production tenant — or as a
   documented manual pre-release step? Recommendation: manual pre-release,
   against a scratch company, before every release. A production key in CI is a
   larger risk than the assurance is worth.
4. **Remote HTTP transport in 0.2.** This is the only thing that reaches ChatGPT
   and Grok. It is also the largest single addition to the security surface this
   project could make. Is reaching those two clients worth it, and if so is 0.2
   the right slot?
5. **Send the spec-defect report to Hudu.** `docs/reference/spec-defects.md`
   documents contradictions and gaps in their published contract, several of
   them security-relevant — the audit-trail purge with no id, the documented
   authentication bypass on `GET /cards/jump`, the absent `403`. Article IV says
   documentation gaps must be reported, not guessed around, and we have done the
   second half of that but not the first. Send it, and if so, privately through
   their security channel or as ordinary documentation feedback?
6. **Test coverage threshold.** Still unset, as in RFC-001. Proposal: 80% lines
   on `src/api`, `src/tools` and `src/security`, with no global gate. Accept,
   change the number, or decline to set one?

---

## Approval Requested

**No approval is requested. This document records decisions already approved and
already implemented.**

The Project Owner pre-approved the four foundational decisions listed in the
Summary — carried over from RFC-001's approved stack — and directed that
implementation proceed in the same session. Under
`governance/decision-hierarchy.md`, the Project Owner is level 1 and the
lifecycle is not; the owner's instruction is therefore sufficient authority for
the sequence that was followed.

It is nonetheless a deviation from `governance/engineering-lifecycle.md`, and
naming it precisely is the point of writing it down:

| Lifecycle stage                   | What happened                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------- |
| 1. Intake                         | Conversational. No tracked issue.                                               |
| 4. RFC                            | Written after implementation — this document.                                   |
| 5. Architecture Review            | Not performed.                                                                  |
| 6. Chief Architect Recommendation | Not produced.                                                                   |
| **7. Project Owner Approval**     | **Given in advance, verbally and in scope, rather than against a written RFC.** |
| 9. Implementation                 | Performed.                                                                      |
| 10. Independent Review            | Performed. Three security defects found and fixed.                              |
| 11. Validation                    | Performed. 731 tests, full `validate` pipeline, CI on Node 20 and 22.           |
| 12. Merge Approval                | Outstanding.                                                                    |
| 13. Recordkeeping                 | This document, ADR-001, ADR-002.                                                |

What was skipped is stages 5 and 6 — the adversarial reads. What was not skipped
is stage 10, and stage 10 is what found the credential leak. That is worth
recording, because it suggests the review stages carry unequal weight, and a
future session under time pressure should know which one it cannot afford to
drop.

Two things do still need the owner:

- **Merge approval** for the initial commit (stage 12).
- **Decisions on the six Open Questions**, of which items 1 and 3 should be
  settled before 0.1.0 is published rather than after.

ADR-001 (transport and distribution) and ADR-002 (security posture and
capability reductions) are recorded from D3–D4 and D6. A `decisions/DECISION_LOG.md`
entry is owed and has not been written.
