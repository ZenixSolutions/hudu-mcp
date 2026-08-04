# ADR-001: stdio transport, npx distribution, and a transport-independent core

- **Status:** Accepted
- **Date:** 2026-08-04
- **Related RFC:** RFC-002 (D3, D4)
- **Approved by:** Josh (Project Owner)

## Context

`@zenixsolutions/hudu-mcp` holds a Hudu API key and exposes the Hudu REST API to
a language model. How it is transported and how it is installed are one
decision, not two: the transport determines which clients can reach it, and the
distribution determines how much trust an operator has to extend before they can
evaluate it.

Three facts constrain the choice.

**MCP offers two viable transports.** stdio, where the client spawns the server
as a child process and speaks over its standard streams, and Streamable HTTP,
where the server listens on a URL. Legacy HTTP+SSE is deprecated and is not
under consideration.

**Client support is a capability, not a preference.** Claude Code, Claude
Desktop and Codex can spawn a local stdio process. ChatGPT developer-mode
connectors and Grok custom connectors cannot — they require a publicly reachable
HTTPS endpoint, and Grok explicitly rejects localhost and private addresses. No
packaging trick changes this. An `mcp-remote`-style bridge does not help either:
it is itself a local process, so it does not make the server reachable from a
web client.

**HTTP is a materially larger security surface for this particular server.** A
listener needs bearer authentication, DNS-rebinding protection with explicit
host and origin allowlists, a loopback-by-default bind address, its own rate
limiting, and correct `GET`/`DELETE` handling alongside `POST`. Each of those is
a control that must be built and tested, not a flag. This server holds a
credential that can read every stored password in a Hudu tenant
(`docs/reference/spec-defects.md` A1). Shipping a half-built listener in front
of it would contradict the premise of the project.

The work was scoped by the Project Owner to a single session ending in a working
0.1.0, which makes "build both transports properly" not an available option.

## Decision

1. **stdio is the only transport in 0.1.0.** `src/transport/stdio.ts` is the
   only file in the codebase that knows a transport exists.

2. **The core is transport-independent.** `buildServer(definitions, config)` in
   `src/server.ts` returns a configured `McpServer` and takes no transport. It
   is exported from the package (`exports["."] → dist/server.js`), so the entire
   tool surface is constructible and testable in-process. `src/index.ts` parses
   argv, handles exit codes, and delegates; importing it does not start a
   listener. Adding Streamable HTTP later is a new file in `src/transport/` plus
   its controls — not a refactor of anything above it.

3. **Distribution is npm plus `npx`.** Published as
   `@zenixsolutions/hudu-mcp` with `bin: { "hudu-mcp": "dist/index.js" }`. The
   published package contains `dist` without source maps, README, LICENSE and
   CHANGELOG. `prepublishOnly` performs a clean build; the release workflow
   validates, builds, checks the changelog section for the version, and
   publishes with provenance on a `v*` tag.

4. **TypeScript on Node 20 or later.** `engines: { node: ">=20.0.0" }`, ESM,
   `module: NodeNext`, `target: ES2023`, `strict` plus
   `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Node 18 is end
   of life. TypeScript is chosen because `standards/typescript-standard.md` is
   the only language standard Engineering OS defines; adopting another language
   would require authoring and approving a new standard first.

5. **Two runtime dependencies, total** — `@modelcontextprotocol/sdk` and `zod`.
   HTTP is native `fetch`. Adding a third requires an issue (`CLAUDE.md`).

6. **Remote HTTP transport is deferred**, with no committed release. It is
   raised as an open question in RFC-002 rather than promised.

## Consequences

**ChatGPT and Grok cannot use this server at all.** Not "with reduced
functionality" and not "with an extra setup step" — they cannot execute a stdio
server, and there is no workaround at the packaging layer. This is the single
largest cost of the decision, it is a capability the project simply does not
have in 0.1.0, and the README must state it as an absence rather than omit it.
Overstating client support is the fastest way to lose the trust this project is
trying to earn.

**No hosting, no listener, no inbound attack surface.** There is nothing to
expose, no port to bind, no origin to validate, and no session state to hijack.
The server runs as a child of a client the operator already trusts, on their
machine, with an environment the operator controls. For a process holding a Hudu
API key this is the strongest posture available, and it is a large part of why
the deferral is acceptable rather than merely convenient.

**The credential stays in the client's environment configuration.** It is never
transmitted to a service Zenix operates, because Zenix operates no service. A
buyer's security review of this server does not need to include a security
review of our infrastructure.

**One instance per process, one Hudu tenant per instance.** There is no
multi-tenancy and no credential brokering. An MSP wanting several tenants runs
several server entries. This is a real limitation for a large MSP and a
simplification everywhere else.

**Installation is `npx`, which means trusting npm.** An operator who will not
run arbitrary npm packages has to clone and build instead. That path works but
is not the documented happy path, and the small runtime dependency set exists
partly so that reading the source before installing is a realistic afternoon
rather than a project.

**Diagnostics cannot use stdout.** Stdout is the protocol channel on stdio; a
stray line corrupts the session and can echo data into the transport. All
diagnostics go to stderr, and `no-console` is an ESLint error in `src/` and
`tests/`. This is a permanent constraint on how the codebase is written, not a
setup detail, and it is recorded as invariant 2 in `CLAUDE.md`.

**Adding HTTP later is bounded but not free.** The core is ready for it; the
controls are not written. The estimate implied by "a new file in
`src/transport/`" covers the wiring and not bearer auth, rebinding protection,
allowlisting or listener-level rate limiting. Whoever picks this up should read
this paragraph before quoting the easy half.

**Node 20 excludes nothing anyone still runs**, and CI proves 20 and 22.

## Alternatives Rejected

**HTTP-first, or both transports in 0.1.0.** Rejected on time and risk. The
listener controls are the work, not the transport, and building them under
session pressure in front of a credential with tenant-wide password access is
the wrong trade. Article III ranks security first and ease of adoption fifth.

**stdio permanently, with HTTP ruled out.** Rejected. It would permanently
exclude two major clients on a decision made for schedule reasons. Deferred is
honest; never is a different decision and has not been made.

**An `mcp-remote`-style bridge to reach web clients.** Rejected because it does
not work. The bridge is a local process; it does not make the server reachable
from ChatGPT on the web or from Grok. It appears to solve the problem and does
not.

**A Docker image plus a self-hosted deployment template in 0.1.0.** Rejected as
premature: it is the packaging half of remote transport without the security
half, and it makes Zenix responsible for a secure-by-default posture in
environments we do not control. Revisit alongside the HTTP decision, not before
it.

**A `.mcpb` bundle for Claude Desktop one-click install.** Not rejected on
merit — deferred as out of scope for the session. It is additive to `npx` and
can be added without changing anything in this ADR.

**Python / FastMCP.** Rejected on governance grounds, not technical ones.
Engineering OS defines one language standard and it is TypeScript. Choosing
Python would require authoring and approving a second standard first, which
`governance/decision-hierarchy.md` does not permit skipping for convenience.

**Unscoped npm name `hudu-mcp`.** Better discoverability, weaker provenance
signal. Given that Hudu ships a first-party MCP server, a reader could
reasonably mistake an unscoped package for the official one — and that
misapprehension is security-relevant, because it is a mistake about who to trust
with an API key. The scope stays.

## Security and Compatibility Impact

**Security.** Net positive relative to any HTTP-bearing alternative: no
listener, no inbound surface, no session state, no hosted credential. The
residual risks are supply chain (mitigated by two runtime dependencies and npm
provenance on publish) and the environment holding the API key, which is the
operator's to protect. `SECURITY.md` states plainly that the server does not
authenticate the model: anything that can spawn it can call every tool the
operator enabled. That property is inherent to stdio and is not a defect.

**Compatibility.** The client matrix is the compatibility surface, and it is
asymmetric by client rather than by version: Claude Code, Claude Desktop and
Codex work; ChatGPT and Grok do not. Adding HTTP later is purely additive — no
stdio user is affected — so this decision does not constrain 0.2. The Node 20
floor and the package name are both effectively public API; changing either
after publication is a breaking change. `buildServer` is exported, which makes
its signature part of the public contract for anyone embedding the server rather
than spawning it.

## Supersedes

None. First ADR in this repository.

## Superseded By

None.
