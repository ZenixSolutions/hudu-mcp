/**
 * The registered tool surface as a whole.
 *
 * These assertions run over every tool rather than a sample, because the risk
 * they cover is a *new* tool getting one thing wrong — a mis-set annotation, a
 * name that collides with another module's, a destructive operation classed as
 * a Read. The factories in `src/tools/define.ts` and `src/tools/resource.ts`
 * are what keep this uniform (Invariant 7 in CLAUDE.md); this file is the check
 * that nothing bypassed them.
 */

import { describe, expect, it } from 'vitest';

import {
  annotationsFor,
  CLASS_REQUIREMENTS,
  OperationClass,
  type ToolAnnotations,
} from '../../src/security/classification.js';
import { testServer } from '../helpers/fixtures.js';

/** Every gate open, so the assertions cover the widest possible surface. */
const fullServer = testServer(
  { json: {} },
  {
    allowDestructive: true,
    allowExports: true,
    allowPasswordReveal: true,
    allowPasswordWrite: true,
  },
);

const allTools = fullServer.built.tools;

describe('tool names', () => {
  const NAME_PATTERN = /^hudu_[a-z0-9_]+$/;

  it('registers a non-trivial surface', () => {
    expect(allTools.length).toBeGreaterThan(50);
  });

  it.each(allTools.map((tool) => tool.name))('%s matches /^hudu_[a-z0-9_]+$/', (name) => {
    expect(name, `${name} is not a valid MCP tool name for this server`).toMatch(NAME_PATTERN);
  });

  it('every name is unique', () => {
    const names = allTools.map((tool) => tool.name);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);

    expect(
      [...new Set(duplicates)],
      'the SDK silently shadows a duplicate registration, producing a server whose behaviour ' +
        'depends on module import order',
    ).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has no name with uppercase, hyphens, spaces or trailing underscores', () => {
    for (const tool of allTools) {
      expect(tool.name).toBe(tool.name.toLowerCase());
      expect(tool.name).not.toContain('-');
      expect(tool.name).not.toContain(' ');
      expect(tool.name.endsWith('_')).toBe(false);
      expect(tool.name).not.toContain('__');
    }
  });

  it('is uniquely named under every configuration, not just the widest one', () => {
    for (const overrides of [
      {},
      { readOnly: true },
      { allowDestructive: true },
      { allowExports: true },
      { allowPasswordReveal: true },
      { allowPasswordWrite: true },
    ]) {
      const names = testServer({ json: {} }, overrides).built.tools.map((tool) => tool.name);
      expect(new Set(names).size, JSON.stringify(overrides)).toBe(names.length);
    }
  });

  it('withheld names are disjoint from registered names', () => {
    const registered = new Set(allTools.map((tool) => tool.name));
    for (const entry of fullServer.built.withheld) {
      expect(registered.has(entry.name), `${entry.name} is both registered and withheld`).toBe(
        false,
      );
    }
  });
});

/**
 * The annotation table, written out longhand.
 *
 * `annotationsFor` is the implementation; this is the specification, and the two
 * are compared. Restating the numbers rather than calling the function is the
 * whole point — 0.1.0 shipped `destructiveHint: false` on all thirty mutating
 * tools, including `hudu_archive_company` and `hudu_archive_password`, and a
 * test that asked the implementation what it thought would have agreed with it.
 *
 * `Record<OperationClass, ...>` is load-bearing: adding a sixth class without
 * deciding its annotations fails to compile here rather than shipping a tool
 * that quietly tells clients it is harmless.
 */
const EXPECTED_ANNOTATIONS: Record<OperationClass, ToolAnnotations> = {
  [OperationClass.Read]: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Additive: brings a new record into existence, touches no existing one.
  [OperationClass.Create]: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  // Destructive because a PUT replaces prior field values, and idempotent
  // because replaying it lands in the same state. The pair is the case that
  // shows the two hints are orthogonal rather than opposites.
  [OperationClass.Update]: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Bulk export moves data out of the tenant; nothing about it is additive.
  [OperationClass.Admin]: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  [OperationClass.Destructive]: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
};

describe('annotations match the operation class', () => {
  it.each(Object.entries(EXPECTED_ANNOTATIONS))(
    '%s is annotated exactly as the table says',
    (operationClass, expected) => {
      expect(annotationsFor(operationClass as OperationClass)).toEqual(expected);
    },
  );

  it.each(allTools.map((tool) => [tool.name, tool.operationClass] as const))(
    '%s (%s) carries the annotations its class dictates',
    (name, operationClass) => {
      const tool = fullServer.tool(name);
      expect(tool.annotations, `${name} has hand-set annotations`).toEqual(
        EXPECTED_ANNOTATIONS[operationClass],
      );
    },
  );

  it('exercises every class in the table, so no row goes stale', () => {
    const classes = new Set(allTools.map((tool) => tool.operationClass));
    for (const operationClass of Object.keys(EXPECTED_ANNOTATIONS)) {
      expect(classes, `no registered tool is classed ${operationClass}`).toContain(operationClass);
    }
  });

  it('only Read tools claim readOnlyHint', () => {
    for (const tool of allTools) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(
        tool.operationClass === OperationClass.Read,
      );
    }
  });

  /**
   * Regression. The MCP definition is that `destructiveHint: true` means the
   * tool **may perform destructive updates** and false means it performs **only
   * additive** ones — not "this tool deletes things". 0.1.0 read it the narrow
   * way and annotated all thirty mutating tools false, so a client that prompts
   * from annotations prompted for none of them, `hudu_archive_company` and
   * `hudu_archive_password` included.
   */
  it('claims destructiveHint for everything that is not purely additive', () => {
    const additive: readonly OperationClass[] = [OperationClass.Read, OperationClass.Create];

    for (const tool of allTools) {
      expect(tool.annotations.destructiveHint, tool.name).toBe(
        !additive.includes(tool.operationClass),
      );
    }
  });

  it.each(['hudu_archive_company', 'hudu_archive_password', 'hudu_update_password'])(
    '%s warns a client that it is destructive',
    (name) => {
      expect(
        fullServer.tool(name).annotations.destructiveHint,
        `${name} overwrites or hides an existing record and must say so`,
      ).toBe(true);
    },
  );

  it('keeps idempotentHint true on Update, since destructive and idempotent are orthogonal', () => {
    const updates = allTools.filter((tool) => tool.operationClass === OperationClass.Update);

    expect(updates.length).toBeGreaterThan(5);
    for (const tool of updates) {
      expect(tool.annotations.idempotentHint, tool.name).toBe(true);
      expect(tool.annotations.destructiveHint, tool.name).toBe(true);
    }
  });

  it('every tool declares openWorldHint, since all of them reach a remote instance', () => {
    for (const tool of allTools) {
      expect(tool.annotations.openWorldHint, tool.name).toBe(true);
    }
  });

  it('no delete or purge tool is classed as anything but Destructive', () => {
    const removalNames = allTools.filter(
      (tool) => tool.name.includes('_delete_') || tool.name.includes('_purge_'),
    );

    expect(removalNames.length).toBeGreaterThan(5);
    for (const tool of removalNames) {
      expect(tool.operationClass, `${tool.name} removes data but is not Destructive`).toBe(
        OperationClass.Destructive,
      );
    }
  });

  it('no list or get tool is classed as anything but Read', () => {
    const readNames = allTools.filter(
      (tool) => tool.name.startsWith('hudu_list_') || tool.name.startsWith('hudu_get_'),
    );

    expect(readNames.length).toBeGreaterThan(20);
    for (const tool of readNames) {
      expect(tool.operationClass, `${tool.name} only reads but is not classed Read`).toBe(
        OperationClass.Read,
      );
    }
  });

  it('no create tool is classed as Read', () => {
    for (const tool of allTools.filter((candidate) => candidate.name.startsWith('hudu_create_'))) {
      expect(tool.operationClass).toBe(OperationClass.Create);
    }
  });
});

describe('confirmation arguments', () => {
  it('every class that requires confirmation exposes a confirm argument', () => {
    for (const tool of allTools) {
      if (!CLASS_REQUIREMENTS[tool.operationClass].confirmArgument) continue;
      expect(
        Object.keys(tool.inputSchema),
        `${tool.name} requires confirmation but exposes no confirm argument`,
      ).toContain('confirm');
    }
  });

  it('no Read tool other than the reveal carries a confirm argument', () => {
    for (const tool of allTools) {
      if (tool.operationClass !== OperationClass.Read) continue;
      if (tool.definition.requiresPasswordReveal) continue;
      expect(Object.keys(tool.inputSchema), tool.name).not.toContain('confirm');
    }
  });
});

describe('descriptions', () => {
  it('every tool states its operation class to the model', () => {
    for (const tool of allTools) {
      expect(tool.description, tool.name).toContain(`Operation class: ${tool.operationClass}.`);
    }
  });

  it('every gated tool says it needs confirmation', () => {
    for (const tool of allTools) {
      if (!CLASS_REQUIREMENTS[tool.operationClass].confirmArgument) continue;
      expect(tool.description, tool.name).toContain('requires `confirm: true`');
    }
  });

  it('every description is substantial enough to choose between tools', () => {
    for (const tool of allTools) {
      expect(tool.description.length, `${tool.name} has a thin description`).toBeGreaterThan(80);
      expect(tool.title.length, `${tool.name} has no title`).toBeGreaterThan(0);
    }
  });

  it('no description contains anything resembling a credential', () => {
    for (const tool of allTools) {
      expect(tool.description, tool.name).not.toMatch(/HUDU_API_KEY\s*=\s*\S/);
    }
  });
});

describe('no tool accepts a credential or a gate override as an argument', () => {
  const FORBIDDEN_ARGS = [
    'api_key',
    'apikey',
    'x_api_key',
    'base_url',
    'token',
    'allow_destructive',
    'allow_exports',
    'allow_password_reveal',
    'allow_password_write',
    'read_only',
    'reveal',
    'force',
  ];

  it.each(allTools.map((tool) => tool.name))('%s exposes no such argument', (name) => {
    const args = Object.keys(fullServer.tool(name).inputSchema).map((key) => key.toLowerCase());
    for (const forbidden of FORBIDDEN_ARGS) {
      expect(
        args,
        `${name} accepts "${forbidden}" — gates are environment-only (CLAUDE.md Invariant 4)`,
      ).not.toContain(forbidden);
    }
  });
});
