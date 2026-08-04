/**
 * The HTTP client against an injected `fetch`.
 *
 * No test in this file touches the network or the wall clock: `testClient`
 * supplies both. What is under test is the behaviour a live instance would
 * produce — authentication, error translation, retry, and the two response
 * shapes Hudu actually returns for a delete.
 */

import { describe, expect, it } from 'vitest';

import { HuduApiError } from '../../src/api/errors.js';
import { buildPath } from '../../src/api/paths.js';
import { TEST_API_KEY, testClient } from '../helpers/fixtures.js';

describe('authentication', () => {
  it('sends the API key in x-api-key', async () => {
    const { client, http } = testClient({ json: [] });
    await client.get('/api/v1/companies');

    expect(http.last().headers['x-api-key']).toBe(TEST_API_KEY);
  });

  it('never sends an authorization header — Hudu uses a bare key, not a bearer token', async () => {
    const { client, http } = testClient({ json: [] });
    await client.get('/api/v1/companies');

    const headers = http.last().headers;
    expect(headers['authorization']).toBeUndefined();
    expect(headers['proxy-authorization']).toBeUndefined();
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization');
  });

  it('never puts the key in the URL', async () => {
    const { client, http } = testClient({ json: [] });
    await client.get('/api/v1/companies', { page: 1 });

    expect(http.last().url).not.toContain(TEST_API_KEY);
  });

  it('identifies itself and asks for JSON', async () => {
    const { client, http } = testClient({ json: [] });
    await client.get('/api/v1/companies');

    expect(http.last().headers['accept']).toBe('application/json');
    expect(http.last().headers['user-agent']).toContain('hudu-mcp/');
  });

  it('sets a JSON content type only when there is a body', async () => {
    const { client, http } = testClient([{ json: {} }, { json: {} }]);

    await client.get('/api/v1/companies');
    expect(http.requests[0]!.headers['content-type']).toBeUndefined();

    await client.post('/api/v1/companies', { company: { name: 'Acme' } });
    expect(http.requests[1]!.headers['content-type']).toBe('application/json');
    expect(http.requests[1]!.body).toBe('{"company":{"name":"Acme"}}');
  });
});

describe('request construction', () => {
  it('builds the full URL from base, path and query', async () => {
    const { client, http } = testClient({ json: [] });
    await client.get(buildPath('/companies'), { page: 2, page_size: 25, archived: false });

    expect(http.last().url).toBe(
      'https://hudu.test.invalid/api/v1/companies?page=2&page_size=25&archived=false',
    );
  });

  it('uses the verb it was asked for', async () => {
    const { client, http } = testClient([
      { json: {} },
      { json: {} },
      { json: {} },
      { status: 204 },
    ]);

    await client.get('/api/v1/x');
    await client.post('/api/v1/x', {});
    await client.put('/api/v1/x', {});
    await client.delete('/api/v1/x');

    expect(http.requests.map((request) => request.method)).toEqual([
      'GET',
      'POST',
      'PUT',
      'DELETE',
    ]);
  });
});

describe('error translation', () => {
  const cases = [
    { status: 401, kind: 'auth', guidanceContains: 'HUDU_API_KEY' },
    { status: 403, kind: 'permission', guidanceContains: 'scope' },
    { status: 404, kind: 'not_found', guidanceContains: 'No such record' },
    { status: 422, kind: 'validation', guidanceContains: 'invalid' },
    { status: 429, kind: 'rate_limit', guidanceContains: '300 requests per minute' },
    { status: 500, kind: 'server', guidanceContains: 'server error' },
  ] as const;

  it.each(cases)(
    'turns $status into a HuduApiError of kind $kind with usable guidance',
    async ({ status, kind, guidanceContains }) => {
      const { client } = testClient(
        { status, json: { error: 'upstream said no' } },
        {
          maxRetries: 1,
        },
      );

      const error = await client.get('/api/v1/companies').catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HuduApiError);
      const apiError = error as HuduApiError;
      expect(apiError.kind).toBe(kind);
      expect(apiError.status).toBe(status);
      expect(
        apiError.guidance.length,
        'guidance must tell the model what to do next',
      ).toBeGreaterThan(0);
      expect(apiError.guidance).toContain(guidanceContains);
      expect(apiError.detail).toBe('upstream said no');
      expect(apiError.toAgentMessage()).toContain('What to do:');
    },
  );

  it('gives guidance for an undocumented status too', async () => {
    const { client } = testClient({ status: 418, text: 'teapot' });
    const error = (await client
      .get('/api/v1/x')
      .catch((caught: unknown) => caught)) as HuduApiError;

    expect(error.kind).toBe('protocol');
    expect(error.guidance).not.toBe('');
  });

  it('summarises an errors array from the body', async () => {
    const { client } = testClient({
      status: 422,
      json: { errors: ['name is required', 'bad id'] },
    });
    const error = (await client
      .get('/api/v1/x')
      .catch((caught: unknown) => caught)) as HuduApiError;

    expect(error.detail).toBe('name is required; bad id');
  });

  it('strips tags from an HTML error body rather than dumping markup', async () => {
    const { client } = testClient({
      status: 404,
      text: '<html><body><h1>Page not found</h1></body></html>',
      headers: { 'content-type': 'text/html' },
    });
    const error = (await client
      .get('/api/v1/x')
      .catch((caught: unknown) => caught)) as HuduApiError;

    expect(error.detail).toBe('Page not found');
    expect(error.detail).not.toContain('<');
  });

  it('redacts the API key out of the reported URL', async () => {
    const { client } = testClient({ status: 404, json: {} });
    const error = (await client
      .get('/api/v1/x', { api_key: TEST_API_KEY })
      .catch((caught: unknown) => caught)) as HuduApiError;

    expect(error.url).not.toContain(TEST_API_KEY);
    expect(error.toAgentMessage()).not.toContain(TEST_API_KEY);
  });
});

describe('retry', () => {
  it('retries a 429 and succeeds on the follow-up', async () => {
    const { client, http } = testClient([
      { status: 429, json: { error: 'slow down' } },
      { json: [{ id: 1 }] },
    ]);

    const response = await client.get<{ id: number }[]>('/api/v1/companies');

    expect(response.data).toEqual([{ id: 1 }]);
    expect(http.requests).toHaveLength(2);
  });

  it('retries a 500 and succeeds on the follow-up', async () => {
    const { client, http } = testClient([{ status: 500, text: 'boom' }, { json: [] }]);

    await client.get('/api/v1/companies');

    expect(http.requests).toHaveLength(2);
  });

  it('gives up after maxRetries and reports the last error', async () => {
    const { client, http } = testClient({ status: 500, text: 'boom' }, { maxRetries: 2 });

    const error = (await client
      .get('/api/v1/companies')
      .catch((caught: unknown) => caught)) as HuduApiError;

    expect(http.requests).toHaveLength(3); // initial attempt + 2 retries
    expect(error.kind).toBe('server');
  });

  it('does not retry a 404 — the record will not appear on a second try', async () => {
    const { client, http } = testClient({ status: 404, json: {} }, { maxRetries: 3 });

    await client.get('/api/v1/companies/9999').catch(() => undefined);

    expect(http.requests, 'a 404 is not transient and must not be retried').toHaveLength(1);
  });

  it.each([401, 403, 422])('does not retry a %i', async (status) => {
    const { client, http } = testClient({ status, json: {} }, { maxRetries: 3 });
    await client.get('/api/v1/x').catch(() => undefined);
    expect(http.requests).toHaveLength(1);
  });

  it('honours Retry-After given in seconds', async () => {
    const { client, clock } = testClient([
      { status: 429, headers: { 'retry-after': '7' }, json: {} },
      { json: [] },
    ]);

    await client.get('/api/v1/companies');

    expect(clock.slept, 'the server-supplied delay must win over local backoff').toContain(7000);
  });

  it('honours Retry-After given as an HTTP date', async () => {
    const { client, clock } = testClient([
      {
        status: 503,
        headers: { 'retry-after': new Date(Date.now() + 3000).toUTCString() },
        json: {},
      },
      { json: [] },
    ]);

    await client.get('/api/v1/companies');

    expect(clock.slept.some((ms) => ms > 0)).toBe(true);
  });

  it('falls back to jittered backoff when no Retry-After is given', async () => {
    const { client, clock } = testClient([{ status: 500, text: 'boom' }, { json: [] }]);

    await client.get('/api/v1/companies');

    expect(clock.slept).toHaveLength(1);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(0);
  });

  it('retries a transport failure and reports it as a network error if it persists', async () => {
    const { client, http } = testClient(
      { throws: new TypeError('fetch failed') },
      {
        maxRetries: 1,
      },
    );

    const error = (await client
      .get('/api/v1/companies')
      .catch((caught: unknown) => caught)) as HuduApiError;

    expect(http.requests).toHaveLength(2);
    expect(error.kind).toBe('network');
    expect(error.guidance).toContain('HUDU_BASE_URL');
  });
});

describe('response parsing', () => {
  it('treats a 204 with no body as success', async () => {
    const { client } = testClient({ status: 204 });

    const response = await client.delete('/api/v1/companies/1');

    expect(response.status).toBe(204);
    expect(response.data).toBeUndefined();
  });

  it('treats an empty 200 body as success', async () => {
    const { client } = testClient({ status: 200, text: '' });

    const response = await client.get('/api/v1/x');

    expect(response.status).toBe(200);
    expect(response.data).toBeUndefined();
  });

  it('treats DELETE /networks/{id} answering 200 with a message as success (defect B8)', async () => {
    // Every other delete in the API answers 204; this one answers 200 with a
    // JSON body. Both are success — see docs/reference/spec-defects.md B8.
    const { client } = testClient({
      status: 200,
      json: { message: 'Network deleted successfully' },
    });

    const response = await client.delete<{ message: string }>('/api/v1/networks/1');

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ message: 'Network deleted successfully' });
  });

  it('parses a JSON array body', async () => {
    const { client } = testClient({ json: [{ id: 1 }, { id: 2 }] });
    const response = await client.get<{ id: number }[]>('/api/v1/companies');
    expect(response.data).toHaveLength(2);
  });

  it('reports an HTML login page as a protocol error naming the SSO/proxy cause', async () => {
    const { client } = testClient({
      status: 200,
      text: '<!DOCTYPE html><html><head><title>Sign in</title></head><body>Login</body></html>',
      headers: { 'content-type': 'text/html' },
    });

    const error = (await client.get('/api/v1/companies').catch((caught: unknown) => caught)) as
      HuduApiError | SyntaxError;

    expect(error, 'a login page must not surface as a raw JSON parse crash').toBeInstanceOf(
      HuduApiError,
    );
    const apiError = error as HuduApiError;
    expect(apiError.kind).toBe('protocol');
    expect(apiError.guidance).toContain('login page');
    expect(apiError.guidance).toContain('SSO');
    expect(apiError.guidance).toContain('proxy');
    expect(apiError.guidance).toContain('HUDU_BASE_URL');
    expect(apiError.detail).toContain('<!DOCTYPE html>');
  });

  it('does not retry a protocol error, which a second request would only repeat', async () => {
    const { client, http } = testClient(
      { status: 200, text: '<html>login</html>' },
      {
        maxRetries: 3,
      },
    );

    await client.get('/api/v1/companies').catch(() => undefined);

    expect(http.requests).toHaveLength(1);
  });
});

describe('pacing', () => {
  it('bounds concurrency with the configured semaphore', async () => {
    const { client } = testClient({ json: [] }, { maxConcurrency: 2 });
    await Promise.all([client.get('/api/v1/a'), client.get('/api/v1/b'), client.get('/api/v1/c')]);
    // Reaching here without hanging is the assertion: a leaked slot deadlocks.
    expect(true).toBe(true);
  });

  it('paces requests once the token bucket is empty', async () => {
    const { client, clock } = testClient({ json: [] }, { rateLimitPerMinute: 60 });

    for (let index = 0; index < 60; index += 1) await client.get('/api/v1/x');
    expect(clock.slept).toEqual([]);

    await client.get('/api/v1/x');
    expect(clock.slept).toEqual([1000]);
  });
});
