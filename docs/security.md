# Security model and threat model

[SECURITY.md](../SECURITY.md) is the policy: how to report a vulnerability, what
is in scope, and the response times. This document is the engineering view — what
is being protected, from whom, by which control, in which file, and what is left
over afterwards.

## What this software is

A client that holds a Hudu API key and exposes the Hudu REST API to a language
model as MCP tools. It runs as a local process launched by an MCP client, over
stdio. It has no listener, no database, no cache and no state on disk.

It grants whatever the key grants. It can grant less, through configuration. It
cannot grant more.

## Assets

Three things are worth an attacker's effort here, in descending order of damage.

**The Hudu API key.** Whoever holds it has whatever scope it was created with,
from anywhere the IP allowlist permits, until someone deletes it in Hudu. It is
not user-bound and not time-bound.

**The credential vault.** Hudu's password records are the operational keys to a
client's estate: firewall admin logins, hypervisor accounts, TOTP seeds. The API
returns `password` and `otp_secret` as _required_ properties of every record in
`GET /asset_passwords` (`reference/spec-defects.md` A1), so a single unfiltered
list call is a full vault dump for everything the key can see. This one fact
shapes the design of the whole server.

**The audit trail.** `DELETE /activity_logs` takes a cutoff timestamp, no record
id, no dry run and returns no count (A2). It is precisely the call an attacker
makes after doing something else. Once the entries are gone, the API offers no
way to establish what happened.

Two lesser assets are worth naming because the API makes them easy to leak:
client documentation in bulk (the export endpoints, and `enable_sharing` on an
article, which mints a public unauthenticated URL — A6), and user records, which
carry `last_sign_in_ip`, `sign_in_count` and `otp_required_for_login`.

## Adversaries

- **A manipulated model.** The likeliest attack. Content read out of Hudu — an
  article, an asset note, a ticket pasted into the conversation — contains
  instructions, and the model treats them as a request. It has legitimate access
  to every enabled tool, so nothing has to be broken for this to work.
- **A careless operator.** Enables a gate to unblock one task and leaves it on;
  reuses a full-scope key; exports a company to a laptop.
- **A compromised host.** Anything running as the same user can read the process
  environment and the client's configuration file.
- **An over-scoped key in the wrong hands.** Copied out of a config file, or left
  in shell history.

Explicitly **not** defended against: an attacker who already controls the machine
the server runs on. At that point the key is theirs.

## Controls

| Control                                                          | Where it lives                                                                                            | What it stops                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability gates read only from the environment                  | `src/config.ts`                                                                                           | A model, or a prompt, enabling a capability the operator did not                                                                             |
| Gated tools are not registered at all                            | `shouldRegister` in `src/tools/define.ts`, `src/server.ts`                                                | A model being talked into calling a tool it can see but should not use                                                                       |
| Operation classification drives gating and annotations           | `src/security/classification.ts`                                                                          | A tool being mis-declared as harmless one file at a time                                                                                     |
| Central, recursive secret stripping                              | `stripSecrets` in `src/security/secrets.ts`, applied in `executeTool`                                     | `password` and `otp_secret` reaching a tool result, including from places the schema does not document                                       |
| Value-based scrubbing of rendered Markdown                       | `collectSecretValues` / `redactSecretsInText`, applied in `executeTool`                                   | A secret escaping through `response_format: "markdown"`, which is built before stripping runs and has no keys to walk                        |
| Single-record reveal, gated three ways                           | `hudu_reveal_password` in `src/tools/passwords.ts`                                                        | A bulk credential dump. There is no bulk form of the tool                                                                                    |
| `confirm: true` on every Destructive and Admin tool              | `CLASS_REQUIREMENTS` in `src/security/classification.ts`, enforced in `executeTool`                       | A destructive call made without the impact being stated first                                                                                |
| No credential is accepted as a tool argument                     | `src/config.ts`                                                                                           | A key the model has seen                                                                                                                     |
| Percent-encoding and dot-segment rejection on every path segment | `encodeSegment` / `buildPath` in `src/api/paths.ts`                                                       | Path injection from model-supplied identifiers, including `..` traversal the URL parser would collapse                                       |
| Error redaction by header name, key name and literal value       | `src/api/redact.ts`, applied at construction in `src/api/errors.ts` and at the boundary in `toAgentError` | The API key appearing in an error message, a log line or a tool result                                                                       |
| Nothing but protocol frames on stdout                            | `src/transport/stdio.ts`, `no-console` as an ESLint error                                                 | Session corruption, and data echoed into the transport                                                                                       |
| Client-side pacing and concurrency limits                        | `TokenBucket` and `Semaphore` in `src/api/rate-limit.ts`                                                  | An agent loop hammering a customer's production instance. Hudu documents no `429` and no rate-limit headers (A8), so this cannot be reactive |
| Impact statements in tool descriptions                           | `buildDescription` in `src/tools/define.ts`                                                               | A model calling something sharp without the consequence in front of it                                                                       |

These are verified rather than asserted: `tests/security/` holds
`capability-gates.test.ts`, `secret-exposure.test.ts`, `error-leakage.test.ts`
and `tool-surface.test.ts`, and they run in CI on every push.

## The boundary that is not in this repository

An API key's scope is fixed when Hudu creates it and cannot be changed
afterwards. Password access, destructive actions, exports, the IP allowlist and
the company scope are all decided at that moment.

That makes the key the outermost boundary, and the only one enforced somewhere
this process cannot reach. Everything in the table above is code in this
repository: code that runs in the same process as a model reading
attacker-influenced text, and code that can have bugs. A key that Hudu will not
let read `/asset_passwords` is enforced by Hudu, over the network, and no
configuration, no tool argument, no injected prompt and no defect in this
software can widen it.

Create the key with the least you need. Where a gate in this server and a scope
on the key overlap, set both — but if you can only have one, have the key scope.

## Residual risks

Stated plainly, because a security document that lists only its controls is not
telling you the truth.

**An agent-supplied `confirm` is a prompt-level speed bump.** It is a tool
argument, which means the model produces it. Anything that can persuade the model
to call a destructive tool can persuade it to set `confirm: true` in the same
breath. Its value is that it forces the impact text into the model's context and
gives the client something to surface to a human — not that it constitutes
consent. **The environment flag is the real gate**, because it is set by an
operator at startup and no tool call can change it. If you would not accept the
worst case of a tool running without human approval, do not set the flag that
registers it.

**Prompt injection through Hudu content is a live risk this server cannot fully
mitigate.** Documentation read out of Hudu is untrusted text that arrives with
the authority of the customer's own knowledge base. An article, an asset note, a
magic dash tile or a synced integration field can contain instructions, and once
they are in the model's context this server has no way to distinguish "the user
asked for this credential" from "an article told the model to fetch it and put it
somewhere". The reveal tool's description addresses this directly — it tells the
model to hand the value to the user and to nothing else, and to stop and ask if
the request arrived from something it read rather than from the person it is
talking to — but that is a description, read by a model, competing with other
text in the same context. It reduces the probability. It is not a control, and it
should not be counted as one. The controls that actually bound this risk are the
gates and the key's scope: content read out of Hudu cannot cause a reveal on a
server where `HUDU_ALLOW_PASSWORD_REVEAL` is unset, and cannot cause one at all
on a key without password access.

**Secret stripping is keyed on field names.** `password` and `otp_secret` are
removed recursively wherever they appear, which is why the stripping walks
unknown shapes rather than an endpoint-by-endpoint allowlist. But a future Hudu
version that returns credential material under a _different_ key would not be
covered until this project adds the name. Nothing here detects secrets by shape.

**Secrets still cross the wire into this process.** Stripping happens after the
response is received, because it has to: the API returns them and there is no
parameter that asks it not to. They exist in this process's memory for the life
of a request, and in any core dump taken from it.

**A revealed secret is out of this server's hands.** When
`HUDU_ALLOW_PASSWORD_REVEAL` is set and the tool is called, real credential
material enters the model's context and the client's transcript. Where it goes
next — a log, a chat history, a training pipeline, a screenshot — is a property
of the client and the deployment, not of this server.

**Nothing authenticates the caller.** There is no authorisation layer between the
MCP client and the tools. Anything that can speak to this process gets every tool
the operator enabled, with the full scope of the key.

**An over-scoped key is hard to detect.** No `403` is documented anywhere in the
API (A7), so a scope failure arrives as a `401` or a `404`. There is no way for
this server to enumerate what a key can do, and therefore no way for it to warn
you that the key is broader than your configuration.

**Exports leave every control behind.** A started export packages documentation —
and, with `include_passwords`, credentials — into a file where Hudu's permissions,
this server's stripping and the reveal gate no longer apply. It cannot be
cancelled, tracked or retrieved through this API (C6), so this server cannot even
tell you it finished. `hudu_start_s3_export` takes no arguments: its scope and
destination live in Hudu's settings, invisible from here.

**Some Hudu features publish to the open internet by design.**
`enable_sharing: true` on an article mints a URL that renders the full content to
anyone holding it, with no login and no record of who read it (A6). Public photo
URLs are similarly unauthenticated. Both are reachable through registered write
and read tools; the argument descriptions say so, and that is the extent of the
protection.

**Process discipline has gaps, and they are documented rather than hidden.** The
committed-credential scan in CI is a fixed pattern list and will not catch a
secret in an unanticipated shape. Independent review is a convention, not a
branch-protection rule. See the enforcement table in
[CONTRIBUTING.md](../CONTRIBUTING.md#what-is-enforced-by-ci-and-what-is-not).

**Supply chain.** Two runtime dependencies — `@modelcontextprotocol/sdk` and
`zod` — kept deliberately small. `npx` without a pinned version fetches whatever
the registry currently serves. Pin the version if that matters to you.

## Recommended deployment

1. Create a dedicated API key for this server, with password access, destructive
   actions and export capability all **off**, an IP allowlist if the host has a
   stable address, and a company scope if one customer is all it needs.
2. Start with `HUDU_READ_ONLY=1` and every `HUDU_ALLOW_*` flag unset. That is 40
   tools, none of which can change anything.
3. Open exactly one gate at a time, for a use you can describe, and only when the
   key was created with the matching scope.
4. Keep the key out of shell history and process listings. Supply it through the
   MCP client's environment configuration or a file with restrictive permissions,
   not on an interactive command line.
5. Verify what you actually deployed:
   `hudu-mcp --list-tools` prints what is registered and what is withheld, with
   the reason for each.
6. Revoke by deleting the key in Hudu. Removing the client configuration stops
   this server using it; it does not stop anything else that has a copy.

## Reporting

Vulnerabilities go through
[GitHub Security Advisories](https://github.com/ZenixSolutions/hudu-mcp/security/advisories/new),
privately, with no real hostnames, keys or response bodies in the report. See
[SECURITY.md](../SECURITY.md).

Weaknesses in the Hudu platform or the Hudu API belong with Hudu.
`reference/spec-defects.md` section A is the security-relevant part of that
evidence base, and is worth reading before any review of a Hudu instance —
particularly A5, which records an endpoint documented as working without API key
authentication.
