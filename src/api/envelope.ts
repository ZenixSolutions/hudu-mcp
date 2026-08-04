/**
 * Response envelope handling.
 *
 * Hudu is not consistent about how it returns a collection. Some list endpoints
 * return a bare JSON array; ten of them wrap it in a single-key object. The ten
 * were measured against Hudu 2.34.2 and are recorded in
 * docs/reference/spec-defects.md F1 — `/companies`, `/asset_layouts`,
 * `/articles`, `/folders`, `/relations`, `/users`, `/assets`,
 * `/companies/{company_id}/assets`, `/procedures` and `/public_photos`, plus
 * `/matchers` and `/cards/lookup`. The captured contract documents none of
 * those envelopes, so observation is the only source for them and each one is
 * declared as a `listKey` on the owning `ResourceSpec`.
 *
 * Rather than encode a per-endpoint rule that breaks the next time the vendor
 * changes one, `unwrapList` accepts every shape and normalises it. A hard
 * failure here would surface to the model as an unexplainable empty result.
 * The declared key is preferred, but its *absence* from the body falls through
 * to the same tolerant handling as an undeclared one: an endpoint that stops
 * wrapping must not read as "there are none of these".
 */

import { HuduApiError } from './errors.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Normalise a list response into an array.
 *
 * @param data     the parsed response body
 * @param key      the documented envelope key, when the endpoint uses one
 * @param context  endpoint description, used only in the error path
 */
export function unwrapList<T>(data: unknown, key: string | undefined, context: string): T[] {
  if (data === undefined || data === null) return [];
  if (Array.isArray(data)) return data as T[];

  if (isRecord(data)) {
    // `key in data` rather than a truthiness check: a declared key that is
    // simply not on the body means the envelope has changed or was never
    // there, and that case belongs to the fallbacks below. Only a key that is
    // present and empty is genuinely an empty collection.
    if (key !== undefined && key in data) {
      const wrapped = data[key];
      if (Array.isArray(wrapped)) return wrapped as T[];
      if (wrapped === undefined || wrapped === null) return [];
    }

    // The documented key is absent. Fall back to the only array-valued property,
    // which covers a renamed envelope without inventing data. More than one
    // candidate is genuinely ambiguous and must not be guessed at.
    const arrays = Object.entries(data).filter(([, value]) => Array.isArray(value));
    const only = arrays.length === 1 ? arrays[0] : undefined;
    if (only) return only[1] as T[];

    // A single object where a list was expected: Hudu does this on
    // `GET /asset_layouts`. One record is a legitimate result, not an error.
    if ('id' in data) return [data as T];

    if (arrays.length === 0) return [];
  }

  throw new HuduApiError(`Could not interpret the list response from ${context}`, {
    kind: 'protocol',
    guidance:
      'The Hudu instance returned a shape this client does not recognise, which usually means ' +
      'a Hudu version newer than this server supports. Please open an issue at ' +
      'https://github.com/ZenixSolutions/hudu-mcp/issues naming the endpoint and your Hudu ' +
      'version (hudu_get_api_info reports it).',
  });
}

/**
 * Normalise a single-record response.
 *
 * Some endpoints return the record bare, others wrap it under the singular
 * resource name. Seven wrappers were measured on Hudu 2.34.2 and are recorded
 * in docs/reference/spec-defects.md F2; the captured contract documents none of
 * them, so a tool that omits its `recordKey` hands the *wrapper* back to the
 * model — `{"company": {...}}` where a company was asked for.
 *
 * A declared key that is present but null means the endpoint answered "no such
 * record" inside a 200 (F3), and is reported as absent rather than as the
 * wrapper object.
 *
 * Returns an open record rather than a caller-chosen generic. Hudu's record
 * shapes vary by instance version and, for assets, by layout, so a generic here
 * would be an unchecked assertion dressed up as a type — the honest return is
 * "some object", which the presentation layer already handles.
 */
export function unwrapRecord(
  data: unknown,
  key: string | undefined,
): Record<string, unknown> | undefined {
  if (data === undefined || data === null) return undefined;
  if (!isRecord(data)) return undefined;
  if (key !== undefined && key in data) {
    const wrapped = data[key];
    return isRecord(wrapped) ? wrapped : undefined;
  }
  // The declared key is absent: the body is the record itself, which is what an
  // unwrapped endpoint returns and what a renamed envelope degrades to.
  return data;
}
