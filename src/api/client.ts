/**
 * Typed HTTP client for the Hudu REST API.
 *
 * Responsibilities, and nothing else: authentication, URL construction, pacing,
 * retry, error translation, and redaction. It holds no knowledge of MCP, of
 * tools, or of how anything is presented — that separation is what
 * `standards/typescript-standard.md` requires and what makes the client
 * testable without a server.
 */

import type { Config } from '../config.js';
import { errorFromResponse, HuduApiError } from './errors.js';
import { buildUrl, type QueryValue } from './paths.js';
import {
  backoffDelayMs,
  type Clock,
  parseRetryAfter,
  Semaphore,
  systemClock,
  TokenBucket,
} from './rate-limit.js';
import { redactUrl, registerSecret } from './redact.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Record<string, QueryValue> | undefined;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

export interface HuduResponse<T> {
  readonly status: number;
  readonly data: T;
}

/** Injectable seams so tests never touch the network or the wall clock. */
export interface HuduClientDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: Clock;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Trim an upstream error body to something a model can read without drowning. */
function summariseErrorBody(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed.slice(0, 600);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['error', 'errors', 'message', 'error_description']) {
        const value = record[key];
        if (typeof value === 'string' && value !== '') return value.slice(0, 600);
        if (Array.isArray(value)) return value.map(String).join('; ').slice(0, 600);
      }
      return JSON.stringify(parsed).slice(0, 600);
    }
  } catch {
    // Hudu answers some failures with an HTML error page rather than JSON.
    // Strip tags so the useful sentence inside survives.
  }

  return trimmed
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

export class HuduClient {
  readonly #config: Config;
  readonly #fetch: typeof globalThis.fetch;
  readonly #clock: Clock;
  readonly #bucket: TokenBucket;
  readonly #semaphore: Semaphore;

  public constructor(config: Config, deps: HuduClientDeps = {}) {
    this.#config = config;
    this.#fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.#clock = deps.clock ?? systemClock;
    this.#bucket = new TokenBucket(config.rateLimitPerMinute, this.#clock);
    this.#semaphore = new Semaphore(config.maxConcurrency);

    // Register before any request can be built, so nothing can escape unscrubbed.
    registerSecret(config.apiKey);
  }

  public get baseUrl(): string {
    return this.#config.baseUrl;
  }

  /** Issue a request, retrying transient failures with full-jitter backoff. */
  public async request<T>(options: RequestOptions): Promise<HuduResponse<T>> {
    const url = buildUrl(this.#config.baseUrl, options.path, options.query ?? {});
    let lastError: HuduApiError | undefined;

    for (let attempt = 0; attempt <= this.#config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const wait = lastError?.retryAfterMs ?? backoffDelayMs(attempt - 1);
        await this.#clock.sleep(wait);
      }

      try {
        return await this.#attempt<T>(options, url);
      } catch (error) {
        if (!(error instanceof HuduApiError) || !error.retryable) throw error;
        lastError = error;
      }
    }

    /* c8 ignore next -- unreachable: the loop either returns or sets lastError */
    throw (
      lastError ??
      new HuduApiError('Request failed', {
        kind: 'network',
        guidance: 'Retry the call.',
      })
    );
  }

  async #attempt<T>(options: RequestOptions, url: string): Promise<HuduResponse<T>> {
    return this.#semaphore.run(async () => {
      await this.#bucket.acquire();

      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort();
      }, this.#config.requestTimeoutMs);
      timer.unref();

      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout.signal])
        : timeout.signal;

      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: options.method,
          headers: {
            // Hudu authenticates with a bare API key header, not a bearer token.
            'x-api-key': this.#config.apiKey,
            accept: 'application/json',
            'user-agent': this.#config.userAgent,
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal,
        });
      } catch (error) {
        throw this.#translateTransportError(error, options.method, url, timeout.signal.aborted);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const detail = summariseErrorBody(await response.text().catch(() => ''));
        throw errorFromResponse({
          status: response.status,
          statusText: response.statusText,
          method: options.method,
          url,
          detail,
          retryAfterMs: RETRYABLE_STATUS.has(response.status)
            ? parseRetryAfter(response.headers.get('retry-after'), this.#clock.now())
            : undefined,
        });
      }

      return { status: response.status, data: await this.#parseBody<T>(response, options, url) };
    });
  }

  async #parseBody<T>(response: Response, options: RequestOptions, url: string): Promise<T> {
    // 204 is documented on every Hudu delete; there is no body to parse.
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (text.trim() === '') return undefined as T;

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new HuduApiError('Hudu returned a response that is not valid JSON', {
        kind: 'protocol',
        status: response.status,
        method: options.method,
        url,
        detail: text.slice(0, 300),
        guidance:
          'This usually means the URL reached a login page or a proxy rather than the API. ' +
          'Confirm HUDU_BASE_URL points at the Hudu instance itself and not at an SSO ' +
          'gateway or reverse proxy that intercepts unauthenticated requests.',
        cause: error,
      });
    }
  }

  #translateTransportError(
    error: unknown,
    method: HttpMethod,
    url: string,
    timedOut: boolean,
  ): HuduApiError {
    if (timedOut) {
      return new HuduApiError(`Request timed out after ${this.#config.requestTimeoutMs}ms`, {
        kind: 'timeout',
        method,
        url,
        guidance:
          'Narrow the request — a smaller page_size or a tighter filter — or raise ' +
          'HUDU_REQUEST_TIMEOUT_MS if the instance is genuinely slow.',
        cause: error,
      });
    }

    if (error instanceof Error && error.name === 'AbortError') {
      return new HuduApiError('Request was cancelled', {
        kind: 'network',
        method,
        url,
        guidance: 'The caller aborted the request. Reissue it if the result is still wanted.',
        cause: error,
      });
    }

    return new HuduApiError(`Could not reach the Hudu instance at ${redactUrl(url)}`, {
      kind: 'network',
      method,
      url,
      guidance:
        'Check that HUDU_BASE_URL is correct and reachable from this machine, including DNS, ' +
        'TLS and any firewall or IP allowlist between here and the instance.',
      cause: error,
    });
  }

  public get<T>(path: string, query?: Record<string, QueryValue>): Promise<HuduResponse<T>> {
    return this.request<T>({ method: 'GET', path, query });
  }

  public post<T>(
    path: string,
    body?: unknown,
    query?: Record<string, QueryValue>,
  ): Promise<HuduResponse<T>> {
    return this.request<T>({ method: 'POST', path, body, query });
  }

  public put<T>(
    path: string,
    body?: unknown,
    query?: Record<string, QueryValue>,
  ): Promise<HuduResponse<T>> {
    return this.request<T>({ method: 'PUT', path, body, query });
  }

  public delete<T>(path: string, query?: Record<string, QueryValue>): Promise<HuduResponse<T>> {
    return this.request<T>({ method: 'DELETE', path, query });
  }
}
