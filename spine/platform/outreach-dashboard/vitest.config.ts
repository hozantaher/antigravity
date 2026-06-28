// Single unified vitest config — Phase 0 of "Tests as Heart of App" initiative.
// Tests organized under tests/. Use TEST_SCOPE env var to filter:
//   pnpm test                # default = unit + audit + chaos + property
//   pnpm test:contract       # contract project (BFF mocks)
//   pnpm test:integration    # integration project (pg-mem)
//   pnpm test:e2e            # Playwright (separate config)
//   pnpm test:all            # everything except real-server legacy
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

const SCOPE = process.env.TEST_SCOPE || 'default'

// Global egress guard — MUST be the first setup file in every scope so its
// env scrub + fetch guard run before any test imports server.js. See
// tests/setup/no-prod-egress.js (incident 2026-06-25: tests leaked campaigns to
// prod). Enforced by tests/audit/no-prod-egress.test.js.
const NO_PROD_EGRESS = './tests/setup/no-prod-egress.js'

const COMMON_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.stryker-tmp/**',
  '**/tests/e2e/**',
]

const REAL_SERVER_TESTS = [
  'tests/unit/legacy/server.test.js',
  'tests/unit/legacy/server.integration.test.js',
  'tests/unit/legacy/server.automation.test.js',
  'tests/unit/legacy/api.contracts.test.js',
  'tests/unit/legacy/api.snapshot.test.js',
  'tests/unit/legacy/api.differential.test.js',
  'tests/unit/legacy/api.nplus1.test.js',
  'tests/unit/legacy/race.matrix.test.js',
  'tests/unit/legacy/replay.diff.test.js',
  'tests/unit/legacy/shadow.replay.test.js',
  'tests/unit/legacy/chaos.test.js',
  'tests/unit/legacy/chaos.fault.test.js',
  'tests/unit/legacy/security.test.js',
  'tests/unit/legacy/idempotency.test.js',
  'tests/unit/legacy/db.constraints.test.js',
]

const SCOPES = {
  default: {
    include: [
      'tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/audit/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/chaos/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/property/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/regression/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/synthetic/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: [...COMMON_EXCLUDE, ...REAL_SERVER_TESTS, '**/tests/contract/**', '**/tests/integration/**'],
    environment: 'jsdom' as const,
    setupFiles: [NO_PROD_EGRESS, './src/test/polyfill.js', './src/test/setup.js'],
  },
  contract: {
    include: ['tests/contract/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [...COMMON_EXCLUDE, '**/setup.ts'],
    environment: 'node' as const,
    setupFiles: [NO_PROD_EGRESS, './tests/contract/setup.ts'],
  },
  integration: {
    include: ['tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: COMMON_EXCLUDE,
    environment: 'node' as const,
    setupFiles: [NO_PROD_EGRESS],
  },
  all: {
    include: [
      'tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/audit/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/chaos/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/property/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/contract/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: [...COMMON_EXCLUDE, ...REAL_SERVER_TESTS, '**/setup.ts'],
    environment: 'jsdom' as const,
    setupFiles: [NO_PROD_EGRESS, './src/test/polyfill.js', './src/test/setup.js'],
  },
}

const cfg = SCOPES[SCOPE as keyof typeof SCOPES] || SCOPES.default

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '~': resolve(__dirname, 'src') } },
  test: {
    environment: cfg.environment,
    globals: true,
    setupFiles: cfg.setupFiles,
    include: cfg.include,
    exclude: cfg.exclude,
    // Under `all` scope, contract tests share the process with unit tests.
    // The contract setup file (./tests/contract/setup.ts) runs only when
    // SCOPE === 'contract', so under `all` we lift its env defaults here so
    // BFF route handlers don't 401/429 on cross-suite cold start. Unit tests
    // that exercise the auth/rate-limit middleware directly clear these vars
    // explicitly in beforeEach (see authMiddleware.test.js, rateLimitMiddleware.test.js).
    env:
      SCOPE === 'contract' || SCOPE === 'all'
        ? { BFF_AUTH_DISABLED: '1', BFF_RATE_LIMIT_DISABLED: '1' }
        : {},
    testTimeout: 15_000,
    // H8 — Test runtime healing: retry once on transient flake (network/timing).
    // Only on CI (CI=true). Local dev runs without retry to surface flakiness fast.
    retry: process.env.CI === 'true' ? 1 : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
