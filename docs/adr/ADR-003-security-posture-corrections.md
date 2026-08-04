# ADR-003: Security posture corrections — a fifth gate, honest annotations, and a redaction that cannot be mistaken for a secret

- **Status:** Accepted
- **Date:** 2026-08-04
- **Related RFC:** RFC-002 (D6, Security Impact)
- **Supersedes:** ADR-002, in part
- **Approved by:** Josh (Project Owner)

## Context

[ADR-002](ADR-002-security-posture.md) recorded the security posture 0.1.0
shipped with. An external reviewer then used the published
`@zenixsolutions/hudu-mcp@0.1.0` package against a live Hudu 2.34.2 instance and
found three defects in it. Two are security defects; the third is a disclosure
defect that behaves like one in a transcript.

None was found by `tests/security/`, which runs on every push. That is the fact
worth recording before the decisions, because it explains why all three survived
review. Each test in that suite compared the implementation against a
specification derived from the same reasoning that produced the code, so where
the reasoning was wrong the test agreed with it. A suite written from a
restatement of the author's intent cannot detect that the intent was wrong. Only
somebody using the artefact, without that intent in their head, can.

### The three findings

**1. The write direction to the credential vault was ungated.**
`HUDU_ALLOW_PASSWORD_REVEAL` gated `hudu_reveal_password` and nothing else.
`hudu_create_password`, `hudu_update_password` and `hudu_archive_password` were
`Create` and `Update` tools and therefore registered by default, so a deployment
whose API key could not read a stored credential could still overwrite or archive
one. The destructive direction was open while the read direction was locked.

The reasoning in ADR-002 section 5 treated the password problem as a disclosure
problem: A1 says a list call returns every secret in the tenant, so the posture
was built around stopping secrets leaving. That is the larger risk and it was
correctly addressed. It is not the only one. A password record is frequently the
only written record of a working credential; a PUT that replaces it, or an
archive that hides it, destroys operational access to a customer's estate without
disclosing anything. "Did a secret leave the building?" was the wrong question to
gate on alone.

**2. Every mutating tool told clients it was not destructive.** `annotationsFor`
mapped `destructiveHint` from the operation class, which is correct, but mapped
it as "does this tool delete something". Only `Destructive` got `true`. The 32
tools that change something and are not classed `Destructive` — 13 `Create`, 17
`Update`, 2 `Admin` — all carried `destructiveHint: false`, including
`hudu_archive_company`, `hudu_archive_password` and `hudu_update_password`.

The protocol's definition is not the narrow one. `destructiveHint: true` means
the tool **may perform destructive updates**; `false` means it performs **only
additive** ones. A client that decides what to prompt a human about from
annotations reads `false` as a positive assertion that nothing existing can be
lost. A PUT that replaces the prior value of every field it carries, against an
API with no undo, cannot honestly make that assertion.

**3. A withheld secret was a plausible-looking string in a field named
`password`.** `stripSecrets` replaced the value with
`[withheld: password reveal is disabled on this server]` — 54 characters, once
per record. The reviewer called `hudu_list_passwords`, received sixteen records
each carrying a `password` field with a non-empty string in it, and established
that they were not credentials by counting distinct values and finding one.

Nothing downstream performs that check. A model that trusts a field name pastes
the value into a ticket. A script that treats a non-empty `password` as a
password is behaving correctly, and would file the sentence as the credential.
ADR-002 section 4 recorded the intent — "a placeholder is left behind so a model
can tell that a value exists" — and the intent was right. The realisation put the
signal inside the field it was signalling about, which is the one place it could
be mistaken for the thing itself.

## Decision

### 1. A fifth environment gate: `HUDU_ALLOW_PASSWORD_WRITE`

It defaults off, like every other. It gates every write tool generated for a
resource marked `storesSecrets: true` in `src/tools/resource.ts` — today that is
`hudu_create_password`, `hudu_update_password` and `hudu_archive_password` — and
combines with `HUDU_ALLOW_DESTRUCTIVE` on `hudu_delete_password`, which needs
both. Enforcement is where every other gate's is: `shouldRegister` in
`src/tools/define.ts` decides registration, `executeTool` re-checks at call time,
and `withholdReason` in `src/server.ts` names the variable in `--list-tools`
output.

It is declared on the tool definition as `requiresPasswordWrite`, in the same
shape as `requiresPasswordReveal` and `requiresExportFlag`, so it is auditable by
reading one field rather than by tracing a code path.

**It is deliberately a separate flag from `HUDU_ALLOW_PASSWORD_REVEAL`, and
neither implies the other.** Both directions of that implication were considered
and rejected:

- _Reveal implies write._ Rejected. An operator who wants an assistant to read a
  credential for a human to use has said nothing about whether it may alter the
  vault. Reading is the more common need and would silently carry the rarer,
  lossier one.
- _Write implies reveal._ Rejected, and this is the case that matters. An
  operator who wants an agent to **document** a newly issued credential — write
  down what was just rotated, file it against the right company — would have to
  grant that agent read access to every existing credential in order to do it.
  Writing without reading is a legitimate posture. So is reading without writing.
  Collapsing them would make the strictly safer configuration unreachable.

Reads are untouched by this gate. Metadata about a credential is not the
credential, and central stripping already covers the values.

Default registration therefore falls from 70 tools to 67. That is a breaking
change to the tool surface for anyone on 0.1.0, which is why 0.2.0 is a minor
bump rather than a patch.

### 2. `destructiveHint` follows the protocol's definition, not the narrow one

`Read` and `Create` carry `destructiveHint: false`. `Update`, `Admin` and
`Destructive` carry `true`.

- `Create` genuinely is additive: it brings a new record into existence and
  touches no existing one. It is the only non-`Read` class that can claim `false`
  under the protocol's wording.
- `Update` is destructive **and** idempotent, which is the pair that shows the
  two hints are orthogonal rather than opposites. Destructive because a PUT
  replaces the prior value of every field it carries and that value is not
  recoverable through this API. Idempotent because replaying the same PUT lands
  in the same state — a statement about retry safety, not about what the first
  call cost.
- `Admin` covers the bulk exports. Moving a copy of tenant data outside the
  tenant cannot be undone by deleting anything inside it. Nothing about that is
  additive.

Annotations remain derived from the class rather than hand-set per tool, which is
what ADR-002 section 1 decided and what remains right: the fix was to one
mapping, in one function, and it corrected all 19 affected tools at once.

The regression test for this restates the expected table longhand instead of
calling `annotationsFor`. A test that asks the implementation what it thinks
would have agreed with the defect, which is exactly what happened.

### 3. A redacted secret is `null` plus a sibling flag, and never a string

The rule is structural and absolute: **a field named `password` or `otp_secret`
never holds a string in a tool result again.** A value that was present becomes
`null`, with `password_redacted: true` (or `otp_secret_redacted: true`) written
beside it. A field that was already `null`, absent or empty passes through
untouched and gets **no** flag.

That last clause is the part that keeps ADR-002's original intent intact. "This
record documents an account with no stored password" and "this record's password
was withheld from you" are different facts, and a caller that cannot tell them
apart will either invent a credential that does not exist or report a real one as
missing. The flag is the discriminator, and it lives under a key that cannot be
confused for the secret.

Three consequences follow, and each removed a hole rather than adding a
mitigation:

- The flag is written **after** the record's own fields are copied, so this
  server's assertion wins over any same-named field the API happens to return.
  The flag is a statement about what this server did; upstream data must not be
  able to contradict it.
- `collectSecretValues` and `findSecretFields` no longer exempt any string. There
  is no placeholder to make an exception for, so the invariant is flat — any
  string under a secret's name is a leak — rather than a rule with a hole in it.
  A walker with an exemption list can be fooled into ignoring a value by making
  it resemble the exemption.
- The human-readable explanation moved to the tool result's `notice`, which
  `executeTool` prepends to the model-visible text. It says a value was withheld,
  how to tell a withheld field from an empty one, and what to do about it — under
  no key at all, where it cannot be read as data.

Rendered text is the one place a string is still unavoidable, because a rendered
string has no key to hang a flag on. There the marker is `[redacted]`: short, and
obviously not a credential. The failure being avoided is a stand-in that _looks_
like a value, and a bracketed word does not.

## Consequences

**An operator upgrading from 0.1.0 who used password writes must set a new
variable.** Their tools disappear until they do, and `--list-tools` names the
variable. This is the correct failure direction — closed, and explained — but it
is a breaking change and is called out in `CHANGELOG.md` under a migration
heading rather than left to be discovered.

**A consumer parsing the withheld string breaks.** ADR-002's compatibility
section named those strings as part of the observable output contract, so this is
a breaking change made knowingly. Anything reading them switches to
`password_redacted`. The old shape could not be kept alongside the new one: the
whole value of the change is that no string appears under a secret's name, and an
opt-out would preserve the defect for whoever did not opt in.

**Clients that prompt from annotations will now prompt on 19 more tools.** That
is the point, and it will be experienced as friction by anyone who had grown used
to archive and update running silently. The alternative is a client that cannot
warn a user before an overwrite because this server told it there was nothing to
warn about.

**`Update` still requires no `confirm: true`.** The class obligations are
unchanged: only `Destructive` and `Admin` require the argument. So an operator who
sets `HUDU_ALLOW_PASSWORD_WRITE` has enabled single-call overwrites of vault
entries. The annotation now tells the client that, and the tool description tells
the model to state which record it is altering, but neither is a control. This is
recorded as a residual risk in `docs/security.md` rather than closed, because
adding `confirm` to the whole `Update` class is a wider change than this ADR
justifies and adding it to three tools by hand would put an obligation somewhere
other than the class table — which is exactly the drift ADR-002 section 1 exists
to prevent.

**The security suite's coverage claim is weaker than it looked.** Three defects
passed it. The tests were not wrong about what they asserted; they asserted the
author's intent back to the author. The repair applied here is narrow — the
annotation test now restates its table longhand instead of calling the
implementation — and it does not generalise. What generalises is the finding
itself: use of the published artefact by somebody who did not build it found what
the suite could not, and there is no test that substitutes for that.

## Alternatives Rejected

**Fold password writes under `HUDU_ALLOW_PASSWORD_REVEAL`.** Rejected. It would
close the hole while forcing anyone who wants write-only to grant vault-wide
reads, which is the strictly worse of the two postures. See Decision 1.

**Class password writes as `Destructive` instead of adding a gate.** Rejected.
It would work — `HUDU_ALLOW_DESTRUCTIVE` would then gate them — but it would tie
credential writes to article and asset deletion, so an operator who wanted an
agent to tidy up stale articles would get vault writes as part of the bargain.
The classes describe what an operation does; the gates describe what an operator
permits. Overloading a class to reach a gate corrupts both.

**Keep the placeholder string but make it obviously fake**, for example
`"***"` or an empty string. Rejected. `"***"` is still a string under a key named
`password`, and the class of defect is "a consumer reads the field and gets
something". An empty string is worse: it collides with the genuinely-empty case
this design goes out of its way to keep distinguishable.

**Omit the field entirely rather than nulling it.** Rejected. A caller iterating
records cannot distinguish an omitted key from a record shape that never had one,
and a schema consumer would see the field disappear and reappear depending on the
server's configuration. `null` plus a flag says more, in a shape that does not
change.

**Annotate `Update` as `destructiveHint: false` but `idempotentHint: false`.**
Rejected, and worth naming because it was the tempting middle path. It answers
the wrong question. The hints are independent: one is about whether existing data
can be lost, the other about whether replaying the call does further harm. Making
the idempotency hint carry the warning would have left the destructiveness hint
lying and made the idempotency hint wrong as well.

**Leave the annotations and document the discrepancy.** Rejected under ADR-002's
own rejected alternative — a description is an instruction, not a control. An
annotation is worse than a description here, because a client acts on it
automatically without a model in the loop to read a caveat.

## Security and Compatibility Impact

**Security.** Three defects closed, each pinned by a regression test that fails
without its fix: capability gating for password writes
(`tests/security/capability-gates.test.ts`), the annotation table
(`tests/security/tool-surface.test.ts`), and the redaction shape
(`tests/security/secret-exposure.test.ts`, `tests/unit/secrets.test.ts`). No
control was removed or relaxed. The residual risks in `docs/security.md` gain one
entry — a permitted credential write takes no per-call confirmation — which was
true before and undocumented.

**Compatibility.** Three breaking changes, all in 0.2.0:

1. The registered tool surface shrinks from 70 tools to 67 under default
   settings. Adding a gate to something previously ungated is breaking, which
   ADR-002's compatibility section anticipated and permitted pre-1.0 with a minor
   bump and a changelog entry.
2. The response shape of `password` and `otp_secret` changes on every tool that
   returns a password record.
3. `destructiveHint` changes on 19 tools, which is observable to any client that
   reads annotations.

Adding the gate is otherwise backward compatible in the direction that matters:
it defaults off, so an unmodified 0.1.0 configuration gets the safer behaviour
without being asked. `HUDU_ALLOW_PASSWORD_WRITE` joins the environment variable
names that are effectively public API and cannot be renamed without another
breaking change.

## Supersedes

[ADR-002: Security posture](ADR-002-security-posture.md), in part — its section 2
gate list, its section 4 redaction shape, and the annotation mapping implied by
its section 1. ADR-002 is left unedited apart from a pointer at the top and a
`Superseded By` entry, because the reasoning that produced a defect is more
useful to a future reader than a record revised to look correct.

## Superseded By

None.
