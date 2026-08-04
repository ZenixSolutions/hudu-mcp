/**
 * No tool result may carry a real credential.
 *
 * `GET /asset_passwords` returns the `Asset_Password` model, whose **required**
 * properties include `password` and `otp_secret`, and they are present on the
 * *list* response (docs/reference/spec-defects.md A1). One unfiltered call
 * therefore returns every stored credential and every TOTP seed the key can
 * see. Stripping is structural — it happens in `executeTool`, so a tool added
 * later inherits it (Invariant 3 in CLAUDE.md) — and this file is the check
 * that the structure holds.
 *
 * The assertions drive the real tools through `executeTool` against a fake
 * fetch returning a populated `Asset_Password`, and check the result with
 * `findSecretFields` rather than by eye.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { McpToolResponse } from '../../src/tools/define.js';
import { findSecretFields, WITHHELD, WITHHELD_DISABLED } from '../../src/security/secrets.js';
import {
  assetPasswordFixture,
  SECRET_OTP_VALUE,
  SECRET_PASSWORD_VALUE,
  testServer,
  toolText,
} from '../helpers/fixtures.js';

const LEAK_GUARD =
  'CREDENTIAL LEAK: a tool result carried a stored password or OTP seed. Stripping is ' +
  'structural in executeTool (CLAUDE.md Invariant 3) and only the tool declared with ' +
  'requiresPasswordReveal may bypass it.';

/** Assert a tool response carries no secret in any of the places a model reads. */
function expectNoSecrets(response: McpToolResponse): void {
  const text = toolText(response);
  expect(text, LEAK_GUARD).not.toContain(SECRET_PASSWORD_VALUE);
  expect(text, LEAK_GUARD).not.toContain(SECRET_OTP_VALUE);

  expect(findSecretFields(response.structuredContent), LEAK_GUARD).toEqual([]);
  expect(JSON.stringify(response), LEAK_GUARD).not.toContain(SECRET_PASSWORD_VALUE);
  expect(JSON.stringify(response), LEAK_GUARD).not.toContain(SECRET_OTP_VALUE);
}

describe('password tools withhold secrets by default', () => {
  it('hudu_list_passwords returns metadata without the secrets', async () => {
    const server = testServer({
      json: [assetPasswordFixture(1), assetPasswordFixture(2), assetPasswordFixture(3)],
    });

    const response = await server.call('hudu_list_passwords', {});

    expectNoSecrets(response);
    // The useful metadata survives — that is what makes the default tolerable.
    expect(toolText(response)).toContain('Firewall admin');
    expect(toolText(response)).toContain('admin');
    expect(toolText(response)).toContain(WITHHELD_DISABLED);
  });

  it('hudu_get_password returns metadata without the secrets', async () => {
    const server = testServer({ json: assetPasswordFixture(7) });

    const response = await server.call('hudu_get_password', { id: 7 });

    expectNoSecrets(response);
    expect(response.structuredContent?.['name']).toBe('Firewall admin');
  });

  it('hudu_create_password does not echo the secret it just stored', async () => {
    const server = testServer({ status: 201, json: assetPasswordFixture(9) });

    const response = await server.call('hudu_create_password', {
      name: 'Firewall admin',
      company_id: 3,
      password: SECRET_PASSWORD_VALUE,
    });

    expectNoSecrets(response);
  });

  it('hudu_update_password does not echo the secret back', async () => {
    const server = testServer({ json: assetPasswordFixture(9) });

    const response = await server.call('hudu_update_password', {
      id: 9,
      password: SECRET_PASSWORD_VALUE,
      confirm: true,
    });

    expectNoSecrets(response);
  });

  it('hudu_archive_password does not echo the secret back', async () => {
    const server = testServer({ json: assetPasswordFixture(9) });

    const response = await server.call('hudu_archive_password', {
      id: 9,
      archived: true,
      confirm: true,
    });

    expectNoSecrets(response);
  });

  // Regression: a handler renders Markdown from the raw record, before
  // stripSecrets runs on the structured data, so the rendered string is a
  // second path out of the server. `response_format: "markdown"` was an
  // ungated password reveal until the rendered text was scrubbed by value too.
  it('markdown rendering of a single record withholds the secrets', async () => {
    const server = testServer({ json: assetPasswordFixture(7) });

    const response = await server.call('hudu_get_password', { id: 7, response_format: 'markdown' });

    expectNoSecrets(response);
    expect(toolText(response)).toContain('Firewall admin');
    expect(toolText(response)).toContain(WITHHELD_DISABLED);
  });

  it('markdown rendering of a list withholds the secrets', async () => {
    const server = testServer({
      json: [assetPasswordFixture(1), assetPasswordFixture(2)],
    });

    const response = await server.call('hudu_list_passwords', { response_format: 'markdown' });

    expectNoSecrets(response);
  });

  it.each(['json', 'markdown'])(
    'withholds secrets in %s format even when reveal is enabled for the other tool',
    async (format) => {
      const server = testServer({ json: assetPasswordFixture(7) }, { allowPasswordReveal: true });

      expectNoSecrets(await server.call('hudu_get_password', { id: 7, response_format: format }));
    },
  );

  it('markdown rendering of an embedded password withholds it', async () => {
    const server = testServer({
      json: [{ id: 1, name: 'FW', passwords: [assetPasswordFixture()] }],
    });

    expectNoSecrets(await server.call('hudu_list_assets', { response_format: 'markdown' }));
  });

  it('a password nested inside an unrelated response is still stripped', async () => {
    // Hudu embeds password objects inside assets and companies in places the
    // schema does not document, which is why stripping walks the whole payload
    // rather than an endpoint-specific allowlist.
    const server = testServer({
      json: [{ id: 1, name: 'FW', passwords: [assetPasswordFixture()] }],
    });

    expectNoSecrets(await server.call('hudu_list_assets', {}));
  });

  it('placeholder text shows a value exists without disclosing it', async () => {
    const server = testServer({ json: assetPasswordFixture(7) });

    const response = await server.call('hudu_get_password', { id: 7 });

    expect(response.structuredContent?.['password']).toBe(WITHHELD_DISABLED);
    expect(response.structuredContent?.['otp_secret']).toBe(WITHHELD_DISABLED);
  });

  it('points at the reveal tool when reveal is enabled', async () => {
    const server = testServer({ json: assetPasswordFixture(7) }, { allowPasswordReveal: true });

    const response = await server.call('hudu_get_password', { id: 7 });

    expectNoSecrets(response);
    expect(response.structuredContent?.['password']).toBe(WITHHELD);
  });

  it('preserves a null password rather than implying a secret exists', async () => {
    const server = testServer({
      json: { ...assetPasswordFixture(7), password: null, otp_secret: null },
    });

    const response = await server.call('hudu_get_password', { id: 7 });

    expect(response.structuredContent?.['password']).toBeNull();
    expect(response.structuredContent?.['otp_secret']).toBeNull();
  });
});

describe('hudu_reveal_password registration', () => {
  it('is NOT registered when HUDU_ALLOW_PASSWORD_REVEAL is unset', () => {
    const server = testServer({ json: {} });

    expect(
      server.has('hudu_reveal_password'),
      'a tool the model cannot see is a tool it cannot be talked into calling',
    ).toBe(false);
    expect(server.built.withheld.map((entry) => entry.name)).toContain('hudu_reveal_password');
    expect(
      server.built.withheld.find((entry) => entry.name === 'hudu_reveal_password')?.reason,
    ).toContain('HUDU_ALLOW_PASSWORD_REVEAL');
  });

  it.each([
    { readOnly: false, allowDestructive: false },
    { readOnly: true, allowDestructive: false },
    { readOnly: false, allowDestructive: true },
  ])('stays unregistered under %j while the reveal flag is unset', (overrides) => {
    expect(testServer({ json: {} }, overrides).has('hudu_reveal_password')).toBe(false);
  });

  it('is registered when HUDU_ALLOW_PASSWORD_REVEAL is set', () => {
    expect(
      testServer({ json: {} }, { allowPasswordReveal: true }).has('hudu_reveal_password'),
    ).toBe(true);
  });

  it('stays available in read-only mode, because revealing is a Read', () => {
    const server = testServer({ json: {} }, { readOnly: true, allowPasswordReveal: true });
    expect(server.has('hudu_reveal_password')).toBe(true);
  });

  it('returns the secret when enabled and confirmed — that is its job', async () => {
    const server = testServer({ json: assetPasswordFixture(7) }, { allowPasswordReveal: true });

    const response = await server.call('hudu_reveal_password', { id: 7, confirm: true });

    expect(response.isError).toBeUndefined();
    expect(toolText(response)).toContain(SECRET_PASSWORD_VALUE);
    expect(toolText(response)).toContain(SECRET_OTP_VALUE);
    expect(findSecretFields(response.structuredContent)).toEqual(['$.password', '$.otp_secret']);
  });

  it('tells the model not to restate the value it just returned', async () => {
    const server = testServer({ json: assetPasswordFixture(7) }, { allowPasswordReveal: true });

    const text = toolText(await server.call('hudu_reveal_password', { id: 7, confirm: true }));

    expect(text).toContain('do not restate it anywhere else');
  });

  it('refuses without confirm: true', () => {
    // The reveal tool is classed Read, so its confirmation is not inherited
    // from the operation class — it is declared in the input schema, which the
    // MCP SDK validates before the handler is ever reached. Asserting it here
    // is asserting it at the layer that actually enforces it.
    const server = testServer({ json: assetPasswordFixture(7) }, { allowPasswordReveal: true });
    const schema = z.object(server.tool('hudu_reveal_password').inputSchema);

    expect(schema.safeParse({ id: 7 }).success, 'a reveal without confirm must not parse').toBe(
      false,
    );
    expect(schema.safeParse({ id: 7, confirm: false }).success).toBe(false);
    expect(schema.safeParse({ id: 7, confirm: 'true' }).success).toBe(false);
    expect(schema.safeParse({ id: 7, confirm: true }).success).toBe(true);
  });

  it('takes a single positive integer id, so there is no way to sweep the vault', () => {
    const server = testServer({ json: {} }, { allowPasswordReveal: true });
    const schema = z.object(server.tool('hudu_reveal_password').inputSchema);

    expect(schema.safeParse({ id: [1, 2, 3], confirm: true }).success).toBe(false);
    expect(schema.safeParse({ id: -1, confirm: true }).success).toBe(false);
    expect(schema.safeParse({ id: 0, confirm: true }).success).toBe(false);
  });

  it('says so plainly when the record stores no secret', async () => {
    const server = testServer(
      { json: { id: 7, name: 'No secret here', password: null } },
      { allowPasswordReveal: true },
    );

    const text = toolText(await server.call('hudu_reveal_password', { id: 7, confirm: true }));

    expect(text).toContain('stores no secret value');
  });

  it('has no bulk form — every reveal tool takes exactly one id', () => {
    const server = testServer({ json: {} }, { allowPasswordReveal: true });
    const revealing = server.built.tools.filter(
      (tool) => tool.definition.requiresPasswordReveal === true,
    );

    expect(revealing).toHaveLength(1);
    expect(revealing[0]!.name).toBe('hudu_reveal_password');
    expect(Object.keys(revealing[0]!.inputSchema)).toContain('id');
    expect(Object.keys(revealing[0]!.inputSchema)).not.toContain('ids');
  });
});
