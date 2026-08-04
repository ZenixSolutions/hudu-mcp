import { defineConfig } from 'vitest/config';

/**
 * Test runner configuration.
 *
 * `tests/helpers` holds shared fixtures rather than specs, so the include
 * pattern is explicit about what counts as a test file. Nothing here reaches
 * the network: the only suite permitted to do so is `tests/contract`, which
 * skips itself unless `HUDU_CONTRACT_TESTS=1` and real credentials are present.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The installation suite may have to build the package first.
    hookTimeout: 180_000,
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/transport/**'],
    },
  },
});
