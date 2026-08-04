import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'docs/reference/*.json'] },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Credential material must never reach stdout: on stdio, stdout is the
      // protocol channel, and a stray log line both corrupts the session and
      // risks echoing a token. Diagnostics go through process.stderr.write.
      'no-console': 'error',

      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // Tool handlers receive `Record<string, unknown>`, where bracket access is
      // the correct and type-safe form. Requiring dot notation there would mean
      // asserting a shape the SDK has already validated for us.
      '@typescript-eslint/dot-notation': 'off',
    },
  },

  {
    // Tests legitimately build malformed inputs to prove the guards work.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'no-console': 'off', '@typescript-eslint/explicit-function-return-type': 'off' },
  },

  prettier,
);
