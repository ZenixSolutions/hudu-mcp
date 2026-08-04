/**
 * Shared test fixtures.
 *
 * Nothing in this file touches the network, the clock, or the filesystem. Every
 * suite outside `tests/contract` builds its client and its server from here, so
 * a test that reaches the real world has to go out of its way to do it.
 */

import { HuduClient } from '../../src/api/client.js';
import type { Clock } from '../../src/api/rate-limit.js';
import type { Config } from '../../src/config.js';
import { buildServer, type BuiltServer } from '../../src/server.js';
import { executeTool, type McpToolResponse, type PreparedTool } from '../../src/tools/define.js';

/**
 * An obviously fake key.
 *
 * Long enough to clear the 8-character floor in `registerSecret`, so redaction
 * tests exercise the same path a real key would.
 */
export const TEST_API_KEY = 'test-key-0000000000';

/** RFC 2606 reserved TLD: this name cannot resolve, even by accident. */
export const TEST_BASE_URL = 'https://hudu.test.invalid';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: TEST_BASE_URL,
    apiKey: TEST_API_KEY,
    readOnly: false,
    allowDestructive: false,
    allowPasswordReveal: false,
    allowPasswordWrite: false,
    allowExports: false,
    requestTimeoutMs: 30_000,
    maxConcurrency: 4,
    rateLimitPerMinute: 300,
    maxRetries: 3,
    userAgent: 'hudu-mcp/0.0.0-test',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Fake clock                                                                  */
/* -------------------------------------------------------------------------- */

export interface FakeClock extends Clock {
  /** Every duration passed to `sleep`, in call order. */
  readonly slept: number[];
  /** Move the clock forward without sleeping. */
  advance(ms: number): void;
  /** Sum of every sleep so far. */
  totalSlept(): number;
}

/**
 * A clock whose `sleep` resolves immediately but still moves time forward.
 *
 * Retry and pacing behaviour is therefore observable — `slept` records what the
 * code asked to wait for — without any test spending that time.
 */
export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let current = start;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number) => {
      slept.push(ms);
      current += ms;
      return Promise.resolve();
    },
    slept,
    advance: (ms: number) => {
      current += ms;
    },
    totalSlept: () => slept.reduce((sum, ms) => sum + ms, 0),
  };
}

/* -------------------------------------------------------------------------- */
/* Fake fetch                                                                  */
/* -------------------------------------------------------------------------- */

export interface CannedResponse {
  readonly status?: number;
  /** Serialised as JSON with an `application/json` content type. */
  readonly json?: unknown;
  /** Sent verbatim. Wins over `json` when both are given. */
  readonly text?: string;
  readonly headers?: Record<string, string>;
  /** Thrown from `fetch` instead of returning, to model a transport failure. */
  readonly throws?: unknown;
}

export interface RecordedRequest {
  readonly url: string;
  readonly path: string;
  readonly search: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface FakeFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
  /** The most recent request. Throws if none was made. */
  last(): RecordedRequest;
}

/**
 * Build a `fetch` that records every call and replays canned responses in order.
 *
 * Once the script is exhausted the final entry repeats, so `[429, 200]` models
 * "fails once then succeeds" and `[500]` models "always fails" without the test
 * having to count retries in advance.
 */
export function fakeFetch(script: CannedResponse | readonly CannedResponse[]): FakeFetch {
  const responses = Array.isArray(script)
    ? (script as readonly CannedResponse[])
    : [script as CannedResponse];
  if (responses.length === 0) throw new Error('fakeFetch needs at least one canned response');

  const requests: RecordedRequest[] = [];
  let index = 0;

  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];

  const impl = (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(url);
    const headerBag = new Headers(init?.headers ?? {});
    const headers: Record<string, string> = {};
    for (const [name, value] of headerBag.entries()) headers[name] = value;

    requests.push({
      url,
      path: parsed.pathname,
      search: parsed.search,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const canned = responses[Math.min(index, responses.length - 1)]!;
    index += 1;

    if (canned.throws !== undefined) {
      // Deliberately not always an Error: `fetch` can reject with anything, and
      // the client has to survive that.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(canned.throws);
    }

    const status = canned.status ?? 200;
    const responseHeaders = new Headers(canned.headers ?? {});
    let body: string | null;
    if (canned.text !== undefined) {
      body = canned.text;
    } else if (canned.json !== undefined) {
      body = JSON.stringify(canned.json);
      if (!responseHeaders.has('content-type')) {
        responseHeaders.set('content-type', 'application/json');
      }
    } else {
      body = null;
    }

    // 204 and 205 are forbidden from carrying a body by the Response constructor.
    const nullBodyStatus = status === 204 || status === 205 || status === 304;
    return Promise.resolve(
      new Response(nullBodyStatus ? null : body, { status, headers: responseHeaders }),
    );
  };

  return {
    fetch: impl,
    requests,
    last: () => {
      const request = requests.at(-1);
      if (!request) throw new Error('no request was recorded');
      return request;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

export interface TestClient {
  readonly client: HuduClient;
  readonly config: Config;
  readonly http: FakeFetch;
  readonly clock: FakeClock;
}

export function testClient(
  script: CannedResponse | readonly CannedResponse[],
  overrides: Partial<Config> = {},
): TestClient {
  const config = testConfig(overrides);
  const http = fakeFetch(script);
  const clock = fakeClock();
  return { client: new HuduClient(config, { fetch: http.fetch, clock }), config, http, clock };
}

export interface TestServer extends TestClient {
  readonly built: BuiltServer;
  /** Find a registered tool by name, failing loudly when it is absent. */
  tool(name: string): PreparedTool;
  /** True when the named tool was registered under this configuration. */
  has(name: string): boolean;
  /** Run a registered tool end to end, exactly as the SDK callback would. */
  call(name: string, args?: Record<string, unknown>): Promise<McpToolResponse>;
}

export function testServer(
  script: CannedResponse | readonly CannedResponse[] = { json: [] },
  overrides: Partial<Config> = {},
): TestServer {
  const config = testConfig(overrides);
  const http = fakeFetch(script);
  const clock = fakeClock();
  const built = buildServer({ config, deps: { fetch: http.fetch, clock } });

  const tool = (name: string): PreparedTool => {
    const found = built.tools.find((candidate) => candidate.name === name);
    if (!found) {
      throw new Error(
        `Tool ${name} is not registered under this configuration. Registered: ${built.tools.length}, withheld: ${built.withheld.length}.`,
      );
    }
    return found;
  };

  return {
    client: built.client,
    config: built.config,
    http,
    clock,
    built,
    tool,
    has: (name: string) => built.tools.some((candidate) => candidate.name === name),
    call: (name: string, args: Record<string, unknown> = {}) =>
      executeTool(tool(name), args, { client: built.client, config: built.config }),
  };
}

/** Parse the text payload of a tool response back into a value. */
export function toolJson(response: McpToolResponse): unknown {
  const text = response.content[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The raw text of a tool response, which is what a model actually sees. */
export function toolText(response: McpToolResponse): string {
  return response.content.map((part) => part.text).join('\n');
}

/**
 * A populated `Asset_Password` as Hudu really returns it.
 *
 * `password` and `otp_secret` are `required` properties of that model and are
 * present on the *list* response, not only on a single fetch — see
 * docs/reference/spec-defects.md A1. The values here are the canaries the
 * security suite hunts for.
 */
export const SECRET_PASSWORD_VALUE = 'CanaryPassw0rd-DO-NOT-LEAK';
export const SECRET_OTP_VALUE = 'CANARYOTPSEED2345';

export function assetPasswordFixture(id = 7): Record<string, unknown> {
  return {
    id,
    company_id: 3,
    name: 'Firewall admin',
    username: 'admin',
    password: SECRET_PASSWORD_VALUE,
    otp_secret: SECRET_OTP_VALUE,
    url: 'https://fw.example.com',
    password_folder_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
  };
}
