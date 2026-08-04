/**
 * URL construction for the Hudu REST API.
 *
 * Every interpolated path segment is percent-encoded. This is not defensive
 * style — an unencoded identifier is a path-injection surface, and the segments
 * here come from model-supplied tool arguments.
 */

export const API_PREFIX = '/api/v1';

/** A value legal to interpolate into a path segment. */
export type PathSegment = string | number;

export class PathBuildError extends Error {
  public override readonly name = 'PathBuildError';
}

/**
 * Encode one path segment.
 *
 * Rejects empty, whitespace-only, and non-finite values outright. Hudu answers
 * `404` for a malformed path just as it does for a missing record, so a bad
 * segment that reaches the wire produces an error that cannot be diagnosed.
 * Failing here instead keeps the cause visible.
 *
 * Dot segments are rejected rather than encoded. `encodeURIComponent` leaves
 * `.` and `..` untouched, and the WHATWG URL parser inside `fetch` collapses
 * them before the request is sent — `/api/v1/companies/..` is requested as
 * `/api/v1/`. Encoding cannot fix this, because the same parser decodes `%2e`
 * back to `.` and collapses it anyway. Refusal is the only control that works,
 * and Invariant 1 in CLAUDE.md is what it protects.
 */
export function encodeSegment(value: PathSegment): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PathBuildError(`Path segment must be a finite number, received ${String(value)}`);
    }
    if (!Number.isInteger(value)) {
      throw new PathBuildError(`Hudu record ids are integers, received ${String(value)}`);
    }
    return encodeURIComponent(String(value));
  }
  const trimmed = value.trim();
  if (trimmed === '') throw new PathBuildError('Path segment must not be empty');
  if (DOT_SEGMENT.test(trimmed)) {
    throw new PathBuildError(
      `Path segment must not be a relative path element, received "${trimmed}". A "." or ".." ` +
        'segment is collapsed by the URL parser and would address a different endpoint.',
    );
  }
  return encodeURIComponent(trimmed);
}

/**
 * `.` and `..`, plain or percent-encoded.
 *
 * The encoded forms are matched too: a proxy that decodes once before this
 * client's own encoding is undone would turn `%2e%2e` back into `..`.
 */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Build an API path from a template and its segments.
 *
 * @example buildPath('/companies/{id}/assets', { id: 42 }) === '/api/v1/companies/42/assets'
 */
export function buildPath(template: string, params: Record<string, PathSegment> = {}): string {
  const filled = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new PathBuildError(`Missing path parameter "${key}" for template "${template}"`);
    }
    return encodeSegment(value);
  });

  const remaining = /\{(\w+)\}/.exec(filled);
  if (remaining) {
    throw new PathBuildError(`Unresolved path parameter "${remaining[1]}" in "${template}"`);
  }

  return `${API_PREFIX}${filled.startsWith('/') ? filled : `/${filled}`}`;
}

/** A query value the Hudu API accepts. */
export type QueryValue = string | number | boolean | null | undefined | (string | number)[];

/**
 * Serialise a query object, dropping `undefined` and `null`.
 *
 * `false` is kept: several Hudu filters (`archived`, `draft`, `matched`) are
 * meaningfully false, and dropping it would silently widen the query.
 */
export function buildQuery(params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
      continue;
    }
    search.append(key, String(value));
  }
  const serialised = search.toString();
  return serialised === '' ? '' : `?${serialised}`;
}

/**
 * Narrow an arbitrary argument record to values the query serialiser accepts.
 *
 * Tool arguments arrive as `Record<string, unknown>` because the SDK has
 * already validated them against the Zod schema. Anything that is not a
 * scalar or an array of scalars by that point cannot be meaningfully placed in
 * a query string, so it is dropped rather than stringified into `[object
 * Object]` and sent to Hudu as a filter that silently matches nothing.
 */
export function toQuery(input: Record<string, unknown>): Record<string, QueryValue> {
  const output: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string' || typeof item === 'number')
    ) {
      output[key] = value;
    }
  }
  return output;
}

/** Join a normalised base URL with an API path and query string. */
export function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> = {},
): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}${buildQuery(query)}`;
}
