<!--
Read CONTRIBUTING.md before opening this. It explains which of the steps below
CI enforces and which are convention.

Use a Conventional Commits title, e.g. "fix(api): percent-encode slug segments".
The title becomes the commit message, because pull requests are squash merged.
-->

## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

Closes #

<!--
Link the issue. If there is no issue, say why not — a change with no issue will
be asked for one before review.
-->

## Approach

<!--
How, and what you rejected. If the change touches the Hudu API surface, cite the
endpoint and field from docs/reference/api-docs.json, and the relevant item in
docs/reference/spec-defects.md if there is one.
-->

## Checklist

- [ ] There is a tracked issue, and it was approved before implementation.
- [ ] An RFC was written, or this change does not require one.
- [ ] `npm run validate` passes locally (typecheck, lint, format:check, test, build).
- [ ] There is a test that fails without this change, or the change is not behavioural.
- [ ] Documentation is updated in this pull request, or nothing user-facing changed.
- [ ] `CHANGELOG.md` under `[Unreleased]` is updated, or this change is not user-visible.
- [ ] No secret material is added anywhere, including tests, fixtures and commit messages.

<!--
An unticked box with a sentence explaining why is more useful than a ticked one
that is not true. Do not tick a box you have not actually verified.
-->

## Invariants

Confirm none of these are broken, or explain below. They are defined in
`CLAUDE.md`.

- [ ] Every interpolated path segment is percent-encoded via `src/api/paths.ts`.
- [ ] Nothing writes to stdout; diagnostics go to stderr.
- [ ] Secret stripping still happens centrally in `executeTool`; no tool bypasses it.
- [ ] Capability gates remain environment-only; no gate is exposed as a tool argument.
- [ ] No invented pagination metadata — no `total`, no `has_more`.
- [ ] New tools go through `defineTool` or `buildResourceTools`.
- [ ] Only documented API surface is used.

## Anything a reviewer should look at first

<!-- Risky part, thing you are unsure about, or "nothing" -->
