# Security Policy

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

**<https://github.com/ZenixSolutions/hudu-mcp/security/advisories/new>**

That form is private to you and the maintainers. Use it for anything that could
be used to reach data an operator did not intend to expose.

Do not open a public issue, pull request or discussion for a suspected
vulnerability, and do not include any of the following anywhere public:

- API keys, tokens or passwords, yours or anyone else's
- URLs or hostnames of real Hudu instances
- Response bodies from a real instance
- Working exploit steps or proof-of-concept payloads

If you have already posted something like that publicly, say so in the advisory
so we can prioritise accordingly.

A useful report includes the version of `@zenixsolutions/hudu-mcp`, the Node
version, the tool or code path involved, what an attacker gains, and the
smallest reproduction you can construct against a scratch instance. If you are
unsure whether something counts, report it — a false alarm costs less than a
missed one.

### Response times

This is a small project maintained alongside other work. The commitments below
are deliberately conservative; we would rather meet them than advertise better
ones.

| Stage                                                       | Target           |
| ----------------------------------------------------------- | ---------------- |
| Acknowledgement that the report was received                | 5 business days  |
| Initial assessment: confirmed, not reproduced, or not a bug | 15 business days |
| Fix or documented mitigation for a confirmed issue          | 90 days          |

If a report is confirmed, we will keep you updated on progress and credit you in
the advisory and the changelog unless you ask us not to. If we cannot reproduce
it, we will say so rather than leave the thread silent.

We do not operate a paid bug bounty.

## Supported versions

| Version | Supported                   |
| ------- | --------------------------- |
| 0.1.x   | Yes                         |
| < 0.1.0 | No — no such release exists |

Only the latest published version receives security fixes. Pre-1.0, fixes are
released as a new patch version rather than backported to an older line.

Vulnerabilities in the Hudu platform or in the Hudu API itself are not in scope
here — report those to Hudu. In scope is anything in this server: the tool
surface, the API client, secret handling, path construction, logging, the
published package contents, and the documentation where it tells an operator to
do something unsafe.

## Security model

Be clear about what this software is. It is a client that holds a Hudu API key
and exposes the Hudu REST API to a language model as MCP tools. It grants
whatever that key grants. It cannot grant less than the operator configures, and
it cannot grant more than the key allows.

### The API key is the real boundary

A Hudu API key's scope is fixed when the key is created and cannot be changed
afterwards. That property is the strongest control available to you, because it
sits outside this software entirely: **create the key without password access,
without destructive actions and without export capability**, and nothing in this
server — no configuration, no tool argument, no prompt injected into the model,
no bug in this code — can widen it. Where the key also supports an IP allowlist
or a single-company scope, set those too.

Everything below is a defence-in-depth layer on top of that boundary. None of it
substitutes for it.

### What this server does

- **Secrets are stripped centrally.** `GET /asset_passwords` returns `password`
  and `otp_secret` as required properties of every record in the list, so one
  unbounded call returns every stored credential and TOTP seed the key can see.
  `src/security/secrets.ts` removes those fields recursively from every tool
  response on the way out, in `executeTool`, so a tool cannot forget to do it.
  A placeholder is left behind so a model can tell that a value exists.
- **Capability gates are environment-only.** Password reveal, destructive
  operations, exports and read-only mode are controlled by `HUDU_ALLOW_*` and
  `HUDU_READ_ONLY` environment variables. They are never tool arguments. A model
  cannot request a capability the operator did not enable, and a gated tool is
  not registered at all rather than registered-and-refusing — a tool the model
  cannot see is a tool it cannot be talked into calling.
- **Credentials are never accepted as tool arguments.** `HUDU_API_KEY` comes
  from the environment. A key supplied through a tool call would be a key the
  model has seen.
- **Every interpolated path segment is percent-encoded** in `src/api/paths.ts`,
  and malformed segments are rejected before a request is issued. Path segments
  come from model-supplied arguments and are treated as untrusted input.
- **Errors are redacted.** `src/api/redact.ts` keeps request headers, including
  the `x-api-key` header, out of error messages and diagnostics.
- **Nothing is written to stdout except protocol frames.** On stdio, stdout is
  the transport; a stray log line both corrupts the session and risks echoing
  data. Diagnostics go to stderr, and `no-console` is an ESLint error.
- **Destructive operations require `confirm: true`** in addition to
  `HUDU_ALLOW_DESTRUCTIVE`.

### What this server does not do

- It does not authenticate or authorise the model. Anything that can call the
  server can call every tool the operator has enabled.
- `confirm: true` supplied by a model is a prompt-level speed bump, not
  human-in-the-loop control. The environment flag is the real gate.
- It cannot detect a compromised or over-scoped API key. The API documents no
  `403`, so a scope failure arrives as a `401` or a `404` and is difficult to
  distinguish from a missing record.
- It does not prevent a model from repeating a revealed secret. When
  `HUDU_ALLOW_PASSWORD_REVEAL` is set, `hudu_reveal_password` returns real
  credential material to the model; where that material then goes is the
  model's transcript, not this server's.
- It does not encrypt or persist anything. There is no cache and no state on
  disk.

### Recommended deployment

- Create a dedicated, least-privilege API key for this server.
- Start with `HUDU_READ_ONLY=1` and leave every `HUDU_ALLOW_*` flag unset.
- Enable a gate only for a specific, understood use, and only when the key was
  created with the matching scope.
- Keep the key out of shell history and process listings; supply it through the
  MCP client's environment configuration rather than an inline command.
- Review `docs/reference/spec-defects.md` section A. It lists the
  security-relevant properties of the Hudu API itself, including the
  activity-log purge that deletes the audit trail with no record id.
