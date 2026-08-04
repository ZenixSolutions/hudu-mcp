# ADR-002: Security posture — operation classes, environment gates, and deliberate capability reductions

- **Status:** Accepted; sections 1, 2 and 4 partially superseded by ADR-003
- **Date:** 2026-08-04
- **Related RFC:** RFC-002 (D6, Security Impact)
- **Approved by:** Josh (Project Owner)

> **Two decisions recorded here turned out to be wrong, and were corrected in
> 0.2.0 after an external review of the published 0.1.0 package.** This document
> is left as written, because a record of reasoning that produced a defect is
> worth more than a record edited to look correct. Read
> [ADR-003](ADR-003-security-posture-corrections.md) alongside it. In short:
> section 2's four gates are now five (`HUDU_ALLOW_PASSWORD_WRITE` was missing,
> and the write direction to the credential vault was ungated); section 4's
> "placeholder is left behind" is now a `null` plus a `<field>_redacted: true`
> flag; and section 1's derived annotations claimed `destructiveHint: false` for
> every `Update` and `Admin` tool, which the protocol's own definition of the
> hint does not permit. Everything else here still holds.

## Context

This server exposes the Hudu REST API to a language model, holding an API key
whose scope was fixed when it was created. Three properties of that API, all
recorded in `docs/reference/spec-defects.md`, set the security problem.

**`GET /asset_passwords` returns every credential in the tenant** (A1). The
`Asset_Password` model lists `password` ("The actual password string") and
`otp_secret` ("Secret key for one-time passwords") among its **required**
properties, and the list endpoint returns an array of that model. One unfiltered
call returns every stored password and every TOTP seed the key can see. Every
community Hudu MCP server surveyed exposes this unmediated, which is the single
strongest argument for building another one.

**`DELETE /activity_logs` destroys the audit trail with no record id** (A2). It
takes a required `datetime` and deletes everything from that point forward. No
id, no dry run, no documented count returned, no undo. It is precisely the call
an attacker makes to cover their tracks. `DELETE /companies/{id}` cascades to
every record inside the company (A3), and `DELETE /magic_dash` deletes by
matching `title` + `company_name` rather than by id (A4).

**The API cannot tell you when you lack permission** (A7). No `403` is
documented anywhere, despite keys being scoped at creation for password access,
destructive actions, exports, IP allowlist and company. A scope failure arrives
as `401` or `404`, indistinguishable from a missing record.

Above all of this sits a control this codebase does not own and cannot weaken:
**a Hudu API key's scope is fixed at creation and can never be widened.** A key
created without password access, destructive actions or export capability cannot
be extended by any configuration here, any tool argument, any prompt injected
into the model, or any bug in this code. Everything in this ADR is
defence-in-depth on top of that boundary, and `SECURITY.md` says so in those
words rather than implying the software is the boundary.

`standards/security-standard.md` requires every public operation to be
classified as Read, Create, Update, Admin or Destructive. It names the classes.
It does not define what each one obliges. That definition is this repository's
to supply.

## Decision

### 1. Five operation classes, with defined obligations

`src/security/classification.ts` is the single place a reviewer looks to see
what any tool is allowed to do. Each of the 89 tools carries exactly one class,
and the class determines the gates and the MCP annotations — annotations are
_derived_, never hand-set per tool.

| Class       | Meaning                                                        | Obliges                                                            |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| Read        | Retrieves data. No side effects.                               | Nothing. Registered always.                                        |
| Create      | Brings a new record into existence. Reversible by deleting it. | Write access (not read-only mode).                                 |
| Update      | Modifies an existing record. Overwrites prior values.          | Write access.                                                      |
| Admin       | Alters instance-wide configuration or extracts data in bulk.   | Write access **and** `confirm: true`.                              |
| Destructive | Removes data. Not reversible through this API.                 | Write access, `HUDU_ALLOW_DESTRUCTIVE=1`, **and** `confirm: true`. |

As built: 41 Read, 17 Update, 16 Destructive, 13 Create, 2 Admin.

### 2. Four environment gates, and gates are environment-only

`HUDU_READ_ONLY`, `HUDU_ALLOW_DESTRUCTIVE`, `HUDU_ALLOW_PASSWORD_REVEAL` and
`HUDU_ALLOW_EXPORTS`. All default to off. All are read in `src/config.ts` and
nowhere else.

- **No tool argument may enable, override or soften a gate**, and no credential
  is ever accepted as a tool argument. A key supplied through a tool call would
  be a key the model has seen.
- **A gated tool is not registered at all**, rather than registered and
  refusing. A tool a model cannot see is a tool it cannot be talked into
  calling. `executeTool` re-checks every gate anyway, so a tool reached by any
  other route still fails closed.
- Under the default configuration 70 of 89 tools register and 19 are withheld
  (16 Destructive, 2 export-gated Admin, 1 password reveal). Under
  `HUDU_READ_ONLY=1`, 40 register.
- `HUDU_READ_ONLY=1` together with `HUDU_ALLOW_DESTRUCTIVE=1` is rejected at
  startup. Read-only would win, but the combination means the operator believes
  something untrue about their deployment, and starting anyway would let that
  belief persist.
- `--list-tools` prints exactly what registers under the current environment and
  what is withheld and why, so "what can this do to my Hudu?" is answerable
  before granting it a key's worth of trust.

### 3. Two gates on destructive work, which are not equal

An operator-set environment flag and a model-supplied `confirm: true`. **The
`confirm` argument is a prompt-level speed bump, not human-in-the-loop
control** — the model decides whether to set it, and a confused or
prompt-injected agent will set it as readily as a careful one. Article IX asks
for explicit confirmation and described impact, and `confirm` plus the impact
text in the description satisfies that. The environment flag is the gate a
compromised agent cannot open, because it does not exist in the agent's world.
This is stated in the code, in `SECURITY.md`, and in RFC-002, because an
operator who mistakes the speed bump for the control will deploy this wrongly.

### 4. Secrets are stripped centrally, on the way out of every tool

`stripSecrets` runs in `executeTool` on every tool result, recursively, over
unknown shapes. Not in the passwords module; not per tool.

- Recursion over unknown shapes rather than a per-endpoint allowlist, because
  Hudu embeds password objects inside other records in places the schema does
  not document — an allowlist leaks the first time the vendor nests one
  somewhere new.
- A placeholder is left behind so a model can tell that a value exists. A
  genuinely null password stays null: "there is no password on this record" is a
  useful fact and must not be disguised as a redaction.
- **Rendered strings are scrubbed by value as well as by key.** A handler builds
  its Markdown view from the raw record before stripping runs, and a rendered
  string has no keys to walk. `collectSecretValues` gathers the literals and
  `redactSecretsInText` removes them using `split`/`join` rather than a regular
  expression, since a stored password is arbitrary text and an escaping mistake
  in that position is itself a leak. **This exists because the absence of it was
  a live credential leak**, found by independent review during implementation:
  `response_format: "markdown"` returned every stored password and OTP seed with
  no gate set. Fixed, and pinned by regression tests.
- The only bypass is the `requiresPasswordReveal` flag on a tool definition — a
  declaration, not a second code path, so it is auditable by reading one field.
- `findSecretFields` exists as a verification hook for the security test suite
  and as a last-resort runtime guard, because Article VIII requires controls to
  be verified rather than assumed.

Separately, `src/api/redact.ts` scrubs at the error and logging boundary, by
sensitive key name, by sensitive header name, and by registered literal value —
the last catches a key interpolated into a URL or echoed back in an upstream
error body. `toAgentError` scrubs the _whole_ error result rather than the
branch that looked risky; that too was a review finding, since an arbitrary
error thrown below the tool boundary previously reached the model verbatim.

### 5. Passwords withheld by default, revealed one record at a time

Password _metadata_ — name, username, URL, company, timestamps — is available
without any gate, so an assistant can answer "does a credential exist for X" and
"what has not been rotated since 2025" without ever touching secret material.
The secret values require `HUDU_ALLOW_PASSWORD_REVEAL=1` **and** `confirm: true`
**and** a single specific record id, through `hudu_reveal_password`. Its
description instructs the model to hand the value to the user and nowhere else —
not into a summary, a file, a message, or a later tool call.

### 6. Deliberate capability reductions

Four capabilities the Hudu API offers are not exposed, each for a stated reason:

| Reduction                                                                                    | Reason                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No bulk password reveal**, and per the module comment there deliberately never will be one | The failure mode is total: one call returning every credential in the tenant is the defect that motivated this project                                                                                                                       |
| **No file upload** (`POST /uploads`, `POST /public_photos`, `PUT /public_photos/{id}`)       | They are `multipart/form-data` and the contract documents **no request body at all** (E1). Building against a body we would have to infer violates Article IV. The read side of both is implemented                                          |
| **No `fields` argument on `hudu_update_asset_layout`**                                       | `POST /asset_layouts` takes `fields` as an array of objects; `PUT /asset_layouts/{id}` documents it as an array of bare strings (B6). Both cannot be right, and guessing wrong rewrites the field definitions of every asset on the layout   |
| **No `GET /cards/jump` tool**                                                                | It is documented as working without API key authentication, "only requiring authentication at the time of jump" (A5). It is a browser redirect helper, not a data endpoint, and wrapping a documented authentication bypass is not a feature |

### 7. Supporting invariants

Percent-encoding of every interpolated path segment, with dot segments
**rejected** rather than encoded — `encodeURIComponent` leaves `..` alone and
the URL parser inside `fetch` collapses it before the request is sent, so
`/api/v1/companies/..` would be requested as `/api/v1/`, and encoding cannot fix
it because the same parser decodes `%2e` back to `.` and collapses it anyway.
Refusal is the only control that works. This too was a review finding.

Nothing but protocol frames on stdout (`no-console` is an ESLint error).
Client-side rate limiting at a default of 120 requests/minute against a
published ceiling of 300, with concurrency 4, because `429` is documented
nowhere and no rate-limit header exists (A8). No secret material anywhere in the
repository, including fixtures, documentation and commit messages;
`.env.example` carries placeholders only.

## Consequences

Each reduction cost something real. Naming the cost is the point of this
section.

**No bulk credential audit.** An assistant cannot answer "which of our stored
passwords are weak, reused, or identical across clients" through this server —
that requires reading every password, which is exactly the call being prevented.
Metadata-based hygiene questions still work: what exists, what has not been
updated, what is missing a URL. Anyone needing a true password audit should do
it in Hudu, not through an LLM.

**No document or photo ingestion.** An assistant cannot attach a screenshot,
upload a diagram, or replace a company logo. Read access to existing uploads and
photos works. This lands when the multipart body is documented or verified
against a live instance, not before.

**Asset layout fields cannot be edited through this server at all.** Everything
else about a layout can be updated; the field list cannot. A user who needs to
change layout fields does it in the Hudu UI. This is the reduction most likely
to be reported as a bug, and the answer is that a coin flip on a destructive
schema change is not an acceptable alternative.

**A workflow that expects `hudu_reveal_password` to exist breaks by default**,
because the tool is not registered unless the operator enabled it. The error is
explicit about what to set and about the fact that metadata remains available —
but a model that plans a multi-step task around retrieving a credential will
have to replan.

**Read-only mode is a genuinely useful deployment, not a token gesture.** Forty
tools register under `HUDU_READ_ONLY=1`, covering every list and get across the
full API surface. An audit-only or reporting-only consumer does not have to fork
or trust write tools they will never call.

**Every added tool inherits the posture, and cannot opt out.** `defineTool` and
`buildResourceTools` are the only construction paths, `executeTool` is the only
execution path, and `CLAUDE.md` invariant 7 makes calling `server.registerTool`
from a tool module a defect. The cost is that irregular endpoints must be
expressed through the factory's vocabulary rather than written freely.

**Central stripping means a presentation feature can become a security defect.**
This is not hypothetical — the Markdown leak happened exactly that way. Anything
that renders, formats, caches, logs or serialises a tool result is now
security-relevant code and must be reviewed as such. That is a permanent cost of
the design and it should be understood before someone adds a templating layer.

**Conservative rate limiting makes bulk work slower.** 120/minute against a
published 300 and a concurrency of 4 means a full-tenant inventory takes longer
than it needs to. The alternative is discovering an undocumented limit by
tripping it, on a server that cannot tell a rate-limit rejection from any other
failure.

**None of this constrains a compromised API key.** If the key was created with
password access and destructive rights, and an attacker obtains it, this server
is irrelevant to them — they can call Hudu directly. The gates protect against a
confused, over-eager or prompt-injected _agent_, which is a real and common
failure mode, not against an attacker holding the credential.

## Alternatives Rejected

**Expose passwords in full, as every surveyed community server does.**
Rejected. Article III ranks security above feature completeness and this is the
case that ordering exists for. It is also the project's differentiator: without
it there is no reason to prefer this over Hudu's first-party server.

**Return passwords but warn in the description.** Rejected. A description is an
instruction to a model, not a control. The value would already be in the
transcript by the time the instruction was ignored.

**Redact per tool, in the passwords module.** Rejected. It relies on every
future tool author knowing that Hudu embeds credentials in places the schema
does not document. Central stripping means the author does not need to know.

**Gate capabilities with a tool argument rather than the environment.**
Rejected. A gate the model can pass is a gate the model can be persuaded to
pass. Environment-only means the operator holds the decision and the model has
no vocabulary for it.

**Register gated tools and have them refuse at call time.** Rejected as the
default. An unregistered tool is invisible, so it cannot be attempted, argued
with, or worked around. The refusal path still exists in `executeTool` as
defence in depth, but it is the second line rather than the first.

**Ship file upload against an inferred multipart body.** Rejected under Article
IV. The contract documents no request body; building against a guess would put
undocumented behaviour into a published interface.

**Pick one interpretation of `fields` on asset layout update.** Rejected. A
wrong guess rewrites the field definitions of every asset on the layout. Where
the contract contradicts itself, the rule is not to pick the side that could
destroy data.

**Set no environment gates and rely solely on API key scoping.** Rejected,
although key scoping is genuinely the stronger control. In practice operators
reuse an existing broadly-scoped key, and a server that assumes best-practice
key hygiene will be deployed by people who did not follow it. Defence in depth
is for the realistic case.

## Security and Compatibility Impact

**Security.** This ADR _is_ the security posture. Its controls are verified by a
dedicated `tests/security/` suite — tool surface, capability gates, error
leakage, secret exposure — rather than asserted, per Article VIII. Three defects
found by independent review during implementation (the Markdown credential leak,
the `..` path escape, and the unscrubbed generic error path) are all fixed and
all pinned by regression tests; they are described in full in RFC-002 under
Security Impact. Residual risks, stated in `SECURITY.md`: the server does not
authenticate the model, cannot detect an over-scoped key, cannot distinguish a
permission failure from a missing record (A7), and cannot prevent a model
repeating a revealed secret.

**Compatibility.** The four environment variable names are effectively public
API — they appear in every client configuration — and renaming one is a breaking
change. Adding a _new_ gate is backward compatible only if it defaults to off,
which is also the correct default on security grounds. The withheld placeholder
strings are part of the observable output contract; a consumer parsing them
would break if they changed. Relaxing a reduction later (adding file upload,
adding layout `fields`) is additive and non-breaking. Tightening one — moving an
operation to a stricter class, or adding a gate to something currently ungated —
is breaking, and pre-1.0 that is permitted with a minor bump and a changelog
entry.

## Supersedes

None.

## Superseded By

[ADR-003: Security posture corrections](ADR-003-security-posture-corrections.md),
in part. ADR-003 replaces the gate list in section 2 (four gates become five),
the redaction shape in section 4 (a placeholder string becomes `null` plus a
sibling flag), and the annotation mapping implied by section 1 (`Update` and
`Admin` now carry `destructiveHint: true`). The rest of this ADR — central
stripping, environment-only gating, unregistered rather than refusing, the
single-record reveal, the deliberate capability reductions, and every consequence
and rejected alternative recorded below — stands.
