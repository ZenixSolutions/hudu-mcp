/**
 * Credential redaction at the error and logging boundary.
 *
 * This is structural, not incidental. Errors thrown by `fetch` and by our own
 * client can carry request metadata, and a stringified error is the most common
 * way a token reaches a log file. Every path out of the client goes through
 * {@link redact}.
 *
 * Constitution Article VIII: "Secrets must never be committed, logged, echoed,
 * exposed in errors, or included in examples."
 */

/** Header names whose values must never appear in output, lower-cased. */
const SENSITIVE_HEADERS = new Set([
  'x-api-key',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/** Object keys whose values must never appear in output, lower-cased. */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'x-api-key',
  'password',
  'otp_secret',
  'otpsecret',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'client_secret',
  'authorization',
]);

export const REDACTED = '[REDACTED]';

/**
 * Registry of literal secret values to scrub from free text.
 *
 * Key material is registered once at client construction. Scrubbing by value
 * catches the cases key-name matching cannot: a token interpolated into a URL,
 * echoed in an upstream error body, or embedded in a stack frame.
 */
const registeredSecrets = new Set<string>();

/** Register a literal secret to be scrubbed from all redacted output. */
export function registerSecret(secret: string | undefined): void {
  // Very short values would match far too much text; a real Hudu key is long.
  if (secret && secret.length >= 8) registeredSecrets.add(secret);
}

/** Test seam. Not exported from the package entry point. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace every registered secret literal inside a string. */
export function scrubSecrets(text: string): string {
  let output = text;
  for (const secret of registeredSecrets) {
    output = output.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }
  return output;
}

/**
 * Deeply redact a value: sensitive keys are replaced wholesale, and every
 * remaining string is scrubbed for registered secret literals.
 *
 * Cycles are handled — an error object graph can easily contain one.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  if (value instanceof Headers) return redactHeaders(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubSecrets(value.message),
      ...(value.stack ? { stack: scrubSecrets(value.stack) } : {}),
      ...(value.cause !== undefined ? { cause: redact(value.cause, seen) } : {}),
    };
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redact(item, seen);
  }
  return output;
}

/** Redact a Headers instance into a plain object safe to log. */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const output: Record<string, string> = {};
  for (const [name, value] of entries) {
    output[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : scrubSecrets(value);
  }
  return output;
}

/** Redact a URL, dropping any query values that look like credentials. */
export function redactUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return scrubSecrets(rawUrl);
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) url.searchParams.set(key, REDACTED);
  }
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
  }
  return scrubSecrets(url.toString());
}
