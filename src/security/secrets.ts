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

/** Placeholder left behind so a model can see that a value exists. */
export const WITHHELD = '[withheld: use hudu_reveal_password]';

/** Placeholder used when the reveal tool itself is not enabled. */
export const WITHHELD_DISABLED = '[withheld: password reveal is disabled on this server]';

export interface StripOptions {
  /** Replace secrets with a placeholder instead of deleting the key outright. */
  readonly placeholder?: string | undefined;
}

/**
 * Recursively remove secret fields from an arbitrary API payload.
 *
 * Operates on unknown shapes on purpose. Hudu embeds password objects inside
 * assets and companies in places the schema does not document, so a
 * field-by-field allowlist per endpoint would leak the first time the vendor
 * nested one somewhere new.
 */
export function stripSecrets<T>(value: T, options: StripOptions = {}): T {
  return strip(value, options, new WeakMap()) as T;
}

function strip(value: unknown, options: StripOptions, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;

  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(strip(item, options, seen));
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD_SET.has(key)) {
      // Only mark a field as withheld when something was actually there. A null
      // password is a real, useful fact about a record and must not be
      // disguised as a redaction.
      if (item === null || item === undefined || item === '') {
        output[key] = item;
      } else if (options.placeholder !== undefined) {
        output[key] = options.placeholder;
      }
      continue;
    }
    output[key] = strip(item, options, seen);
  }
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
      if (
        SECRET_FIELD_SET.has(key) &&
        typeof item === 'string' &&
        item !== '' &&
        !item.startsWith('[withheld')
      ) {
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
      if (
        SECRET_FIELD_SET.has(key) &&
        typeof item === 'string' &&
        item !== '' &&
        !item.startsWith('[withheld')
      ) {
        found.push(here);
        continue;
      }
      walk(item, here, seen);
    }
  };
  walk(value, path, new WeakSet());
  return found;
}
