/**
 * Structural removal of secret material from Hudu responses.
 *
 * `GET /asset_passwords` returns the `Asset_Password` model, and that model
 * lists `password` and `otp_secret` among its **required** properties. They are
 * present in the list response, not only in a single-record fetch — so one
 * unbounded call returns every stored credential and every TOTP seed in the
 * tenant. This is the single largest risk in the Hudu API surface, and it is
 * the reason this module exists.
 *
 * The rule enforced here: no Hudu response reaches a tool result with those
 * fields intact unless it came from the one tool that is explicitly, separately
 * enabled for it. Stripping happens on the way out of the API layer, so a new
 * tool added later inherits the protection by default rather than having to
 * remember it.
 */

/** Fields removed from every response by default. */
export const SECRET_FIELDS = ['password', 'otp_secret'] as const;

export type SecretField = (typeof SECRET_FIELDS)[number];

const SECRET_FIELD_SET: ReadonlySet<string> = new Set(SECRET_FIELDS);

/**
 * Suffix of the sibling flag that records a redaction.
 *
 * A redacted secret becomes `password: null, password_redacted: true` rather
 * than a placeholder string. That shape is not a stylistic choice.
 *
 * The 0.1.0 behaviour put a sentence *inside* the field — `password:
 * "[withheld: password reveal is disabled on this server]"` — so a list of
 * sixteen credentials came back with sixteen fields named `password`, each
 * holding a plausible fifty-four-character string. Establishing that those were
 * not credentials required noticing that all sixteen were identical. Nothing
 * downstream does that. A model that trusts a field name pastes the value into
 * a ticket, and a script that treats a non-empty `password` as "a password"
 * is correct to do so.
 *
 * So the rule is structural and absolute: **a field named `password` or
 * `otp_secret` never holds a string again.** `null` is unambiguous to every
 * consumer, and the fact the reviewer actually needed — that a value exists —
 * moves to a boolean under a different key, where it cannot be mistaken for
 * the secret itself.
 */
export const REDACTED_FLAG_SUFFIX = '_redacted';

/** The flag key that accompanies a redacted `field`. */
export const redactedFlagFor = (field: string): string => `${field}${REDACTED_FLAG_SUFFIX}`;

/**
 * Replacement written over a secret found by value inside rendered text.
 *
 * Text, unlike a record, has no key to hang a flag on, so this one has to be a
 * string. It is short and obviously not a credential — the failure mode being
 * avoided is a placeholder that *looks* like a value, and a five-character
 * bracketed word does not.
 */
export const REDACTED_TEXT = '[redacted]';

/**
 * Note explaining a redaction, for a tool's `notice` — never for the payload.
 *
 * `executeTool` prepends the notice to the model-visible text, which is where a
 * human-readable explanation belongs. Inside the record it would be a string
 * under a secret's name, which is the defect this replaces.
 */
export const REDACTION_NOTE =
  'Stored secrets were withheld from this result: any field set to null beside a ' +
  '`<field>_redacted: true` flag did hold a value. Read one with hudu_reveal_password, by id, ' +
  'when the user has asked for that specific credential.';

/** The same note for a server where the reveal tool is not registered at all. */
export const REDACTION_NOTE_REVEAL_DISABLED =
  'Stored secrets were withheld from this result: any field set to null beside a ' +
  '`<field>_redacted: true` flag did hold a value. This server has password reveal disabled, so ' +
  'no tool here can return it — the operator must set HUDU_ALLOW_PASSWORD_REVEAL.';

/** True when a secret field holds real material rather than nothing at all. */
const holdsSecret = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== '';

/**
 * Recursively remove secret fields from an arbitrary API payload.
 *
 * Operates on unknown shapes on purpose. Hudu embeds password objects inside
 * assets and companies in places the schema does not document, so a
 * field-by-field allowlist per endpoint would leak the first time the vendor
 * nested one somewhere new.
 *
 * A field that held a value becomes `null` with a `<field>_redacted: true`
 * sibling. A field that was already null, undefined or empty is passed through
 * untouched and gets **no** flag: "this record documents an account with no
 * stored password" and "this record's password was withheld from you" are
 * different facts, and a caller that cannot tell them apart will either invent a
 * credential that does not exist or report a real one as missing.
 */
export function stripSecrets<T>(value: T): T {
  return strip(value, new WeakMap()) as T;
}

function strip(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(strip(item, seen));
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  const flags: string[] = [];

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_SET.has(key)) {
      if (holdsSecret(item)) {
        output[key] = null;
        flags.push(redactedFlagFor(key));
      } else {
        output[key] = item;
      }
      continue;
    }
    output[key] = strip(item, seen);
  }

  // Written after the loop so this server's flag wins over any same-named field
  // the API happens to return. The flag is an assertion about what we did, and
  // upstream data must not be able to contradict it.
  for (const flag of flags) output[flag] = true;

  return output;
}

/**
 * Collect the literal secret values a payload contains.
 *
 * `stripSecrets` protects the *structured* result by walking keys. It cannot
 * protect a rendered string, and a tool handler may build a Markdown view of
 * the raw record before stripping runs — which is exactly how a password
 * reached a tool result through `response_format: "markdown"`. A rendered
 * string has no keys to walk, so it has to be scrubbed by value instead, and
 * this is what supplies those values.
 */
export function collectSecretValues(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, seen: WeakSet<object>): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, seen);
      return;
    }

    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      // Any non-empty string under a secret's name is treated as the real thing.
      // There is no placeholder to exempt any more, and that is the point: a
      // walker with an exemption list is a walker that can be fooled into
      // ignoring a value by making it resemble the exemption.
      if (SECRET_FIELD_SET.has(key) && typeof item === 'string' && item !== '') {
        found.add(item);
        continue;
      }
      walk(item, seen);
    }
  };
  walk(value, new WeakSet());
  return [...found];
}

/**
 * Replace literal secret values inside an already-rendered string.
 *
 * `split`/`join` rather than a regular expression: a stored password is
 * arbitrary text and would otherwise have to be escaped, and an escaping
 * mistake here is a leak.
 */
export function redactSecretsInText(
  text: string,
  secrets: readonly string[],
  placeholder: string,
): string {
  let output = text;
  for (const secret of secrets) output = output.split(secret).join(placeholder);
  return output;
}

/**
 * Assert that a payload carries no secret material.
 *
 * Used by the security test suite and as a last-resort runtime guard on the
 * response path. Article VIII requires security controls to be verified rather
 * than assumed; this is the verification hook.
 *
 * The invariant it checks is now exact rather than approximate: after
 * `stripSecrets`, **no** string may sit under a secret's name, so any string
 * found here is a leak. There is no placeholder to make an exception for, which
 * is what lets this be a flat rule instead of a rule with a hole in it.
 */
export function findSecretFields(value: unknown, path = '$'): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string, seen: WeakSet<object>): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${at}[${index}]`, seen);
      });
      return;
    }

    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      const here = `${at}.${key}`;
      if (SECRET_FIELD_SET.has(key) && typeof item === 'string' && item !== '') {
        found.push(here);
        continue;
      }
      walk(item, here, seen);
    }
  };
  walk(value, path, new WeakSet());
  return found;
}
