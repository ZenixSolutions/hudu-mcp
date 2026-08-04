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
  REDACTED_TEXT,
  redactedFlagFor,
  redactSecretsInText,
  SECRET_FIELDS,
  stripSecrets,
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

/**
 * The redacted shape.
 *
 * 0.1.0 replaced a stored password with a sentence — `password: "[withheld:
 * password reveal is disabled on this server]"` — so a list of sixteen
 * credentials returned sixteen fields named `password` holding a plausible
 * fifty-four-character string. That is a hazard, not a control: the only way to
 * establish those were not credentials was to notice all sixteen were identical,
 * and nothing downstream does that.
 *
 * The invariant these assertions hold is flat and structural: **no field named
 * `password` or `otp_secret` ever holds a string.** The fact a value exists moves
 * to a boolean under a different key.
 */
describe('stripSecrets', () => {
  it('nulls a secret and flags it, rather than leaving a string behind', () => {
    const output = stripSecrets(assetPasswordFixture());

    expect(output['password'], 'a redacted secret must never be a string').toBeNull();
    expect(output['otp_secret']).toBeNull();
    expect(output['password_redacted']).toBe(true);
    expect(output['otp_secret_redacted']).toBe(true);
    expect(output['name']).toBe('Firewall admin');
    expect(output['username']).toBe('admin');
  });

  it.each(SECRET_FIELDS)('never leaves a string under %s', (field) => {
    const output = stripSecrets({ [field]: 'anything at all' }) as Record<string, unknown>;

    expect(typeof output[field]).not.toBe('string');
    expect(output[redactedFlagFor(field)]).toBe(true);
  });

  it('strips every element of a list response', () => {
    const list = [assetPasswordFixture(1), assetPasswordFixture(2), assetPasswordFixture(3)];
    const output = stripSecrets(list);
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
    expect(JSON.stringify(output)).not.toContain(SECRET_OTP_VALUE);
    expect(findSecretFields(output)).toEqual([]);
  });

  it('strips secrets nested inside an unrelated envelope', () => {
    const payload = {
      items: [{ asset: { name: 'FW', passwords: [assetPasswordFixture()] } }],
      pagination_note: 'x',
    };
    const output = stripSecrets(payload);
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
    expect(findSecretFields(output)).toEqual([]);
  });

  it('flags the redaction at the depth it happened, not at the root', () => {
    const output = stripSecrets({
      items: [{ asset: { name: 'FW', passwords: [assetPasswordFixture()] } }],
    }) as Record<string, unknown>;

    expect(output['password_redacted'], 'the flag belongs beside the field').toBeUndefined();
    const record = (
      (output['items'] as Record<string, unknown>[])[0]!['asset'] as Record<string, unknown>
    )['passwords'] as Record<string, unknown>[];
    expect(record[0]!['password_redacted']).toBe(true);
  });

  it('strips a secret buried at depth', () => {
    const deep = { a: { b: { c: { d: { e: { f: { password: SECRET_PASSWORD_VALUE } } } } } } };
    const output = stripSecrets(deep);
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
  });

  it('strips secrets inside arrays of arrays', () => {
    const nested = [[[{ otp_secret: SECRET_OTP_VALUE }]]];
    expect(JSON.stringify(stripSecrets(nested))).not.toContain(SECRET_OTP_VALUE);
  });

  it('preserves a null password with NO flag, so absence stays distinguishable', () => {
    // "This record documents an account with no stored password" and "this
    // record's password was withheld from you" are different facts. A caller
    // that cannot tell them apart will either invent a credential that does not
    // exist or report a real one as missing, so the flag appears only for the
    // second.
    const output = stripSecrets({ id: 1, password: null, otp_secret: null }) as Record<
      string,
      unknown
    >;

    expect(output['password']).toBeNull();
    expect(output['otp_secret']).toBeNull();
    expect(output).not.toHaveProperty('password_redacted');
    expect(output).not.toHaveProperty('otp_secret_redacted');
  });

  it('preserves an empty-string password as-is, with no flag', () => {
    const output = stripSecrets({ id: 1, password: '' }) as Record<string, unknown>;
    expect(output['password']).toBe('');
    expect(output).not.toHaveProperty('password_redacted');
  });

  it('preserves an undefined password as-is, with no flag', () => {
    const output = stripSecrets({ id: 1, password: undefined }) as Record<string, unknown>;
    expect(output).toHaveProperty('password');
    expect(output['password']).toBeUndefined();
    expect(output).not.toHaveProperty('password_redacted');
  });

  it('redacts a non-string secret too, since the shape is not the point', () => {
    const output = stripSecrets({ password: { value: SECRET_PASSWORD_VALUE } }) as Record<
      string,
      unknown
    >;

    expect(output['password']).toBeNull();
    expect(output['password_redacted']).toBe(true);
    expect(JSON.stringify(output)).not.toContain(SECRET_PASSWORD_VALUE);
  });

  it('lets our flag win over an upstream field of the same name', () => {
    // The flag asserts what this server did. Data from Hudu must not be able to
    // contradict it — a false `password_redacted: false` beside a null would
    // read as "no credential stored" for a record that has one.
    const output = stripSecrets({
      password: SECRET_PASSWORD_VALUE,
      password_redacted: false,
    }) as Record<string, unknown>;

    expect(output['password_redacted']).toBe(true);
  });

  it('does not hang on a cyclic payload', () => {
    const node: Record<string, unknown> = { password: SECRET_PASSWORD_VALUE };
    node['self'] = node;

    const output = stripSecrets(node);

    expect(output['password']).toBeNull();
    expect(output['password_redacted']).toBe(true);
    // The cycle is preserved structurally, pointing at the stripped copy rather
    // than at the original object, so the secret cannot be reached round the loop.
    expect(output['self']).toBe(output);
  });

  it('does not hang on a cycle through an array', () => {
    const list: unknown[] = [{ password: SECRET_PASSWORD_VALUE }];
    list.push(list);

    const output = stripSecrets(list);

    expect(output[1]).toBe(output);
    expect((output[0] as Record<string, unknown>)['password']).toBeNull();
  });

  it('leaves scalars and non-objects alone', () => {
    expect(stripSecrets('plain')).toBe('plain');
    expect(stripSecrets(7)).toBe(7);
    expect(stripSecrets(null)).toBeNull();
  });

  it('does not mutate the input', () => {
    const original = assetPasswordFixture();
    stripSecrets(original);
    expect(original['password']).toBe(SECRET_PASSWORD_VALUE);
    expect(original).not.toHaveProperty('password_redacted');
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

  // Regression: the walker used to exempt any string beginning "[withheld",
  // because that is what the old placeholder looked like. An exemption list is
  // a way to be fooled — a value shaped like the exemption walks straight
  // through — and there is no longer a placeholder to exempt. Any non-empty
  // string under a secret's name is a leak, full stop.
  it('reports a string that merely looks like the old placeholder', () => {
    expect(findSecretFields({ password: '[withheld: use hudu_reveal_password]' })).toEqual([
      '$.password',
    ]);
    expect(findSecretFields({ otp_secret: '[withheld] but actually real' })).toEqual([
      '$.otp_secret',
    ]);
  });

  it('ignores null and empty values, which carry no secret', () => {
    expect(findSecretFields({ password: null, otp_secret: '' })).toEqual([]);
  });

  it('ignores the redaction flag, which is a boolean under a different key', () => {
    expect(findSecretFields({ password: null, password_redacted: true })).toEqual([]);
  });

  it('finds nothing after stripSecrets has run, on the same payload', () => {
    const payload = { items: [assetPasswordFixture(1), assetPasswordFixture(2)] };
    expect(findSecretFields(payload)).toHaveLength(4);
    expect(findSecretFields(stripSecrets(payload))).toEqual([]);
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

  it('ignores null and empty values, which are nothing to scrub for', () => {
    expect(collectSecretValues({ a: { password: null }, b: { password: '' } })).toEqual([]);
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
    const output = redactSecretsInText(
      text,
      [SECRET_PASSWORD_VALUE, SECRET_OTP_VALUE],
      REDACTED_TEXT,
    );

    expect(output).not.toContain(SECRET_PASSWORD_VALUE);
    expect(output).not.toContain(SECRET_OTP_VALUE);
    expect(output.split(REDACTED_TEXT)).toHaveLength(4);
  });

  it('treats a secret as a literal, not a pattern', () => {
    // A stored password is arbitrary text; an escaping mistake in a regex-based
    // implementation would be a leak.
    expect(redactSecretsInText('a.*b', ['a.*b'], REDACTED_TEXT)).toBe(REDACTED_TEXT);
    expect(redactSecretsInText('axxb', ['a.*b'], REDACTED_TEXT)).toBe('axxb');
  });

  it('leaves the text alone when there is nothing to scrub', () => {
    expect(redactSecretsInText('nothing here', [], REDACTED_TEXT)).toBe('nothing here');
  });

  it('is short enough not to be mistaken for a value in its own right', () => {
    // The defect being avoided is a placeholder that reads like a credential.
    expect(REDACTED_TEXT.length).toBeLessThan(16);
  });
});
