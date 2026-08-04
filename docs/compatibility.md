# Compatibility

## Node.js

`package.json` declares `"engines": { "node": ">=20.0.0" }`. CI runs typecheck,
lint, format check, tests and build on **Node 20 and Node 22** on every push and
pull request; those two are the versions this project is known to work on.

| Version             | Status                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| Node 18 and earlier | Not supported. Below the declared engine range.                         |
| Node 20             | Supported, tested in CI.                                                |
| Node 21             | Not tested. Between two tested versions; no known reason it would fail. |
| Node 22             | Supported, tested in CI.                                                |
| Node 23 and later   | Not tested.                                                             |

Two runtime details worth knowing if you are pinning a minor version:

- The client uses the global `fetch`, which is stable from Node 18 onwards.
- It uses `AbortSignal.any`, which arrived in Node 20.3. That path is only
  reached when a caller passes its own `AbortSignal` into the API client, which
  no tool does — the CLI never hits it — but a programmatic user on Node 20.0 to
  20.2 would.

There are no native dependencies and nothing is compiled at install time, so the
server runs anywhere Node does: Linux, macOS and Windows alike. On Windows,
prefer an absolute path to the executable in your client configuration; clients
frequently do not inherit the `PATH` that a shell would.

The runtime dependency set is `@modelcontextprotocol/sdk` and `zod`, and keeping
it that small is deliberate. The package is ESM only (`"type": "module"`), so
programmatic use requires `import`, not `require`.

## MCP protocol

This server is built on `@modelcontextprotocol/sdk` (`^1.20.0`; 1.30.0 at the
time of writing). It does not pin or negotiate a protocol revision itself — that
is the SDK's job, and it happens per connection during initialisation.

The SDK version in this repository implements **2025-11-25** as its latest
revision and accepts **2025-06-18**, **2025-03-26**, **2024-11-05** and
**2024-10-07** from a client. A client speaking any of those will connect. Check
`node_modules/@modelcontextprotocol/sdk/package.json` for the version you
actually installed if you need to be certain.

**Capabilities: tools only.** This server registers tools and nothing else. There
are no MCP resources, no prompts, no sampling and no completions. A client that
expects resources will find none, which is not an error.

It also supplies server instructions during initialisation — a short briefing
that most work starts from `hudu_list_companies`, that no list endpoint returns a
total, and that stored passwords are withheld by default. Clients that surface
server instructions will show it; clients that ignore them lose nothing that the
tool descriptions do not also say.

## Transports and clients

**stdio only.** The server is launched as a local process and speaks JSON-RPC
over its standard input and output. There is no HTTP transport, no SSE endpoint
and no listening socket in 0.1.0. `src/transport/` is the only place that would
change if a Streamable HTTP transport were added later; nothing else in the
codebase knows what transport it is running on.

Consequences:

- The server runs on the same machine as the client, and the Hudu API key lives
  in that machine's environment rather than in a hosted service.
- Nothing is exposed on the network. The only outbound traffic is to your Hudu
  instance.
- Any MCP client that can launch a local process and speak stdio can run it. The
  configuration shape is the same everywhere: a command, its arguments, and an
  environment block. [installation.md](installation.md) gives worked examples for
  Claude Desktop and Claude Code; other stdio clients take the same three inputs
  in whatever file they use.
- Stdout carries protocol frames and nothing else. Diagnostics — including the
  startup line reporting how many tools were registered and how many withheld —
  go to stderr, where your client's MCP logs will collect them.

### ChatGPT, Grok, and other hosted connectors

**They cannot run this server.** ChatGPT connectors and Grok's equivalent
integrations connect outward, from the vendor's infrastructure to a remote MCP
server reachable over HTTP. They have no mechanism for executing a process on
your machine, which is what a stdio server requires. This is a property of those
products, not a missing feature in a particular version of them.

Using this server with a hosted connector would mean deploying it behind a
remote HTTP MCP endpoint — a transport 0.1.0 does not provide. A generic
stdio-to-HTTP bridge would technically work, and it is a decision worth making
deliberately rather than by convenience: it puts your Hudu API key on a
network-reachable host, and it means any request that reaches that endpoint acts
with the key's full scope. If you want an MCP server a hosted assistant can
reach, Hudu's own first-party server is served from your instance over HTTP with
Hudu OAuth, and is the better-supported answer to that particular question. See
[the comparison in the README](../README.md#before-you-install-this-look-at-hudus-own-mcp-server).

## Hudu versions

There is no minimum Hudu version declared here, because the project has evidence
about one instance rather than about the product: the API contract in
`docs/reference/` was captured from a live instance on 2026-08-04, and it is the
only source of truth this server was built against.

An endpoint missing from your Hudu build answers `404`, which is the same `404`
Hudu returns for a record that does not exist. `hudu_get_api_info` reports the
version and build date, takes no arguments and needs no permission beyond a valid
key; call it first whenever a tool behaves in a way this documentation does not
predict. See [limitations.md](limitations.md#endpoints-that-exist-elsewhere-but-not-here).
