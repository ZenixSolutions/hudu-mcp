/**
 * Structural secret stripping.
 *
 * `Asset_Password` lists `password` and `otp_secret` among its required
 * properties and `GET /asset_passwords` returns an array of that model
 * (docs/reference/spec-defects.md A1), so a single call can return every
 * credential in the tenant. Everything here guards the one function that stops
 * that reaching a tool result.
 */

import { describe, expect, it } from 'vitest';

import {
  collectSecretValues,
  findSecretFields,
  redactSecretsInText,
  SECRET_FIELDS,
  stripSecrets,
  WITHHELD,
  WITHHELD_DISABLED,
} from '../../src/security/secrets.js';
import {
  assetPasswordFixture,
  SECRET_OTP_VALUE,
  SECRET_PASSWORD_VALUE,
} from '../helpers/fixtures.js';

describe('SECRET_FIELDS', () => {
  it('covers exactly the two required Asset_Password secrets', () => {
    expect([...SECRET_FIELDS]).toEqual(['password', 'otp_secret']);
  });
});

describe('stripSecrets', () => {
  it('removes the key entirely when no placeholder is given', () => {
    const output = stripSecrets(assetPasswordFixture());
    expect(output).not.toHaveProperty('password');
    expect(output).not.toHaveProperty('otp_secret');
    expect(output['name']).toBe('Firewall admin');
    expect(output['username']).toBe('admin');
  });

  it('substitutes a placeholder when one is given', () => {
    const output = stripSecrets(assetPasswordFixture(), { placeholder: WITHHELD });
    expect(output['password']).toBe(WITHHELD);
    expect(output['otp_secret']).toBe(WITHHELD);
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
    expect(JSON.stringify(output)).not.toContain(SECRET_OTP_VALUE);
  });

  it('strips every element of a list response', () => {
    const list = [assetPasswordFixture(1), assetPasswordFixture(2), assetPasswordFixture(3)];
    const output = stripSecrets(list, { placeholder: WITHHELD_DISABLED });
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
    expect(JSON.stringify(output)).not.toContain(SECRET_OTP_VALUE);
    expect(findSecretFields(output)).toEqual([]);
  });

  it('strips secrets nested inside an unrelated envelope', () => {
    const payload = {
      items: [{ asset: { name: 'FW', passwords: [assetPasswordFixture()] } }],
      pagination_note: 'x',
    };
    const output = stripSecrets(payload, { placeholder: WITHHELD });
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
    expect(findSecretFields(output)).toEqual([]);
  });

  it('strips a secret buried at depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: { password: SECRET_PASSWORD_VALUE } } } } } } };
    const output = stripSecrets(deep, { placeholder: WITHHELD });
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
  });

  it('strips secrets inside arrays of arrays', () => {
    const nested = [[[{ otp_secret: SECRET_OTP_VALUE }]]];
    expect(JSON.stringify(stripSecrets(nested, { placeholder: WITHHELD }))).not.toContain(
      SECRET_OTP_VALUE,
    );
  });

  it('preserves a null password as-is rather than disguising it as a redaction', () => {
    // A null password is a real, useful fact: the record documents an account
    // with no stored secret. Reporting it as "[withheld]" would tell an agent a
    // credential exists when none does.
    const output = stripSecrets(
      { id: 1, password: null, otp_secret: null },
      {
        placeholder: WITHHELD,
      },
    ) as Record<string, unknown>;
    expect(output['password']).toBeNull();
    expect(output['otp_secret']).toBeNull();
  });

  it('preserves an empty-string password as-is', () => {
    const output = stripSecrets({ id: 1, password: '' }, { placeholder: WITHHELD }) as Record<
      string,
      unknown
    >;
    expect(output['password']).toBe('');
  });

  it('preserves an undefined password as-is', () => {
    const output = stripSecrets(
      { id: 1, password: undefined },
      { placeholder: WITHHELD },
    ) as Record<string, unknown>;
    expect(output).toHaveProperty('password');
    expect(output['password']).toBeUndefined();
  });

  it('does not hang on a cyclic payload', () => {
    const node: Record<string, unknown> = { password: SECRET_PASSWORD_VALUE };
    node['self'] = node;

    const output = stripSecrets(node, { placeholder: WITHHELD });

    expect(output['password']).toBe(WITHHELD);
    // The cycle is preserved structurally, pointing at the stripped copy rather
    // than at the original object, so the secret cannot be reached round the loop.
    expect(output['self']).toBe(output);
  });

  it('does not hang on a cycle through an array', () => {
    const list: unknown[] = [{ password: SECRET_PASSWORD_VALUE }];
    list.push(list);

    const output = stripSecrets(list, { placeholder: WITHHELD });

    expect(output[1]).toBe(output);
    expect((output[0] as Record<string, unknown>)['password']).toBe(WITHHELD);
  });

  it('leaves scalars and non-objects alone', () => {
    expect(stripSecrets('plain')).toBe('plain');
    expect(stripSecrets(7)).toBe(7);
    expect(stripSecrets(null)).toBeNull();
  });

  it('does not mutate the input', () => {
    const original = assetPasswordFixture();
    stripSecrets(original, { placeholder: WITHHELD });
    expect(original['password']).toBe(SECRET_PASSWORD_VALUE);
  });
});

describe('findSecretFields', () => {
  it('reports nothing for a clean payload', () => {
    expect(findSecretFields({ id: 1, name: 'x', items: [{ id: 2 }] })).toEqual([]);
  });

  it('reports the path of a leaked secret', () => {
    expect(findSecretFields(assetPasswordFixture())).toEqual(['$.password', '$.otp_secret']);
  });

  it('reports paths through arrays with their indices', () => {
    const payload = { items: [{ id: 1 }, { id: 2, password: SECRET_PASSWORD_VALUE }] };
    expect(findSecretFields(payload)).toEqual(['$.items[1].password']);
  });

  it('reports a secret buried at depth', () => {
    const deep = { a: { b: [{ c: { otp_secret: SECRET_OTP_VALUE } }] } };
    expect(findSecretFields(deep)).toEqual(['$.a.b[0].c.otp_secret']);
  });

  it('ignores the withheld placeholder text', () => {
    expect(findSecretFields({ password: WITHHELD, otp_secret: WITHHELD_DISABLED })).toEqual([]);
  });

  it('ignores null and empty values, which carry no secret', () => {
    expect(findSecretFields({ password: null, otp_secret: '' })).toEqual([]);
  });

  it('finds nothing after stripSecrets has run, on the same payload', () => {
    const payload = { items: [assetPasswordFixture(1), assetPasswordFixture(2)] };
    expect(findSecretFields(payload)).toHaveLength(4);
    expect(findSecretFields(stripSecrets(payload, { placeholder: WITHHELD }))).toEqual([]);
  });

  it('does not hang on a cyclic payload', () => {
    const node: Record<string, unknown> = { password: SECRET_PASSWORD_VALUE };
    node['self'] = node;
    expect(findSecretFields(node)).toEqual(['$.password']);
  });

  it('accepts a custom root path for reporting', () => {
    expect(findSecretFields({ password: SECRET_PASSWORD_VALUE }, 'result')).toEqual([
      'result.password',
    ]);
  });
});

/**
 * A rendered Markdown view is built from the raw record, before `stripSecrets`
 * runs on the structured data. It has no keys to walk, so it is scrubbed by
 * value — these two functions are what make that possible.
 */
describe('collectSecretValues', () => {
  it('collects both secrets from a record', () => {
    expect(collectSecretValues(assetPasswordFixture()).sort()).toEqual(
      [SECRET_PASSWORD_VALUE, SECRET_OTP_VALUE].sort(),
    );
  });

  it('collects from nested and array positions', () => {
    const payload = { items: [{ inner: { password: SECRET_PASSWORD_VALUE } }] };
    expect(collectSecretValues(payload)).toEqual([SECRET_PASSWORD_VALUE]);
  });

  it('de-duplicates repeated values', () => {
    const payload = [{ password: 'same' }, { password: 'same' }];
    expect(collectSecretValues(payload)).toEqual(['same']);
  });

  it('ignores null, empty and already-withheld values', () => {
    expect(
      collectSecretValues({
        a: { password: null },
        b: { password: '' },
        c: { password: WITHHELD },
      }),
    ).toEqual([]);
  });

  it('returns nothing for a clean payload', () => {
    expect(collectSecretValues({ id: 1, name: 'Acme' })).toEqual([]);
    expect(collectSecretValues(null)).toEqual([]);
  });

  it('does not hang on a cyclic payload', () => {
    const node: Record<string, unknown> = { password: SECRET_PASSWORD_VALUE };
    node['self'] = node;
    expect(collectSecretValues(node)).toEqual([SECRET_PASSWORD_VALUE]);
  });
});

describe('redactSecretsInText', () => {
  it('replaces every occurrence of every secret', () => {
    const text = `pw ${SECRET_PASSWORD_VALUE} otp ${SECRET_OTP_VALUE} pw again ${SECRET_PASSWORD_VALUE}`;
    const output = redactSecretsInText(text, [SECRET_PASSWORD_VALUE, SECRET_OTP_VALUE], WITHHELD);

    expect(output).not.toContain(SECRET_PASSWORD_VALUE);
    expect(output).not.toContain(SECRET_OTP_VALUE);
    expect(output.split(WITHHELD)).toHaveLength(4);
  });

  it('treats a secret as a literal, not a pattern', () => {
    // A stored password is arbitrary text; an escaping mistake in a regex-based
    // implementation would be a leak.
    expect(redactSecretsInText('a.*b', ['a.*b'], WITHHELD)).toBe(WITHHELD);
    expect(redactSecretsInText('axxb', ['a.*b'], WITHHELD)).toBe('axxb');
  });

  it('leaves the text alone when there is nothing to scrub', () => {
    expect(redactSecretsInText('nothing here', [], WITHHELD)).toBe('nothing here');
  });
});
