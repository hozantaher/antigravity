// app-anonymita.smoke.spec.ts
//
// Diagnostika anonymity — anonymity probe matrix. Per HARD RULE
// feedback_playwright_smoke_required. Drives real local PROD data: loads
// /anonymita and asserts the probe matrix renders with no console errors.
// The "Spustit test" action is asserted visible+enabled but NEVER clicked —
// clicking fires the real, slow 4-binary probe chain (POST /api/anonymity/run).
//
// NOTE: passes once the /anonymita route is wired into main.jsx + the nav
// item lands in AppShell (integration phase). This spec is the contract that
// wiring must satisfy.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

// operator_id cookie satisfies BOTH the BFF auth middleware AND the dev-only
// Firebase auth seam in authStore.js (import.meta.env.DEV + operator_id cookie).
async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}
function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  return errs
}

test('Diagnostika anonymity — probe matrix renders', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/anonymita')

  // Page shell + headline.
  await expect(page.getByTestId('app-anonymita')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Diagnostika anonymity' })).toBeVisible()

  // Run action present but NOT clicked — clicking triggers real probes.
  const run = page.getByTestId('app-anonymita-run')
  await expect(run).toBeVisible()
  await expect(run).toBeEnabled()

  // Probe matrix renders with at least one mailbox row.
  await expect(page.getByTestId('app-anonymita-matrix')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-anonymita-row').first()).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})
