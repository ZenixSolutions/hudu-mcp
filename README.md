# hudu-mcp

[![CI](https://github.com/ZenixSolutions/hudu-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ZenixSolutions/hudu-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`hudu-mcp` is a community [Model Context Protocol](https://modelcontextprotocol.io)
server for the [Hudu](https://hudu.com) IT documentation REST API. It exposes the
documented v1 API — companies, assets, knowledge base articles, credential
records, IPAM, racks, website monitors, relations, integrations, the audit trail
and the export triggers — as 89 MCP tools, and it withholds stored passwords and
TOTP secrets from every response unless an operator has explicitly turned that
off. It is aimed at MSPs and internal IT teams who want an assistant that can
read and maintain their Hudu tenant over a local stdio connection, using an API
key they scope themselves.

## Before you install this, look at Hudu's own MCP server

Hudu ships a first-party MCP server built into the product. It is served from
your own instance at `https://<your-instance>/mcp`, it authenticates with Hudu
OAuth rather than a long-lived API key, and it is enabled from
**Admin → External Apps → Model Context Protocol**. Per Hudu's documentation it
covers articles (create, read, update), activity logs (read) and assets (read
only), and it deliberately excludes passwords, asset writes and deletions.

For a large number of people that is the better choice, and you should not
install this project reflexively.

|                                                     | Hudu's MCP server                              | `hudu-mcp` (this project)                               |
| --------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Maintained by                                       | Hudu Technologies, Inc.                        | Zenix Solutions, community project                      |
| Where it runs                                       | Inside your Hudu instance, at `/mcp`           | A local process next to your MCP client                 |
| Transport                                           | Remote HTTP, reachable from hosted clients     | stdio only (see [compatibility](docs/compatibility.md)) |
| Authentication                                      | Hudu OAuth, per user                           | A Hudu API key you create and scope                     |
| Enabled by                                          | Admin → External Apps → Model Context Protocol | Installing and configuring this package                 |
| Articles                                            | Create, read, update                           | Create, read, update, archive, delete                   |
| Assets                                              | Read only                                      | Full CRUD, plus archive and layouts                     |
| Activity log                                        | Read                                           | Read, and purge behind two gates                        |
| Passwords                                           | Excluded entirely                              | Metadata by default; secrets behind a gate              |
| Deletions                                           | Excluded entirely                              | Behind `HUDU_ALLOW_DESTRUCTIVE` and `confirm: true`     |
| IPAM, racks, websites, relations, matchers, exports | Not covered                                    | Covered                                                 |
| Support                                             | Hudu support                                   | GitHub issues, best effort                              |

Use Hudu's server if what you need is article and asset reading with some
article authoring, if you want per-user OAuth rather than a shared API key, if
you need a hosted client to reach it over HTTP, or if you want something you can
raise a support ticket about. Its narrower surface is a design decision, not an
omission: a server that cannot delete anything and cannot read a password has a
much smaller worst case than this one.

Use `hudu-mcp` if you need the parts of the API Hudu's server does not cover —
IPAM, racks, website monitors, relations, integration matchers, expirations,
users, the audit trail — or if you need asset and password writes, or if you want
capability gates you control from the environment rather than a fixed surface.

The two can coexist. Nothing here depends on Hudu's server being off.

## Quick start

Requires Node.js 20 or newer and a Hudu API key.

```bash
npx @zenixsolutions/hudu-mcp --version
```

Configure your MCP client to launch it over stdio. The block below is the
standard shape and works in Claude Desktop, Claude Code and any other client
that starts a local stdio server:

```json
{
  "mcpServers": {
    "hudu": {
      "command": "npx",
      "args": ["-y", "@zenixsolutions/hudu-mcp"],
      "env": {
        "HUDU_BASE_URL": "https://hudu.example.com",
        "HUDU_API_KEY": "your-api-key",
        "HUDU_READ_ONLY": "1"
      }
    }
  }
}
```

That configuration registers 40 read tools and nothing that can change or delete
anything. Drop `HUDU_READ_ONLY` when you want writes; see
[Security model](#security-model) before you do.

Verify a configuration without starting a session:

```bash
HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=... npx @zenixsolutions/hudu-mcp --check
HUDU_BASE_URL=https://hudu.example.com HUDU_API_KEY=... npx @zenixsolutions/hudu-mcp --list-tools
```

`--list-tools` prints the tools that would be registered under the current
environment, plus the ones being withheld and why. It is the fastest way to
confirm a gate is set the way you think it is.

Longer walkthrough: [docs/quickstart.md](docs/quickstart.md). Other install
methods: [docs/installation.md](docs/installation.md).

## Getting an API key

Create the key in Hudu at **Admin → Basic Information → API Keys**.

Hudu's own API documentation lists five scoping options on a key:

1. Access to passwords, covering all REST actions on them
2. Ability to perform destructive actions, meaning `DELETE`
3. Ability to perform exports
4. Whitelisted IP addresses
5. Company scopes

**These options can only be configured when the key is created.** They cannot be
changed afterwards; a different scope means a new key. Create the key with the
least this server needs and no more:

- Leave password access off unless you intend to set
  `HUDU_ALLOW_PASSWORD_REVEAL=1`.
- Leave destructive actions off unless you intend to set
  `HUDU_ALLOW_DESTRUCTIVE=1`.
- Leave export capability off unless you intend to set `HUDU_ALLOW_EXPORTS=1`.
- Set the IP allowlist if the machine running this server has a stable address.
- Set a company scope if the key only ever needs one customer.

A key created without password access is a harder boundary than any setting in
this software. `HUDU_ALLOW_PASSWORD_REVEAL` is a decision made by the operator in
an environment variable, and it is enforced by code in this repository — code
that can have bugs, and that runs in the same process as a model reading
attacker-influenced text. A key that Hudu will not let read `/asset_passwords` at
all is enforced by Hudu, on the other side of the network, where nothing in this
process can reach it. Prefer that boundary whenever you can live with it.

Hudu's API documentation notes that a key can be created and deleted at any
time. Deleting the key is the fastest way to revoke this server's access.

## Configuration

Everything is read from the environment. Nothing is read from disk, and no
credential is accepted as a tool argument.

| Variable                     | Default    | What it does                                                                                                                                               |
| ---------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUDU_BASE_URL`              | _required_ | Your Hudu instance origin, e.g. `https://hudu.example.com`. A trailing slash or a trailing `/api/v1` is normalised away; the client adds `/api/v1` itself. |
| `HUDU_API_KEY`               | _required_ | The key from Admin → Basic Information → API Keys. Sent as the `x-api-key` header.                                                                         |
| `HUDU_READ_ONLY`             | off        | Register only `Read` tools. Nothing can create, update, archive, delete, export or purge. 40 tools instead of 70.                                          |
| `HUDU_ALLOW_DESTRUCTIVE`     | off        | Register the 16 delete and purge tools, including the activity-log purge.                                                                                  |
| `HUDU_ALLOW_PASSWORD_REVEAL` | off        | Register `hudu_reveal_password`, which returns one stored secret per call. Password metadata is available without it.                                      |
| `HUDU_ALLOW_EXPORTS`         | off        | Register the two bulk export tools.                                                                                                                        |
| `HUDU_RATE_LIMIT_PER_MINUTE` | `120`      | Client-side request ceiling. Must be a positive integer no greater than 300, which is the limit Hudu documents.                                            |
| `HUDU_MAX_CONCURRENCY`       | `4`        | Simultaneous in-flight requests. Maximum 32.                                                                                                               |
| `HUDU_REQUEST_TIMEOUT_MS`    | `30000`    | Per-request timeout in milliseconds. Maximum 600000.                                                                                                       |
| `HUDU_MAX_RETRIES`           | `3`        | Retries for transient failures (timeouts, network errors, `429`, `5xx`), with full-jitter backoff. 0 to 10.                                                |

The four gates are booleans. `1`, `true`, `yes` and `on` (any case, surrounding
whitespace ignored) enable them; anything else, including an unset variable,
leaves them off.

Setting `HUDU_READ_ONLY` and `HUDU_ALLOW_DESTRUCTIVE` together is rejected at
startup with exit code 78 rather than silently resolved. Read-only would win, but
the combination almost always means someone believes a delete is available when
it is not.

Invalid configuration reports every problem at once and exits 78, so a
misconfigured install is fixed in one pass rather than one variable per restart.

## Security model

Read [SECURITY.md](SECURITY.md) for the reporting process and the full model, and
[docs/security.md](docs/security.md) for the threat model and residual risks.
The short version:

**Nothing permissive is on by default.** Out of the box the server registers 70
tools: reads, creates and updates. Deletions, password reveal and exports are all
absent until an operator sets the matching variable. A gated tool is not
registered at all rather than registered-and-refusing, because a tool a model
cannot see is a tool it cannot be talked into calling.

**Four gates, all environment-only.** `HUDU_READ_ONLY`,
`HUDU_ALLOW_DESTRUCTIVE`, `HUDU_ALLOW_PASSWORD_REVEAL` and `HUDU_ALLOW_EXPORTS`
are read in `src/config.ts` and nowhere else. There is no tool argument that
enables, overrides or softens any of them.

**Passwords are withheld because of how the Hudu API is shaped.** The
`Asset_Password` model lists `password` ("The actual password string") and
`otp_secret` ("Secret key for one-time passwords") among its **required**
properties, and `GET /asset_passwords` returns an array of that model
(`docs/reference/spec-defects.md` A1). A single unfiltered list call therefore
returns every credential and every TOTP seed the key can see. This server strips
those two fields recursively from every tool result, centrally, in
`executeTool` — leaving a placeholder so a model can tell a value exists — and
renders Markdown from the stripped payload rather than the raw record, and
scrubs the rendered text by value behind that. The only exception is
`hudu_reveal_password`, which needs `HUDU_ALLOW_PASSWORD_REVEAL=1`, an explicit
`confirm: true`, and one specific record id. There is no bulk reveal.

**Destructive work needs two independent keys.** The operator's
`HUDU_ALLOW_DESTRUCTIVE` decides whether the 16 destructive tools exist at all;
the model's `confirm: true` argument then has to be supplied per call, with the
impact stated in the tool description. These are not redundant, and they are not
equal: `confirm` is supplied by the model, so it is a prompt-level speed bump. The
environment flag is the gate a confused or manipulated agent cannot open. The
same pair guards the two `Admin`-class export tools.

**The API key's scope sits outside all of this** and is the outermost boundary.
See [Getting an API key](#getting-an-api-key).

## Tool surface

89 tools with every gate open, 70 with the defaults, 40 in read-only mode.

| Resource group                            |  Tools | Registered by default | In read-only mode |
| ----------------------------------------- | -----: | --------------------: | ----------------: |
| Companies                                 |      8 |                     7 |                 4 |
| Assets                                    |      7 |                     6 |                 3 |
| Asset layouts                             |      4 |                     4 |                 2 |
| Articles                                  |      6 |                     5 |                 2 |
| Folders                                   |      5 |                     4 |                 2 |
| Procedures                                |      3 |                     3 |                 2 |
| Passwords and password folders            |      9 |                     7 |                 4 |
| Networks and IP addresses                 |     10 |                     8 |                 4 |
| Racks and rack items                      |     10 |                     8 |                 4 |
| Websites                                  |      5 |                     4 |                 2 |
| Relations                                 |      3 |                     2 |                 1 |
| Magic Dash                                |      4 |                     2 |                 1 |
| Matchers                                  |      3 |                     2 |                 1 |
| Instance, users, audit trail, expirations |      6 |                     5 |                 5 |
| Files and photos                          |      4 |                     3 |                 3 |
| Exports                                   |      2 |                     0 |                 0 |
| **Total**                                 | **89** |                **70** |            **40** |

By operation class: 41 `Read`, 13 `Create`, 17 `Update`, 16 `Destructive`, 2
`Admin`. `hudu_reveal_password` is classed `Read` because it does not modify
Hudu, so it remains available in read-only mode when
`HUDU_ALLOW_PASSWORD_REVEAL` is also set — read-only mode restricts writes, not
disclosure.

Every tool, with its arguments and gates: [docs/tool-reference.md](docs/tool-reference.md).
Task-oriented recipes: [docs/user-guide.md](docs/user-guide.md).

## Limitations

The Hudu v1 API cannot answer some questions that people reasonably expect it to,
and this server reports those gaps rather than papering over them. The ones most
likely to affect you:

- **No collection endpoint returns a total count** — no envelope, no `total`, no
  `X-Total-Count`, no `Link` header (C1). This server therefore emits neither
  `total` nor `has_more`. Read `page_was_full` and `pagination_note`, and never
  treat a full page as a complete list.
- **Five collections have no pagination at all** — networks, IP addresses, racks,
  rack items and uploads (C2). They return everything matching your filters in
  one response, and if that response is trimmed to fit the output budget there is
  no next page to ask for.
- **A rack's contents cannot be listed** (C4). No field or filter ties a rack item
  to its rack.
- **Exports can be started but never retrieved** (C6). There is no status
  endpoint and no download URL in this API version.
- **File upload is not implemented** (E1). The endpoints are `multipart/form-data`
  and the contract documents no request body for them.
- **A 403 is documented nowhere** (A7), so a key-scope failure is hard to
  distinguish from a missing record.

The full list, with the evidence behind each item:
[docs/limitations.md](docs/limitations.md).

## Documentation

| Document                                                         | Contents                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| [docs/quickstart.md](docs/quickstart.md)                         | Five minutes from nothing to a working tool call           |
| [docs/installation.md](docs/installation.md)                     | npx, global install, from source, per-client configuration |
| [docs/user-guide.md](docs/user-guide.md)                         | MSP workflows, with the tool sequence for each             |
| [docs/tool-reference.md](docs/tool-reference.md)                 | All 89 tools: class, arguments, gates                      |
| [docs/limitations.md](docs/limitations.md)                       | What this API cannot do, and why                           |
| [docs/compatibility.md](docs/compatibility.md)                   | Node versions, MCP protocol revisions, clients             |
| [docs/security.md](docs/security.md)                             | Threat model, controls, residual risks                     |
| [docs/reference/spec-defects.md](docs/reference/spec-defects.md) | Findings against the captured Hudu API contract            |
| [CHANGELOG.md](CHANGELOG.md)                                     | Release history                                            |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). It states plainly which steps CI enforces
and which are convention. Pre-1.0, the tool surface is not stable: a minor
version may add, rename or remove tools.

## Security reporting

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/ZenixSolutions/hudu-mcp/security/advisories/new),
not as a public issue. See [SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).

## Disclaimer

This project is not affiliated with, endorsed by, or supported by Hudu
Technologies, Inc. "Hudu" is used nominatively, to identify the product this
software interoperates with. Hudu is a trademark of its respective owner. For
support of the Hudu platform itself, including its own MCP server, contact Hudu.
