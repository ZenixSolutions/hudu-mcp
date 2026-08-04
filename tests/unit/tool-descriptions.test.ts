/**
 * What the tool descriptions promise about the *responses*.
 *
 * A description is part of the interface contract, and a description that names
 * a field the response does not carry costs a caller a round trip and a wrong
 * conclusion. `hudu_list_activity_logs` promised `action_message` on every
 * entry for the whole of 0.1.0; the response carries `action`. These tests are
 * cheap and static, so the class of defect stays fixed.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { allToolDefinitions } from '../../src/tools/index.js';

const definitions = allToolDefinitions();

/** Every string a model reads about a tool: its description and its arguments. */
function proseOf(definition: (typeof definitions)[number]): { where: string; text: string }[] {
  const parts = [{ where: definition.name, text: definition.description }];
  for (const [argument, schema] of Object.entries(definition.inputSchema)) {
    // See the note in observed-behaviour.test.ts: zod 4 narrows ZodRawShape's
    // value type to `$ZodType`, which does not declare `description`.
    const { description } = schema as z.ZodType;
    if (description !== undefined) {
      parts.push({ where: `${definition.name}.${argument}`, text: description });
    }
  }
  return parts;
}

describe('response fields a description claims exist', () => {
  /**
   * `action_message` is a query parameter and nothing else. Any sentence that
   * has an entry carrying, returning or including it is describing a field that
   * does not exist, so the pattern is bounded by a full stop: the correction
   * ("no field called `action_message` exists in the response") must not trip
   * it, and a fresh claim must.
   */
  const CLAIMS_ACTION_MESSAGE_IS_RETURNED =
    /(?:carr(?:y|ies)|return(?:s|ed|ing)?|includ(?:e|es|ing)|report(?:s|ed)?)[^.]{0,120}`action_message`/i;

  it('never presents `action_message` as something an entry comes back with', () => {
    for (const definition of definitions) {
      for (const { where, text } of proseOf(definition)) {
        expect(
          text,
          `${where} describes action_message as a response field; it is a filter only, and the ` +
            'entry carries `action`',
        ).not.toMatch(CLAIMS_ACTION_MESSAGE_IS_RETURNED);
      }
    }
  });

  it('states the activity-log filter/response asymmetry outright', () => {
    const activityLogs = definitions.find((tool) => tool.name === 'hudu_list_activity_logs');
    expect(activityLogs).toBeDefined();
    const description = activityLogs?.description ?? '';

    // The names the response actually uses, all three of them.
    expect(description).toContain('`record_type`');
    expect(description).toContain('`record_id`');
    expect(description).toContain('`action`');
    expect(description).toMatch(/no `action_message` field on an entry/i);
  });

  it('warns that the newest entry is often a view rather than a change', () => {
    const description =
      definitions.find((tool) => tool.name === 'hudu_list_activity_logs')?.description ?? '';

    expect(description).toContain('`viewed`');
    // Filtering out reads is the caller's job; saying so is this server's.
    expect(description).toMatch(/not the newest change/i);
  });

  it('warns that `details` is a post-state snapshot, not a diff', () => {
    const description =
      definitions.find((tool) => tool.name === 'hudu_list_activity_logs')?.description ?? '';

    expect(description).toContain('`details`');
    expect(description).toMatch(/two consecutive/i);
  });

  it('warns that the api_info `date` cannot be parsed as a date', () => {
    const description =
      definitions.find((tool) => tool.name === 'hudu_get_api_info')?.description ?? '';

    expect(description).toContain('2026-31-05');
    expect(description).toMatch(/not parsed|passed through/i);
  });
});
