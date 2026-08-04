/**
 * Explicit error types for the Hudu API layer.
 *
 * Every error carries an agent-facing `guidance` string. An error message that
 * only states what failed makes a model retry the same call; one that states
 * what to do next lets it recover. Article X treats that guidance as part of
 * the interface contract.
 */

import { redactUrl, scrubSecrets } from './redact.js';

export type HuduErrorKind =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'validation'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'protocol';

export interface HuduErrorOptions {
  readonly kind: HuduErrorKind;
  readonly status?: number | undefined;
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly guidance: string;
  readonly detail?: string | undefined;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown;
}

/**
 * An error from the Hudu API or the transport beneath it.
 *
 * Construction redacts the URL and detail. Nothing that reaches this class can
 * carry key material out to a log or a tool response.
 */
export class HuduApiError extends Error {
  public override readonly name = 'HuduApiError';
  public readonly kind: HuduErrorKind;
  public readonly status: number | undefined;
  public readonly method: string | undefined;
  public readonly url: string | undefined;
  public readonly guidance: string;
  public readonly detail: string | undefined;
  public readonly retryAfterMs: number | undefined;

  public constructor(message: string, options: HuduErrorOptions) {
    super(
      scrubSecrets(message),
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.kind = options.kind;
    this.status = options.status;
    this.method = options.method;
    this.url = options.url === undefined ? undefined : redactUrl(options.url);
    this.guidance = options.guidance;
    this.detail = options.detail === undefined ? undefined : scrubSecrets(options.detail);
    this.retryAfterMs = options.retryAfterMs;
  }

  /** True when a retry could plausibly succeed without the caller changing anything. */
  public get retryable(): boolean {
    return (
      this.kind === 'rate_limit' ||
      this.kind === 'server' ||
      this.kind === 'network' ||
      this.kind === 'timeout'
    );
  }

  /** A single, agent-readable line: what went wrong and what to do about it. */
  public toAgentMessage(): string {
    const where = this.method && this.url ? ` (${this.method} ${this.url})` : '';
    const status = this.status === undefined ? '' : ` [HTTP ${this.status}]`;
    const detail = this.detail ? `\nAPI said: ${this.detail}` : '';
    return `${this.message}${status}${where}${detail}\nWhat to do: ${this.guidance}`;
  }
}

/** Raised when a tool is called but its capability gate is not open. */
export class CapabilityDisabledError extends Error {
  public override readonly name = 'CapabilityDisabledError';
  public readonly guidance: string;

  public constructor(message: string, guidance: string) {
    super(message);
    this.guidance = guidance;
  }

  public toAgentMessage(): string {
    return `${this.message}\nWhat to do: ${this.guidance}`;
  }
}

const GUIDANCE: Record<number, string> = {
  400: 'The request was malformed. Check parameter names and types against the tool schema.',
  401:
    'Rejected by Hudu as unauthorised. There are two distinct causes and they look identical. ' +
    '(1) The key lacks the SCOPE for this endpoint. Hudu keys are scoped at creation for ' +
    'password access, destructive actions and exports, and a key without password access ' +
    'answers 401 — not 403 — on /asset_passwords and /password_folders (observed on Hudu ' +
    '2.34.2). If other endpoints work and only one family fails, this is the cause, and the ' +
    'scope cannot be widened afterwards: a new key is required. (2) The key itself is wrong, ' +
    'expired or revoked, or the calling IP is outside the allowlist set on it — in which case ' +
    'every endpoint fails, including /api_info. Check HUDU_API_KEY against Hudu Admin -> Basic ' +
    'Information -> API Keys. Either way this is a server configuration problem and cannot be ' +
    'fixed by changing tool arguments.',
  403:
    'The API key lacks the scope for this operation. Hudu keys are scoped at creation for ' +
    'password access, destructive actions, exports, IP whitelist and company scope, and those ' +
    'options cannot be changed afterwards — a new key is required. Note that no 403 was ' +
    'observed on Hudu 2.34.2, where a scope failure answers 401 instead; this branch is kept ' +
    'for other Hudu versions and is unconfirmed on any instance.',
  404:
    'No such record, or the API key is scoped to a company that does not contain it, or the ' +
    'endpoint does not exist on this Hudu version — Hudu answers 404 for all three. The body ' +
    'usually tells them apart: a missing record names its resource ("Network not found"), ' +
    'while an unrouted path answers a generic {"status":404,"error":"Not Found"} (observed on ' +
    'Hudu 2.34.2). Read the API detail above before assuming the record is gone, and note that ' +
    'some endpoints report a missing record as 200 with an empty body instead of as a 404 at ' +
    'all, so a 404 here does not rule the id out everywhere.',
  422:
    'Hudu rejected the payload as invalid. Read the API detail above — it usually names the ' +
    'offending field — then correct that field and retry.',
  429:
    'Rate limited. Hudu documents 300 requests per minute per instance. The client backs off ' +
    'automatically; if this persists, lower HUDU_RATE_LIMIT_PER_MINUTE or make fewer, larger ' +
    'requests.',
};

const kindForStatus = (status: number): HuduErrorKind => {
  // 401 stays `auth` even though it is also how Hudu 2.34.2 reports a key-scope
  // failure (spec-defects.md A7, F5). The two are indistinguishable from the
  // response, so the classification names the commoner cause and the guidance
  // above names both; guessing `permission` here would be no more accurate and
  // would make a genuinely bad key read as a scope problem.
  if (status === 401) return 'auth';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'protocol';
};

/** Build a {@link HuduApiError} from an HTTP response. */
export function errorFromResponse(args: {
  status: number;
  statusText: string;
  method: string;
  url: string;
  detail?: string | undefined;
  retryAfterMs?: number | undefined;
}): HuduApiError {
  const { status, statusText, method, url, detail, retryAfterMs } = args;
  const guidance =
    GUIDANCE[status] ??
    (status >= 500
      ? 'Hudu returned a server error. This is upstream, not a problem with the request; retry ' +
        'shortly. If it repeats for the same call, report it to Hudu support with the path.'
      : `Unexpected HTTP ${status}. Check the Hudu instance status and the request parameters.`);

  return new HuduApiError(`Hudu API request failed: ${statusText || `HTTP ${status}`}`, {
    kind: kindForStatus(status),
    status,
    method,
    url,
    guidance,
    detail,
    retryAfterMs,
  });
}
