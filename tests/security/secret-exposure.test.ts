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

import {
  defineTool,
  executeTool,
  type McpToolResponse,
  prepareTool,
} from '../../src/tools/define.js';
import { OperationClass } from '../../src/security/classification.js';
import {
  findSecretFields,
  REDACTED_TEXT,
  REDACTION_NOTE,
  REDACTION_NOTE_REVEAL_DISABLED,
  SECRET_FIELDS,
} from '../../src/security/secrets.js';
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

const SHAPE_GUARD =
  'A field named `password` or `otp_secret` holds a string. Even a redaction notice is ' +
  'forbidden there: a downstream model that trusts the field name pastes whatever it finds ' +
  'into a ticket, and a 54-character placeholder is indistinguishable from a credential ' +
  'without counting distinct values across records.';

/** Every `password`/`otp_secret` in a payload, wherever it is nested. */
function secretFieldValues(value: unknown, found: unknown[] = []): unknown[] {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) secretFieldValues(item, found);
    return found;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((SECRET_FIELDS as readonly string[]).includes(key)) found.push(item);
    else secretFieldValues(item, found);
  }
  return found;
}

/** Assert a tool response carries no secret in any of the places a model reads. */
function expectNoSecrets(response: McpToolResponse): void {
  const text = toolText(response);
  expect(text, LEAK_GUARD).not.toContain(SECRET_PASSWORD_VALUE);
  expect(text, LEAK_GUARD).not.toContain(SECRET_OTP_VALUE);

  expect(findSecretFields(response.structuredContent), LEAK_GUARD).toEqual([]);
  expect(JSON.stringify(response), LEAK_GUARD).not.toContain(SECRET_PASSWORD_VALUE);
  expect(JSON.stringify(response), LEAK_GUARD).not.toContain(SECRET_OTP_VALUE);

  // Structural, not value-based: whatever the payload is, a secret field is
  // never a string. `findSecretFields` says the same thing, but this states the
  // rule the reviewer's finding actually turned on.
  for (const value of secretFieldValues(response.structuredContent)) {
    // An empty string is passed through untouched, because it was never a
    // secret; anything else that is a string got there by leaking.
    if (value === '') continue;
    expect(typeof value, SHAPE_GUARD).not.toBe('string');
  }
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
    // The explanation is in the notice, where it cannot be read as a value.
    expect(toolText(response)).toContain(REDACTION_NOTE_REVEAL_DISABLED);
  });

  it('hudu_get_password returns metadata without the secrets', async () => {
    const server = testServer({ json: assetPasswordFixture(7) });

    const response = await server.call('hudu_get_password', { id: 7 });

    expectNoSecrets(response);
    expect(response.structuredContent?.['name']).toBe('Firewall admin');
  });

  it('hudu_create_password does not echo the secret it just stored', async () => {
    // The write gate is open here only so the tool exists to be tested; what is
    // under test is that the response carries no secret back.
    const server = testServer(
      { status: 201, json: assetPasswordFixture(9) },
      { allowPasswordWrite: true },
    );

    const response = await server.call('hudu_create_password', {
      name: 'Firewall admin',
      company_id: 3,
      password: SECRET_PASSWORD_VALUE,
    });

    expectNoSecrets(response);
  });

  it('hudu_update_password does not echo the secret back', async () => {
    const server = testServer({ json: assetPasswordFixture(9) }, { allowPasswordWrite: true });

    const response = await server.call('hudu_update_password', {
      id: 9,
      password: SECRET_PASSWORD_VALUE,
      confirm: true,
    });

    expectNoSecrets(response);
  });

  it('hudu_archive_password does not echo the secret back', async () => {
    const server = testServer({ json: assetPasswordFixture(9) }, { allowPasswordWrite: true });

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
    expect(toolText(response)).toContain(REDACTION_NOTE_REVEAL_DISABLED);
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

  /**
   * Regression, and the reason this whole shape changed.
   *
   * 0.1.0 answered `hudu_list_passwords` with a field literally named `password`
   * holding `"[withheld: password reveal is disabled on this server]"` — a
   * plausible 54-character string, sixteen times over. The reviewer only
   * established those were not credentials by counting distinct values across
   * sixteen records. Nothing downstream does that.
   */
  it('nulls the secret and flags it, instead of parking a string in the field', async () => {
    const server = testServer({ json: assetPasswordFixture(7) });

    const response = await server.call('hudu_get_password', { id: 7 });

    expect(response.structuredContent?.['password'], SHAPE_GUARD).toBeNull();
    expect(response.structuredContent?.['otp_secret'], SHAPE_GUARD).toBeNull();
    expect(response.structuredContent?.['password_redacted']).toBe(true);
    expect(response.structuredContent?.['otp_secret_redacted']).toBe(true);
    expect(JSON.stringify(response), LEAK_GUARD).not.toContain(SECRET_PASSWORD_VALUE);
  });

  it('keeps the same shape across every record of a list', async () => {
    const server = testServer({
      json: [assetPasswordFixture(1), assetPasswordFixture(2), assetPasswordFixture(3)],
    });

    const response = await server.call('hudu_list_passwords', {});
    const items = response.structuredContent?.['items'] as Record<string, unknown>[];

    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item['password'], SHAPE_GUARD).toBeNull();
      expect(item['password_redacted']).toBe(true);
    }
  });

  it('explains the redaction in the notice, under no key at all', async () => {
    const server = testServer({ json: assetPasswordFixture(7) }, { allowPasswordReveal: true });

    const response = await server.call('hudu_get_password', { id: 7 });

    expectNoSecrets(response);
    // The human-readable explanation survives — the goal of the old placeholder
    // was right — but it lives in the notice rather than under a secret's name.
    expect(toolText(response)).toContain(REDACTION_NOTE);
    expect(response.structuredContent?.['password']).toBeNull();
    expect(response.structuredContent?.['password_redacted']).toBe(true);
  });

  it('says nothing about redaction when there was nothing to redact', async () => {
    const server = testServer({ json: { id: 1, name: 'Acme' } });

    const text = toolText(await server.call('hudu_get_company', { id: 1 }));

    expect(text).not.toContain('withheld');
    expect(text).not.toContain(REDACTION_NOTE_REVEAL_DISABLED);
  });

  /**
   * "This record has no stored password" and "this record's password was
   * withheld from you" are different facts and must stay distinguishable. Flag
   * an empty field and an agent reports a credential that does not exist; fail
   * to flag a real one and it reports a documented credential as missing.
   */
  it('preserves a null password with no flag, so absence stays legible', async () => {
    const server = testServer({
      json: { ...assetPasswordFixture(7), password: null, otp_secret: null },
    });

    const response = await server.call('hudu_get_password', { id: 7 });

    expect(response.structuredContent?.['password']).toBeNull();
    expect(response.structuredContent?.['otp_secret']).toBeNull();
    expect(response.structuredContent).not.toHaveProperty('password_redacted');
    expect(response.structuredContent).not.toHaveProperty('otp_secret_redacted');
  });

  it('tells a stored-but-withheld secret apart from an absent one in one response', async () => {
    const server = testServer({
      json: [
        { ...assetPasswordFixture(1), otp_secret: null },
        { ...assetPasswordFixture(2), password: null, otp_secret: null },
      ],
    });

    const items = (await server.call('hudu_list_passwords', {})).structuredContent?.[
      'items'
    ] as Record<string, unknown>[];

    expect(items[0]!['password']).toBeNull();
    expect(items[0]!['password_redacted'], 'record 1 stores a password').toBe(true);
    expect(items[0]!).not.toHaveProperty('otp_secret_redacted');

    expect(items[1]!['password']).toBeNull();
    expect(items[1]!, 'record 2 stores nothing').not.toHaveProperty('password_redacted');
  });
});

/**
 * Regression: rendering ran on the *raw* record.
 *
 * Value-based scrubbing of the rendered Markdown was the first fix for
 * `response_format: "markdown"`, and it was incomplete. A renderer
 * JSON-stringifies a nested object and shortens any value over 300 characters,
 * so the secret could reach the output in a form the literal `split`/`join`
 * could never match. The rendering is now derived from the stripped payload,
 * which removes the class rather than another instance of it.
 */
describe('markdown rendering cannot outrun the scrubber', () => {
  it('withholds a nested secret whose value has to be JSON-escaped', async () => {
    // A quote, a backslash and a newline all survive `JSON.stringify` in an
    // escaped form, so the rendered text no longer contains the literal value.
    const awkward = 'Tr0ub4dor"\\&3\nsecond-line';
    const server = testServer({
      json: [{ id: 1, name: 'FW', credential: { password: awkward } }],
    });

    const response = await server.call('hudu_list_assets', { response_format: 'markdown' });

    expect(toolText(response), LEAK_GUARD).not.toContain('Tr0ub4dor');
    expect(toolText(response)).toContain(REDACTION_NOTE_REVEAL_DISABLED);
  });

  it('withholds a nested secret that falls across the display cut', async () => {
    // The rendered object is shortened to 300 characters, so a secret straddling
    // that boundary used to appear as an unmatchable prefix.
    const server = testServer({
      json: [
        {
          id: 1,
          name: 'FW',
          credential: { filler: 'F'.repeat(220), password: `LEAKCANARY${'x'.repeat(200)}` },
        },
      ],
    });

    const response = await server.call('hudu_list_assets', { response_format: 'markdown' });

    expect(toolText(response), LEAK_GUARD).not.toContain('LEAKCANARY');
  });

  it('withholds a secret longer than the display cut', async () => {
    const server = testServer({
      json: { ...assetPasswordFixture(7), password: `LEAKCANARY${'L'.repeat(400)}` },
    });

    const response = await server.call('hudu_get_password', { id: 7, response_format: 'markdown' });

    expect(toolText(response), LEAK_GUARD).not.toContain('LEAKCANARY');
    expect(toolText(response)).toContain(REDACTION_NOTE_REVEAL_DISABLED);
  });

  it('renders from the budgeted payload, so Markdown cannot outgrow the budget', async () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      id: index,
      name: `asset-${index}`,
      notes: 'N'.repeat(2_000),
    }));
    const server = testServer({ json: items });

    const response = await server.call('hudu_list_assets', {
      response_format: 'markdown',
      page_size: 60,
    });

    // The structured payload was cut, and the rendering says so instead of
    // silently showing a different, longer list than structuredContent holds.
    expect(response.structuredContent?.['truncated']).toBe(true);
    expect(toolText(response)).toContain('Response truncated from 60');
  });
});

/**
 * `notice` is prepended to the model-visible text and no strip walks it, so it
 * is the one field of a `ToolResult` that could carry a value straight out. No
 * shipped handler puts record data in a notice today; this asserts that the
 * boundary holds for one that does.
 */
describe('notice is scrubbed like the rest of the result', () => {
  it('redacts a secret a handler put in its notice', async () => {
    const server = testServer({ json: {} });
    const prepared = prepareTool(
      defineTool({
        name: 'hudu_test_notice',
        title: 'Notice probe',
        description: 'Test-only tool that leaks its record into the notice line.',
        inputSchema: {},
        operationClass: OperationClass.Read,
        handler: () =>
          Promise.resolve({
            data: { password: SECRET_PASSWORD_VALUE },
            notice: `Stored value is ${SECRET_PASSWORD_VALUE}.`,
          }),
      }),
    );

    const response = await executeTool(
      prepared,
      {},
      {
        client: server.client,
        config: server.config,
      },
    );

    expect(toolText(response), LEAK_GUARD).not.toContain(SECRET_PASSWORD_VALUE);
    expect(findSecretFields(response.structuredContent), LEAK_GUARD).toEqual([]);
    // Text has no key to hang a flag on, so this one substitution has to be a
    // string — kept short so it cannot read as a value in its own right.
    expect(toolText(response)).toContain(REDACTED_TEXT);
    expect(response.structuredContent?.['password']).toBeNull();
    expect(response.structuredContent?.['password_redacted']).toBe(true);
  });
});

/**
 * The error path never runs `stripSecrets` — it returns a string, not a record
 * — so an upstream body that echoes the submitted attributes is a way out.
 * `summariseErrorBody` redacts the parsed body before anything is taken from it.
 */
describe('error bodies cannot carry credentials', () => {
  it('redacts a secret echoed back in a 422 body', async () => {
    const server = testServer(
      {
        status: 422,
        json: { errors: { asset_password: { password: SECRET_PASSWORD_VALUE } } },
      },
      { allowPasswordWrite: true },
    );

    const response = await server.call('hudu_create_password', {
      name: 'Firewall admin',
      company_id: 3,
      password: SECRET_PASSWORD_VALUE,
    });

    expect(response.isError).toBe(true);
    expect(toolText(response), LEAK_GUARD).not.toContain(SECRET_PASSWORD_VALUE);
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

describe('the shape Hudu actually returns, not the shape it documents', () => {
  // Everything above this block feeds the tools a bare array and a bare record,
  // because that is what the captured contract describes. A second key with
  // password access showed the live API wraps both — `{asset_passwords: [...]}`
  // and `{asset_password: {...}}` — so these repeat the guarantees against the
  // shape that will actually arrive. A control verified only against a shape
  // that never occurs is not verified.

  it('strips secrets from the wrapped list response', async () => {
    const server = testServer({
      json: {
        asset_passwords: [assetPasswordFixture(1), assetPasswordFixture(2)],
      },
    });

    const response = await server.call('hudu_list_passwords', {});

    expectNoSecrets(response);
    // Proves the records were actually read, so the assertion above is not
    // passing merely because the list came back empty.
    expect(toolText(response)).toContain('Firewall admin');
  });

  it('strips secrets from the wrapped single record', async () => {
    const server = testServer({ json: { asset_password: assetPasswordFixture(7) } });

    const response = await server.call('hudu_get_password', { id: 7 });

    expectNoSecrets(response);
    expect(response.structuredContent?.['name']).toBe('Firewall admin');
  });

  it('reveals from the wrapped record rather than handing back the wrapper', async () => {
    const server = testServer(
      { json: { asset_password: assetPasswordFixture(7) } },
      { allowPasswordReveal: true },
    );

    const response = await server.call('hudu_reveal_password', { id: 7, confirm: true });

    // Revealing is this tool's whole job, so the secret is expected here.
    expect(toolText(response)).toContain(SECRET_PASSWORD_VALUE);
    // And the caller gets the credential, not an object containing one.
    expect(response.structuredContent?.['name']).toBe('Firewall admin');
    expect(response.structuredContent?.['asset_password']).toBeUndefined();
  });

  it('still withholds from the wrapped record when reveal is disabled', async () => {
    const server = testServer({ json: { asset_password: assetPasswordFixture(7) } });

    const response = await server.call('hudu_get_password', {
      id: 7,
      response_format: 'markdown',
    });

    expectNoSecrets(response);
  });
});
