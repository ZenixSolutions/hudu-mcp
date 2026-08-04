/**
 * Response envelope handling.
 *
 * Hudu is not consistent about how it returns a collection. Most list endpoints
 * return a bare JSON array; a minority wrap it in a single-key object
 * (`/assets` returns `{ assets: [...] }`, `/matchers` returns `{ matchers: [...] }`,
 * `/procedures`, `/public_photos` and `/cards/lookup` likewise). The published
 * schema for `GET /asset_layouts` is a *single object* where the endpoint in
 * fact returns a list — a documentation defect, recorded in
 * docs/reference/hudu-api-v1.md.
 *
 * Rather than encode a per-endpoint rule that breaks the next time the vendor
 * changes one, `unwrapList` accepts every shape and normalises it. A hard
 * failure here would surface to the model as an unexplainable empty result.
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
    if (key !== undefined) {
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
 * resource name.
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
  if (key !== undefined && isRecord(data[key])) return data[key];
  return data;
}
