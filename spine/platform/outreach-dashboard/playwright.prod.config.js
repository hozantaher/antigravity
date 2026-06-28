import { defineConfig, devices } from '@playwright/test'

// ============================================================================
// PRODUCTION E2E CONFIG — targets the LIVE dashboard.
// Run explicitly:  pnpm exec playwright test --config=playwright.prod.config.js
// NEVER wired into `pnpm e2e` (which is local-only). No webServer is started.
//
// Safety: every spec installs the network kill-switch (tests/e2e-prod/_guard).
// workers=1 + retries=0 keep Firebase auth attempts minimal and the audit
// ledger output linear/readable.
// ============================================================================

const PROD_URL = process.env.PROD_E2E_URL || 'https://outreach.auction24.cz'

export default defineConfig({
  testDir: './tests/e2e-prod',
  timeout: 45_000,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'reports/e2e-prod/results.json' }],
    ['html', { outputFolder: 'playwright-report-prod', open: 'never' }],
  ],
  outputDir: 'test-results-prod',
  use: {
    baseURL: PROD_URL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    // Offline classifier sanity — no prod contact, no auth.
    {
      name: 'unit',
      testMatch: /safety-guard\.unit\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // One real Firebase login → persisted storage state.
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Positive flows reuse the authenticated session.
    {
      name: 'authed',
      testMatch: /positive\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: 'tests/e2e-prod/.auth/state.json' },
    },
    // Negative flows run logged-OUT (fresh state, no dependency).
    {
      name: 'anon',
      testMatch: /negative\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
