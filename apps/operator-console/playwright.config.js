import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:18175',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Předpokládá že dev server + API server již běží
  webServer: [
    {
      command: 'pnpm dev',
      url: 'http://localhost:18175',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
})
