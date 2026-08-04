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

  it.each(DESTRUCTIVE)('%s is present with the flag', (name) => {
    expect(testServer({ json: [] }, { allowDestructive: true }).has(name)).toBe(true);
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

describe('gate independence', () => {
  it('opening one gate does not open another', () => {
    const destructiveOnly = testServer({ json: {} }, { allowDestructive: true });

    expect(destructiveOnly.has('hudu_delete_company')).toBe(true);
    expect(destructiveOnly.has('hudu_reveal_password')).toBe(false);
    expect(destructiveOnly.has('hudu_start_s3_export')).toBe(false);
  });

  it('the default configuration opens no gate at all', () => {
    const server = testServer({ json: {} });
    const gated = server.built.tools.filter(
      (tool) =>
        CLASS_REQUIREMENTS[tool.operationClass].destructiveFlag ||
        tool.definition.requiresExportFlag === true ||
        tool.definition.requiresPasswordReveal === true,
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
      { allowDestructive: true, allowExports: true, allowPasswordReveal: true },
    );

    for (const tool of server.built.tools) {
      expect(known, `${tool.name} has an unknown class`).toContain(tool.operationClass);
    }
  });
});
