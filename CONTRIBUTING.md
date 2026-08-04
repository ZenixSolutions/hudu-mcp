# Contributing to hudu-mcp

This repository is governed by [Engineering OS](https://github.com/ZenixSolutions/engineering-os).
Engineering OS defines how the project is built: its standards for architecture,
TypeScript, security, testing, documentation and release are authoritative here.
This file describes what that means in practice for this repository.

Everything below applies to contributions from outside the project as well as
inside it. If a rule here conflicts with Engineering OS, Engineering OS wins;
open an issue rather than guessing.

## Before you write code

Read `docs/reference/spec-defects.md` first. It records what the captured Hudu
API contract actually says, including the places where it contradicts itself and
the questions it cannot answer. Most surprising decisions in this codebase trace
back to a numbered item in that file, and a change that ignores it is likely to
be reverted.

## Contribution lifecycle

1. **Open or select an issue.** Every change starts from a tracked issue.
   Drive-by pull requests with no issue will be asked for one before review.
2. **Discovery.** Establish what the API actually does before proposing a fix.
   For anything touching the Hudu surface, cite the endpoint and the field from
   `docs/reference/api-docs.json`. Behaviour observed on one instance is
   evidence about that instance, not about the API.
3. **RFC when required.** An RFC is required for a change to the security model,
   the tool surface visible to a model, the layer boundaries, a new runtime
   dependency, or anything that alters published behaviour. Small bug fixes and
   documentation do not need one.
4. **Approval before implementation.** Wait for the issue or RFC to be approved
   before building. Silence is not approval.
5. **Tests and documentation.** A behaviour change needs a test that fails
   without it. A change to configuration, tool arguments or defaults needs the
   corresponding documentation updated in the same pull request.
6. **Independent review.** Someone other than the author reviews the change.
7. **Validation.** `npm run validate` passes locally and CI passes on the pull
   request.
8. **Merge approval.** The repository owner approves the merge.

### What is enforced by CI, and what is not

Be clear-eyed about this. CI is a machine check; the rest is a human agreement.

| Step                                                         | Enforced by                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| Typecheck, lint, format, test, build                         | CI (`.github/workflows/ci.yml`), every push and pull request |
| Install smoke test (`--version`, `--help`)                   | CI                                                           |
| Committed-credential scan                                    | CI, pattern-based (see the caveat below)                     |
| Changelog completeness at release                            | CI (`.github/workflows/release.yml`), on `v*` tags only      |
| Issue exists, discovery done, RFC written, approval obtained | Convention. Nothing blocks a pull request that skips them.   |
| Tests and documentation accompany the change                 | Convention, checked in review                                |
| Independent (non-author) review                              | Branch protection, with an admin exemption. See below.       |
| Merge approval                                               | Convention                                                   |

**Independent review is enforced for contributors, with a deliberate admin
exemption.** `main` requires the three CI checks to pass, one approving review,
resolved conversations, and linear history, and it forbids force-pushes and
deletion. But `enforce_admins` is off, so a repository administrator can merge
without the approval.

That exemption is not an oversight. GitHub does not permit approving your own
pull request, so on a repository with a single maintainer a hard approval rule
does not produce review — it produces a stuck queue, and then either a second
account rubber-stamping the same person's work or the rule being switched off
under pressure. The exemption keeps the gate real for every contributor while
leaving the maintainer a bypass they have to choose, and each bypass is recorded
in the pull request timeline.

What this means in practice: if you are not an administrator, the review
requirement is a technical control and you cannot route around it. If you are,
it is a decision you are making, and Article VI still applies to you.

The credential scan looks for a fixed set of patterns — private key blocks,
provider-issued token formats, and assignments to `HUDU_API_KEY` that look like
a real key. It will not catch a secret in a shape nobody anticipated. Treat it
as a backstop, not as permission to stop thinking. No secret material may be
committed, ever, including in test fixtures and in commit messages.

## Working locally

```bash
npm ci
npm run validate      # typecheck, lint, format:check, test, build
```

Run `npm run validate` before you push. CI runs the same steps on Node 20 and
Node 22; running it locally is how you avoid finding out about a failure ten
minutes later.

Useful individual scripts:

| Script                             | What it does                                          |
| ---------------------------------- | ----------------------------------------------------- |
| `npm run typecheck`                | `tsc --noEmit`                                        |
| `npm run lint` / `lint:fix`        | ESLint                                                |
| `npm run format` / `format:check`  | Prettier                                              |
| `npm test` / `npm run test:watch`  | Vitest                                                |
| `npm run test:contract`            | Live tests against a real instance; opt-in, see below |
| `npm run build`                    | Emit `dist/`                                          |
| `npm run check:changelog -- X.Y.Z` | Validate one CHANGELOG section                        |

Contract tests are not run by CI and are not run by `npm test`. They issue real
requests against the instance in your environment, so they require
`HUDU_CONTRACT_TESTS=1` plus a working `HUDU_BASE_URL` and `HUDU_API_KEY`. Use a
non-production instance, or a key scoped to a single test company.

Copy `.env.example` to `.env` for local configuration. `.env` and every other
`.env.*` file except `.env.example` are gitignored. Do not remove that
exclusion.

## Repository layout

`src/` is layered, and the layering is the main thing reviewers will check. Each
layer may import from the ones below it and never from the ones above.

| Directory           | Holds                                                                                                           | Must not                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/index.ts`      | CLI entry: argument parsing, exit codes, usage text                                                             | Contain domain logic; start a listener on import          |
| `src/server.ts`     | `buildServer` — turns tool definitions plus config into an `McpServer`                                          | Know anything about a specific Hudu endpoint              |
| `src/transport/`    | stdio wiring                                                                                                    | Write to stdout for anything but protocol frames          |
| `src/tools/`        | Tool declarations: name, description, schema, operation class, handler                                          | Reimplement gating, secret stripping or error shaping     |
| `src/presentation/` | Response shaping: markdown rendering, field projection, page info, character budget                             | Perform I/O                                               |
| `src/security/`     | Operation classification and secret stripping                                                                   | Depend on the API client or on MCP types                  |
| `src/api/`          | HTTP to Hudu: client, path building and encoding, envelope unwrapping, error translation, rate limit, redaction | Know that MCP exists                                      |
| `src/config.ts`     | Environment parsing and validation                                                                              | Read from disk; accept configuration from a tool argument |

`src/domain/` exists for logic that is neither transport nor presentation. It is
empty at 0.1.0; do not add to it without an issue explaining why the logic does
not belong in an existing layer.

`tests/` mirrors the concerns rather than the file tree: `unit/`, `integration/`,
`security/`, `installation/`, `contract/`.

## Adding a tool

New tools go through the factories, not around them.

- Declarative CRUD over a resource: describe it to `buildResourceTools` in
  `src/tools/resource.ts`.
- Anything irregular: `defineTool` from `src/tools/define.ts`.

Do not call `server.registerTool` from a tool module, and do not build a tool
object literal that bypasses `prepareTool`/`executeTool`. The factories are what
apply operation classification, capability gating, the `confirm` argument,
secret stripping, error translation and response shaping uniformly across all
89 tools. A tool that registers itself is a tool that silently opts out of all
of them, and that is the failure mode this design exists to prevent.

Two further rules for tool authors:

- **Only documented API surface.** If it is not in
  `docs/reference/api-docs.json`, it does not get a tool. Undocumented
  behaviour observed on one instance is not a contract.
- **Never invent pagination metadata.** No Hudu collection endpoint returns a
  total count, so `total` and `has_more` cannot be derived. `page_was_full` is
  the honest signal and the only one this server emits.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for
commit messages and for the pull request title, because the title becomes the
commit message on merge:

```
feat(tools): add hudu_list_rack_storage_items
fix(api): percent-encode slug segments in article paths
docs(security): describe API key scoping at creation
chore(deps): bump typescript-eslint to 8.46.0
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`,
`chore`. Breaking changes carry a `!` after the type or a `BREAKING CHANGE:`
footer.

Pull requests are **squash merged**. Keep the branch focused on one issue;
rebase rather than merging `main` into your branch. Branch names are free-form
but a `type/short-description` shape reads well in the merge log.

Fill in `.github/pull_request_template.md` honestly. An unticked box with a
sentence explaining why is more useful than a ticked one that is not true.

## Releases

Versioning is [semantic](https://semver.org/), tags are `vX.Y.Z`, and
`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Releases are cut by the repository owner: the changelog section for the version
is completed and dated, the version in `package.json` is bumped, and a `v*` tag
is pushed. `.github/workflows/release.yml` then validates, builds, checks that
version's changelog section with `npm run check:changelog`, dry-runs the
tarball, and publishes to npm.

Publishing uses **npm trusted publishing** over GitHub's OIDC rather than a
stored npm token. This repository therefore holds no npm credential: there is
nothing to rotate and nothing to steal along with the repository, and npm
attests provenance automatically — which workflow and which commit produced the
tarball. The trade is that the trusted publisher has to be configured on
npmjs.com against this repository and this workflow filename, and a
misconfiguration surfaces only at publish time. The workflow prints what to fix
if that happens, and nothing is published, so the version number stays free.

Pre-1.0, the tool surface may still change between minor versions. That is
deliberate and is why the package is at 0.x.

## Security issues

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
