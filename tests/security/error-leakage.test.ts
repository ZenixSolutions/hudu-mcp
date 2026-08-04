/**
 * Nothing that fails may carry the API key out with it.
 *
 * Constitution Article VIII: secrets must never be logged, echoed or exposed in
 * errors. A stringified error is the most common way a token reaches a log
 * file, and a tool result is a log file as far as an agent transcript is
 * concerned. Every case here is constructed deliberately — the key is planted
 * in the message, in the stack, and in a nested `cause` — because a leak that
 * only happens in production is a leak that no test would otherwise catch.
 */

import { describe, expect, it } from 'vitest';

import { HuduApiError } from '../../src/api/errors.js';
import { REDACTED } from '../../src/api/redact.js';
import { OperationClass } from '../../src/security/classification.js';
import {
  defineTool,
  executeTool,
  type McpToolResponse,
  prepareTool,
  toAgentError,
} from '../../src/tools/define.js';
import { TEST_API_KEY, testServer, toolText } from '../helpers/fixtures.js';

const KEY_LEAK_GUARD =
  'API KEY LEAK: the configured Hudu API key reached a tool result. Article VIII forbids a ' +
  'secret appearing in an error, and a tool result is what the agent transcript records.';

/** A tool that throws whatever the test hands it, so the failure path is exercised for real. */
function throwingServer(thrown: unknown): { run: () => Promise<McpToolResponse> } {
  const server = testServer({ json: {} });
  const prepared = prepareTool(
    defineTool({
      name: 'hudu_test_thrower',
      title: 'Throwing Test Tool',
      description: 'Throws a constructed error so the error path can be inspected.',
      inputSchema: {},
      operationClass: OperationClass.Read,
      // A handler may reject with anything, not only an Error, and the error
      // boundary has to hold either way.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      handler: () => Promise.reject(thrown),
    }),
  );

  return {
    run: () => executeTool(prepared, {}, { client: server.client, config: server.config }),
  };
}

describe('a thrown error cannot carry the API key to a tool result', () => {
  it('when the key is in the message', async () => {
    const response = await throwingServer(
      new Error(`connection to instance failed using key ${TEST_API_KEY}`),
    ).run();

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(response.isError).toBe(true);
  });

  it('when the key is in the stack', async () => {
    const error = new Error('nothing interesting in the message');
    error.stack = `Error: nothing interesting\n    at request (/app/client.js:1:1) key=${TEST_API_KEY}`;

    const response = await throwingServer(error).run();

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });

  it('when the key is in a nested cause', async () => {
    const root = new Error(`socket write failed: x-api-key: ${TEST_API_KEY}`);
    const middle = new Error('upstream failure', { cause: root });
    const top = new Error('request failed', { cause: middle });

    const response = await throwingServer(top).run();

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });

  it('when the key is in all three at once', async () => {
    const root = new Error(`root ${TEST_API_KEY}`);
    root.stack = `Error: root ${TEST_API_KEY}\n    at x (${TEST_API_KEY})`;
    const top = new Error(`top ${TEST_API_KEY}`, { cause: root });
    top.stack = `Error: top ${TEST_API_KEY}\n    at y (${TEST_API_KEY})`;

    const response = await throwingServer(top).run();

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });

  it('when a non-Error value carrying the key is thrown', async () => {
    const response = await throwingServer(`plain string holding ${TEST_API_KEY}`).run();

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });

  it('when an object with a toString carrying the key is thrown', async () => {
    const response = await throwingServer({
      toString: () => `object holding ${TEST_API_KEY}`,
    }).run();

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });

  it('still says something actionable rather than swallowing the failure', async () => {
    const response = await throwingServer(new Error(`boom ${TEST_API_KEY}`)).run();

    const text = toolText(response);
    expect(text).toContain('What to do:');
    expect(text).toContain('hudu-mcp/issues');
    expect(text).toContain(REDACTED);
  });
});

describe('toAgentError', () => {
  it('scrubs a registered secret from an arbitrary error', () => {
    // The client registers the key at construction; build one so the registry
    // is populated the way it is in a running server.
    testServer({ json: {} });
    expect(toAgentError(new Error(`leak ${TEST_API_KEY}`)), KEY_LEAK_GUARD).not.toContain(
      TEST_API_KEY,
    );
  });

  it('passes a HuduApiError through with its guidance', () => {
    const error = new HuduApiError('failed', {
      kind: 'validation',
      guidance: 'fix the field',
      status: 422,
    });
    expect(toAgentError(error)).toContain('What to do: fix the field');
  });

  it('renders a Zod error as per-field advice', async () => {
    const { z } = await import('zod');
    const parsed = z.object({ id: z.number() }).safeParse({ id: 'x' });
    expect(parsed.success).toBe(false);

    const message = toAgentError(parsed.error);
    expect(message).toContain('did not match this tool');
    expect(message).toContain('id');
    expect(message).toContain('call the tool again');
  });
});

describe('HuduApiError construction', () => {
  it('redacts the key out of the URL it was given', () => {
    testServer({ json: {} });
    const error = new HuduApiError('failed', {
      kind: 'auth',
      guidance: 'check the key',
      url: `https://hudu.test.invalid/api/v1/companies?api_key=${TEST_API_KEY}`,
      method: 'GET',
    });

    expect(error.url, KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(error.toAgentMessage(), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });

  it('scrubs the key out of the message and the detail', () => {
    testServer({ json: {} });
    const error = new HuduApiError(`failed with ${TEST_API_KEY}`, {
      kind: 'auth',
      guidance: 'check the key',
      detail: `upstream echoed ${TEST_API_KEY}`,
    });

    expect(error.message, KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(error.detail, KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });
});

describe('an upstream response echoing the key', () => {
  it('does not reach the tool result through the error detail', async () => {
    const server = testServer({
      status: 401,
      json: { error: `Invalid API key: ${TEST_API_KEY}` },
    });

    const response = await server.call('hudu_get_api_info', {});

    expect(response.isError).toBe(true);
    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
    expect(toolText(response)).toContain(REDACTED);
  });

  it('does not reach the tool result through a protocol error body', async () => {
    const server = testServer({
      status: 200,
      text: `<html><body>Login required for ${TEST_API_KEY}</body></html>`,
    });

    const response = await server.call('hudu_get_api_info', {});

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });

  it('does not reach the tool result through a transport failure message', async () => {
    const server = testServer(
      { throws: new TypeError(`fetch failed for key ${TEST_API_KEY}`) },
      { maxRetries: 0 },
    );

    const response = await server.call('hudu_get_api_info', {});

    expect(toolText(response), KEY_LEAK_GUARD).not.toContain(TEST_API_KEY);
  });
});
