# CLAUDE.md

Instructions for AI agents working **on this repository**. This is not
documentation for users of the server; for that, see `README.md`.

## Authority

[Engineering OS](https://github.com/ZenixSolutions/engineering-os) is the
authoritative source for how this project is built — architecture, coding
standards, repository structure, documentation, testing, security, workflow,
review and decision-making. Follow its standards unless this repository
documents an approved exception. Do not invent a convention Engineering OS
already defines. Where this repository and Engineering OS conflict, ask; do not
choose.

`CONTRIBUTING.md` describes the contribution lifecycle and states plainly which
steps CI enforces and which are convention. Read it before proposing changes.

## Read these before changing anything

| File                             | Why                                                                     |
| -------------------------------- | ----------------------------------------------------------------------- |
| `docs/reference/spec-defects.md` | Every non-obvious decision in this codebase traces to a numbered item   |
| `docs/reference/api-docs.json`   | The captured Hudu contract. The only source of truth about the API      |
| `src/tools/define.ts`            | The tool factory; where gating, stripping and error shaping happen once |
| `src/tools/resource.ts`          | The CRUD generator most tools are built from                            |
| `src/security/secrets.ts`        | Why secret stripping is structural rather than per-tool                 |

If you are about to write a comment explaining why something is done a strange
way, check whether `spec-defects.md` already explains it and cite the item
instead.

## Layers

`src/` is layered. A layer may import from the layers below it and never from
the ones above.

```
index.ts          CLI: argv, exit codes, usage text. No domain logic.
  server.ts       buildServer(): tool definitions + config -> McpServer.
    transport/    stdio wiring.
    tools/        Tool declarations. define.ts is the factory; resource.ts
                  generates the repeated CRUD shapes; per-resource modules
                  state only what is genuinely different.
      presentation/  Response shaping: markdown, field projection, page info,
                     character budget. No I/O.
      security/      Operation classification and secret stripping. Pure.
      api/           HTTP to Hudu: client, paths, envelope, errors, rate
                     limit, redaction. Knows nothing about MCP.
        config.ts    Environment parsing and validation. Nothing read from disk.
```

`src/domain/` is empty at 0.1.0 and reserved. Do not populate it without an
issue explaining why the logic belongs in no existing layer.

Consequences worth stating explicitly:

- Nothing in `api/` may import from `tools/` or reference MCP types.
- Nothing in `security/` or `presentation/` may perform I/O.
- `index.ts` must remain importable without starting a listener.

## Invariants

These are not style preferences. Breaking one is a defect, and each has a reason
recorded in the code or in `spec-defects.md`.

1. **Percent-encode every interpolated path segment.** Use `encodeSegment` and
   `buildPath` from `src/api/paths.ts`. Path segments come from model-supplied
   tool arguments; an unencoded identifier is a path-injection surface. Never
   build a Hudu URL with string concatenation or a template literal.

2. **Never write to stdout on stdio.** Stdout is the protocol channel; a stray
   line corrupts the session and can echo data into the transport. Diagnostics
   go through `process.stderr.write`. `no-console` is an ESLint error in `src/`
   and `tests/` and must stay that way.

3. **Secrets are stripped centrally, in `executeTool`.** `stripSecrets` runs on
   every tool result in `src/tools/define.ts`. No tool may bypass it, pre-strip
   its own output, or return raw API data through a path that skips it. The only
   exception is the single tool declared with `requiresPasswordReveal`, and that
   exception is expressed as a flag on the definition — not as a different code
   path.

4. **Capability gates are environment-only.** `HUDU_READ_ONLY`,
   `HUDU_ALLOW_DESTRUCTIVE`, `HUDU_ALLOW_PASSWORD_REVEAL`,
   `HUDU_ALLOW_PASSWORD_WRITE` and `HUDU_ALLOW_EXPORTS` are read from the
   environment in `src/config.ts` and nowhere else. Never add a tool argument
   that enables, overrides or softens a gate, and never accept a credential as a
   tool argument. A gated tool is not registered at all rather than
   registered-and-refusing.

   **Gate both directions.** 0.1.0 gated _reading_ a stored credential and left
   _writing_ one ungated, so a password-scoped key could overwrite a secret it
   could not read. When a gate protects a resource, ask what else touches that
   resource before deciding the gate is complete — reads are the direction that
   comes to mind first and rarely the more consequential one.

5. **Never invent pagination metadata.** No Hudu collection endpoint returns a
   total, and there is no envelope, no `X-Total-Count` and no `Link` header
   (`spec-defects.md` C1). `total` and `has_more` therefore cannot be derived
   and must never be emitted: an agent reading `has_more: false` would report a
   partial inventory as complete. `page_was_full` is the honest signal. Five
   collections have no pagination at all (C2) and must report that rather than
   fake a page.

   The same rule applies to anything that narrows a result without saying so.
   `GET /companies` silently omits archived records and offers no parameter to
   include them, so a note reading "this is the last page for the current
   filters" is true about the paging and misleading about the universe — hence
   `completenessCaveat`. And truncation metadata is emitted _before_ `items`,
   because clients clip long results and a correction below the payload is a
   correction nobody reads.

6. **Only documented API surface.** If an endpoint, parameter or field is not in
   `docs/reference/api-docs.json`, it does not get a tool, an argument, or a
   documented behaviour. Behaviour observed on one live instance is evidence
   about that instance, not about the API. Where the contract is silent, record
   it as undocumented rather than guessing — and where the contract contradicts
   itself, do not pick a side that could destroy data (see B6, where `fields` is
   deliberately absent from `hudu_update_asset_layout`).

7. **New tools go through the factories.** `defineTool` for irregular
   endpoints, `buildResourceTools` for the repeated CRUD shapes. Do not call
   `server.registerTool` from a tool module and do not hand-construct a prepared
   tool. The factories are what keep classification, gating, confirmation,
   stripping and error translation uniform across all 89 tools.

8. **No secret material in the repository.** Not in tests, not in fixtures, not
   in documentation, not in a commit message. `.env.example` carries
   placeholders only. CI scans for committed credentials, but the scan is a
   pattern list and cannot be relied on to catch a novel shape.

## Working conventions

- Run `npm run validate` before declaring work finished. It is typecheck, lint,
  format:check, test and build, and it is what CI runs.
- Conventional Commits; pull requests are squash merged, so the pull request
  title becomes the commit message.
- A behaviour change needs a test that fails without it. Tests live under
  `tests/{unit,integration,security,installation,contract}/`.
- Contract tests hit a live instance and are opt-in via `HUDU_CONTRACT_TESTS=1`.
  Never enable them in CI.
- `scripts/*.mjs` are outside every tsconfig by design; they are linted by the
  dedicated ESLint block in `eslint.config.js`.
- Do not add a runtime dependency without an issue. The runtime dependency set
  is `@modelcontextprotocol/sdk` and `zod`, and keeping it that small is a
  deliberate supply-chain decision.
- Do not claim a control exists in documentation unless it does. If a check is
  convention rather than enforcement, say so.
