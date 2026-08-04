/**
 * Capability gating.
 *
 * A gated tool is not registered at all rather than registered-and-refusing: a
 * tool a model cannot see is a tool it cannot be talked into calling. Gates are
 * environment-only and no tool argument may open one (Invariant 4 in
 * CLAUDE.md). These assertions cover both halves — what is absent, and what the
 * remaining tools refuse to do without an explicit confirmation.
 */

import { describe, expect, it } from 'vitest';

import { CLASS_REQUIREMENTS, OperationClass } from '../../src/security/classification.js';
import { testServer, toolText } from '../helpers/fixtures.js';

describe('read-only mode', () => {
  const server = testServer({ json: [] }, { readOnly: true });

  it('registers zero tools whose class is not Read', () => {
    const offenders = server.built.tools.filter(
      (tool) => tool.operationClass !== OperationClass.Read,
    );

    expect(
      offenders.map((tool) => `${tool.name} (${tool.operationClass})`),
      'read-only mode must register nothing that can change Hudu',
    ).toEqual([]);
  });

  it('registers no tool whose requirements include writes', () => {
    const offenders = server.built.tools.filter(
      (tool) => CLASS_REQUIREMENTS[tool.operationClass].writes,
    );
    expect(offenders.map((tool) => tool.name)).toEqual([]);
  });

  it('annotates every registered tool as read-only', () => {
    for (const tool of server.built.tools) {
      expect(tool.annotations.readOnlyHint, `${tool.name} is not annotated read-only`).toBe(true);
      expect(tool.annotations.destructiveHint, `${tool.name} is annotated destructive`).toBe(false);
    }
  });

  it('still registers a useful surface rather than nothing at all', () => {
    expect(server.built.tools.length).toBeGreaterThan(20);
    expect(server.has('hudu_list_companies')).toBe(true);
    expect(server.has('hudu_get_api_info')).toBe(true);
  });

  it.each([
    'hudu_create_company',
    'hudu_update_company',
    'hudu_delete_company',
    'hudu_archive_company',
    'hudu_start_company_export',
  ])('withholds %s', (name) => {
    expect(server.has(name)).toBe(false);
    expect(server.built.withheld.map((entry) => entry.name)).toContain(name);
  });

  it('explains why each tool was withheld', () => {
    for (const entry of server.built.withheld) {
      expect(entry.reason, `${entry.name} was withheld with no reason`).toContain('HUDU_');
    }
  });

  // Regression: withholdReason used to answer `config.readOnly` first, without
  // asking whether the tool writes at all. hudu_reveal_password is classed
  // Read, so read-only never withholds it — reporting HUDU_READ_ONLY sent an
  // operator following docs/security.md step 5 to unset the one variable that
  // would not change the outcome.
  it('names the gate that actually withheld a Read-classed tool', () => {
    const entry = server.built.withheld.find((item) => item.name === 'hudu_reveal_password');

    expect(entry, 'hudu_reveal_password must be withheld with the reveal flag unset').toBeDefined();
    expect(entry?.reason).toContain('HUDU_ALLOW_PASSWORD_REVEAL');
    expect(entry?.reason, 'read-only does not withhold a Read tool').not.toContain(
      'HUDU_READ_ONLY',
    );
  });

  it('names a gate that is genuinely closed for every withheld tool', () => {
    for (const entry of server.built.withheld) {
      const tool = server.built.tools.find((item) => item.name === entry.name);
      expect(tool, `${entry.name} is both registered and withheld`).toBeUndefined();

      if (entry.reason.includes('HUDU_READ_ONLY')) expect(server.config.readOnly).toBe(true);
      if (entry.reason.includes('HUDU_ALLOW_EXPORTS'))
        expect(server.config.allowExports).toBe(false);
      if (entry.reason.includes('HUDU_ALLOW_PASSWORD_REVEAL')) {
        expect(server.config.allowPasswordReveal).toBe(false);
      }
      if (entry.reason.includes('HUDU_ALLOW_PASSWORD_WRITE')) {
        expect(server.config.allowPasswordWrite).toBe(false);
      }
    }
  });

  it('refuses a write even if a caller reaches executeTool directly', async () => {
    // Belt and braces: the tool is unregistered, but the gate is re-checked in
    // executeTool so no code path can slip past registration.
    const writable = testServer({ json: {} });
    const prepared = writable.tool('hudu_create_company');
    const readOnly = testServer({ json: {} }, { readOnly: true });

    const { executeTool } = await import('../../src/tools/define.js');
    const response = await executeTool(
      prepared,
      { name: 'Acme' },
      { client: readOnly.client, config: readOnly.config },
    );

    expect(response.isError).toBe(true);
    expect(toolText(response)).toContain('read-only mode');
    expect(toolText(response)).toContain('HUDU_READ_ONLY');
    expect(readOnly.http.requests, 'a refused write must not reach Hudu').toHaveLength(0);
  });
});

describe('destructive tools', () => {
  const DESTRUCTIVE = [
    'hudu_delete_company',
    'hudu_delete_asset',
    'hudu_delete_article',
    'hudu_delete_password',
    'hudu_delete_network',
    'hudu_delete_website',
    'hudu_purge_activity_logs',
    'hudu_delete_magic_dash_item_by_title',
  ];

  it('registers none of them without HUDU_ALLOW_DESTRUCTIVE', () => {
    const server = testServer({ json: [] });
    const registered = server.built.tools.filter(
      (tool) => tool.operationClass === OperationClass.Destructive,
    );

    expect(
      registered.map((tool) => tool.name),
      'destructive tools must be absent unless the operator enables them',
    ).toEqual([]);
  });

  it.each(DESTRUCTIVE)('%s is absent without the flag', (name) => {
    expect(testServer({ json: [] }).has(name)).toBe(false);
  });

  // hudu_delete_password needs HUDU_ALLOW_PASSWORD_WRITE as well, because
  // destroying a credential is both a destructive act and a vault write. Both
  // gates are open here so this stays a test of the destructive gate.
  it.each(DESTRUCTIVE)('%s is present with the flag', (name) => {
    expect(
      testServer({ json: [] }, { allowDestructive: true, allowPasswordWrite: true }).has(name),
    ).toBe(true);
  });

  it('refuses every destructive tool without confirm: true', async () => {
    const server = testServer({ status: 204 }, { allowDestructive: true });
    const destructive = server.built.tools.filter(
      (tool) => tool.operationClass === OperationClass.Destructive,
    );

    expect(destructive.length).toBeGreaterThan(0);

    for (const tool of destructive) {
      const response = await server.call(tool.name, { id: 1, datetime: '2026-01-01T00:00:00Z' });
      expect(response.isError, `${tool.name} ran without confirmation`).toBe(true);
      expect(toolText(response)).toContain('requires confirm: true');
    }

    expect(server.http.requests, 'no unconfirmed destructive call may reach Hudu').toHaveLength(0);
  });

  it.each([false, 'true', 1, null, undefined])(
    'treats confirm=%j as not confirmed',
    async (confirm) => {
      const server = testServer({ status: 204 }, { allowDestructive: true });

      const response = await server.call('hudu_delete_company', { id: 1, confirm });

      expect(response.isError).toBe(true);
      expect(server.http.requests).toHaveLength(0);
    },
  );

  it('runs with confirm: true', async () => {
    const server = testServer({ status: 204 }, { allowDestructive: true });

    const response = await server.call('hudu_delete_company', { id: 1, confirm: true });

    expect(response.isError).toBeUndefined();
    expect(server.http.requests).toHaveLength(1);
  });

  it('states the impact when refusing, so the model can explain it to the user', async () => {
    const server = testServer({ status: 204 }, { allowDestructive: true });

    const text = toolText(await server.call('hudu_delete_company', { id: 1 }));

    expect(text).toContain('What to do:');
    expect(text.length).toBeGreaterThan(80);
  });

  it('re-checks the flag in executeTool, not only at registration', async () => {
    const enabled = testServer({ status: 204 }, { allowDestructive: true });
    const disabled = testServer({ status: 204 });

    const { executeTool } = await import('../../src/tools/define.js');
    const response = await executeTool(
      enabled.tool('hudu_delete_company'),
      { id: 1, confirm: true },
      { client: disabled.client, config: disabled.config },
    );

    expect(response.isError).toBe(true);
    expect(toolText(response)).toContain('HUDU_ALLOW_DESTRUCTIVE');
    expect(disabled.http.requests).toHaveLength(0);
  });
});

describe('export tools', () => {
  const EXPORTS = ['hudu_start_company_export', 'hudu_start_s3_export'];

  it.each(EXPORTS)('%s is absent without HUDU_ALLOW_EXPORTS', (name) => {
    const server = testServer({ json: {} });
    expect(server.has(name)).toBe(false);
    expect(server.built.withheld.find((entry) => entry.name === name)?.reason).toContain(
      'HUDU_ALLOW_EXPORTS',
    );
  });

  it.each(EXPORTS)('%s is present with HUDU_ALLOW_EXPORTS', (name) => {
    expect(testServer({ json: {} }, { allowExports: true }).has(name)).toBe(true);
  });

  it('is absent in read-only mode even with the export flag set', () => {
    const server = testServer({ json: {} }, { readOnly: true, allowExports: true });
    for (const name of EXPORTS) expect(server.has(name)).toBe(false);
  });

  it('refuses without confirm: true, because exports are Admin class', async () => {
    const server = testServer({ status: 200, json: {} }, { allowExports: true });

    for (const name of EXPORTS) {
      const response = await server.call(name, { company_id: 1 });
      expect(response.isError, `${name} ran without confirmation`).toBe(true);
    }

    expect(server.http.requests).toHaveLength(0);
  });

  it('re-checks the export flag in executeTool', async () => {
    const enabled = testServer({ status: 200, json: {} }, { allowExports: true });
    const disabled = testServer({ status: 200, json: {} });

    const { executeTool } = await import('../../src/tools/define.js');
    const response = await executeTool(
      enabled.tool('hudu_start_s3_export'),
      { confirm: true },
      { client: disabled.client, config: disabled.config },
    );

    expect(response.isError).toBe(true);
    expect(toolText(response)).toContain('HUDU_ALLOW_EXPORTS');
    expect(disabled.http.requests).toHaveLength(0);
  });
});

/**
 * Password writes.
 *
 * Until 0.2.0 `HUDU_ALLOW_PASSWORD_REVEAL` gated reads and *nothing* gated
 * writes, so a password-scoped key could not read a credential but could
 * overwrite or archive one: the destructive direction open while the read
 * direction was locked. `HUDU_ALLOW_PASSWORD_WRITE` closes it, and stays
 * independent of the reveal flag — documenting a newly issued credential
 * without being able to read existing ones is a legitimate posture, and
 * collapsing the two would make an operator grant vault-wide reads to get it.
 */
describe('password write tools', () => {
  const PASSWORD_WRITES = [
    'hudu_create_password',
    'hudu_update_password',
    'hudu_archive_password',
    'hudu_delete_password',
  ];

  it('registers none of them under any combination of the other gates', () => {
    const combinations = [
      {},
      { allowDestructive: true },
      { allowExports: true },
      { allowPasswordReveal: true },
      { readOnly: true },
      { readOnly: true, allowPasswordReveal: true },
      { allowDestructive: true, allowExports: true, allowPasswordReveal: true },
    ];

    for (const overrides of combinations) {
      const server = testServer({ json: {} }, overrides);
      const registered = server.built.tools
        .map((tool) => tool.name)
        .filter((name) => PASSWORD_WRITES.includes(name));

      expect(
        registered,
        `${JSON.stringify(overrides)} registered a password write without HUDU_ALLOW_PASSWORD_WRITE`,
      ).toEqual([]);
    }
  });

  it('registers no tool flagged requiresPasswordWrite without the flag', () => {
    // Name-independent: a write tool added later under a different name is
    // still caught, because the assertion is on the flag rather than a list.
    for (const overrides of [{}, { allowDestructive: true }, { allowPasswordReveal: true }]) {
      const server = testServer({ json: {} }, overrides);
      const offenders = server.built.tools.filter(
        (tool) => tool.definition.requiresPasswordWrite === true,
      );
      expect(
        offenders.map((tool) => tool.name),
        JSON.stringify(overrides),
      ).toEqual([]);
    }
  });

  it.each(PASSWORD_WRITES)('%s says which gate withheld it', (name) => {
    const server = testServer({ json: {} }, { allowDestructive: true });
    const entry = server.built.withheld.find((item) => item.name === name);

    expect(entry, `${name} must be withheld by default`).toBeDefined();
    expect(entry?.reason).toContain('HUDU_ALLOW_PASSWORD_WRITE');
  });

  it('registers create, update and archive with the flag set', () => {
    const server = testServer({ json: {} }, { allowPasswordWrite: true });

    expect(server.has('hudu_create_password')).toBe(true);
    expect(server.has('hudu_update_password')).toBe(true);
    expect(server.has('hudu_archive_password')).toBe(true);
  });

  it.each([
    ['hudu_create_password', { name: 'Firewall admin', company_id: 3 }],
    ['hudu_update_password', { id: 9, username: 'admin' }],
    ['hudu_archive_password', { id: 9, archived: true }],
  ])('%s functions with the flag set', async (name, args) => {
    const server = testServer(
      { json: { id: 9, name: 'Firewall admin' } },
      { allowPasswordWrite: true },
    );

    const response = await server.call(name, args);

    expect(response.isError, `${name} failed with the gate open`).toBeUndefined();
    expect(server.http.requests, `${name} issued no request`).toHaveLength(1);
  });

  // Deleting a credential is destructive *and* a vault write, so it needs both
  // gates. That is intended: an operator who enabled deletes for articles and
  // assets has said nothing about whether an agent may destroy a password.
  it('needs both gates to delete, and neither alone will do', () => {
    expect(testServer({ json: {} }, { allowDestructive: true }).has('hudu_delete_password')).toBe(
      false,
    );
    expect(testServer({ json: {} }, { allowPasswordWrite: true }).has('hudu_delete_password')).toBe(
      false,
    );
    expect(
      testServer({ json: {} }, { allowDestructive: true, allowPasswordWrite: true }).has(
        'hudu_delete_password',
      ),
    ).toBe(true);
  });

  it('leaves password reads alone — the gate is about writing, not reading', () => {
    const server = testServer({ json: {} });

    expect(server.has('hudu_list_passwords')).toBe(true);
    expect(server.has('hudu_get_password')).toBe(true);
    expect(server.has('hudu_list_password_folders')).toBe(true);
  });

  it('is still withheld in read-only mode, where the write gate is redundant', () => {
    const server = testServer({ json: {} }, { readOnly: true, allowPasswordWrite: true });
    for (const name of PASSWORD_WRITES) expect(server.has(name)).toBe(false);
  });

  it.each(PASSWORD_WRITES)(
    're-checks the flag in executeTool for %s, not only at registration',
    async (name) => {
      const enabled = testServer(
        { json: {} },
        { allowPasswordWrite: true, allowDestructive: true },
      );
      const disabled = testServer({ json: {} }, { allowDestructive: true });

      const { executeTool } = await import('../../src/tools/define.js');
      const response = await executeTool(
        enabled.tool(name),
        { id: 9, name: 'Firewall admin', company_id: 3, archived: true, confirm: true },
        { client: disabled.client, config: disabled.config },
      );

      expect(response.isError).toBe(true);
      expect(toolText(response)).toContain('HUDU_ALLOW_PASSWORD_WRITE');
      expect(disabled.http.requests, 'a refused write must not reach Hudu').toHaveLength(0);
    },
  );

  it('does not gate writes to resources that store no credentials', () => {
    const server = testServer({ json: {} });

    expect(server.has('hudu_create_company')).toBe(true);
    expect(server.has('hudu_update_company')).toBe(true);
    expect(server.has('hudu_archive_company')).toBe(true);
  });
});

describe('gate independence', () => {
  it('opening one gate does not open another', () => {
    const destructiveOnly = testServer({ json: {} }, { allowDestructive: true });

    expect(destructiveOnly.has('hudu_delete_company')).toBe(true);
    expect(destructiveOnly.has('hudu_reveal_password')).toBe(false);
    expect(destructiveOnly.has('hudu_start_s3_export')).toBe(false);
    expect(destructiveOnly.has('hudu_create_password')).toBe(false);
  });

  // The two password gates are separate on purpose. Reading a stored credential
  // and overwriting one are different powers, and either without the other is a
  // posture an operator may reasonably want.
  it('the reveal gate does not open the write gate', () => {
    const revealOnly = testServer({ json: {} }, { allowPasswordReveal: true });

    expect(revealOnly.has('hudu_reveal_password')).toBe(true);
    expect(revealOnly.has('hudu_create_password')).toBe(false);
    expect(revealOnly.has('hudu_update_password')).toBe(false);
  });

  it('the write gate does not open the reveal gate', () => {
    const writeOnly = testServer({ json: {} }, { allowPasswordWrite: true });

    expect(writeOnly.has('hudu_create_password')).toBe(true);
    expect(
      writeOnly.has('hudu_reveal_password'),
      'writing a credential must not confer reading every other one',
    ).toBe(false);
  });

  it('the default configuration opens no gate at all', () => {
    const server = testServer({ json: {} });
    const gated = server.built.tools.filter(
      (tool) =>
        CLASS_REQUIREMENTS[tool.operationClass].destructiveFlag ||
        tool.definition.requiresExportFlag === true ||
        tool.definition.requiresPasswordReveal === true ||
        tool.definition.requiresPasswordWrite === true,
    );

    expect(
      gated.map((tool) => tool.name),
      'secure by default',
    ).toEqual([]);
  });

  it('classifies every registered tool into one of the five documented classes', () => {
    const known: readonly OperationClass[] = [
      OperationClass.Read,
      OperationClass.Create,
      OperationClass.Update,
      OperationClass.Admin,
      OperationClass.Destructive,
    ];
    const server = testServer(
      { json: {} },
      {
        allowDestructive: true,
        allowExports: true,
        allowPasswordReveal: true,
        allowPasswordWrite: true,
      },
    );

    for (const tool of server.built.tools) {
      expect(known, `${tool.name} has an unknown class`).toContain(tool.operationClass);
    }
  });
});
