/**
 * Dedicated Jest config for the Platform Contract test suite.
 *
 * Runs against a REAL Postgres — separate from the fast unit-style
 * `npm test` because these tests need migrations, TRUNCATE CASCADE
 * cycles, and a full DI graph. Sequential (`--runInBand`) so tests
 * don't stomp on each other's baseline seed.
 *
 * Skipped when `DATABASE_URL` is unset — the harness throws with a
 * helpful message in that case.
 *
 * Invoke via:  npm run test:platform
 */

module.exports = {
  displayName: 'platform-contract',
  rootDir: '.',
  testMatch: ['<rootDir>/test/platform-contract/**/*.spec.ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleFileExtensions: ['js', 'json', 'ts'],
  testEnvironment: 'node',
  // Longer timeout — DI bootstrap + migrations + TRUNCATE cycles are
  // substantially slower than unit tests. Each scenario file boots the
  // module once (beforeAll) and resets DB per test (beforeEach).
  testTimeout: 60000,
  // Run sequentially — the harness truncates the whole schema between
  // tests and mutates ENV vars during bootstrap.
  maxWorkers: 1,
  // Print each scenario as it runs so CI logs are legible when a
  // scenario is the failure boundary.
  verbose: true,
};
