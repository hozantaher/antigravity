// app-nastaveni.smoke.spec.ts
//
// Nastavení — operator config surface (Entita & brand / ICP sektory /
// Provozní pravidla) rebuilt on the frame. Per HARD RULE
// feedback_playwright_smoke_required. Drives the real local BFF
// (/api/operator-settings + /api/icp-sectors) and asserts the page renders its
// frame (headline + tab bar) and that each of the 3 tabs renders its form with
// a Save button present. READ-ONLY: the smoke must NOT mutate operator settings,
// so it asserts the Save button is present but never clicks it.

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

test('Nastavení — page renders frame, tab bar + default branding form', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/nastaveni')

  // Shell + headline.
  await expect(page.getByTestId('app-nastaveni')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Nastavení' })).toBeVisible()

  // Tab bar with all 3 tabs.
  await expect(page.getByTestId('app-nastaveni-tabs')).toBeVisible()
  await expect(page.getByTestId('app-nastaveni-tab-branding')).toBeVisible()
  await expect(page.getByTestId('app-nastaveni-tab-icp')).toBeVisible()
  await expect(page.getByTestId('app-nastaveni-tab-thresholds')).toBeVisible()

  // Default tab = Entita & brand. Form + Save button render (do NOT click).
  await expect(page.getByTestId('app-nastaveni-branding')).toBeVisible()
  await expect(page.getByTestId('app-nastaveni-save-branding')).toBeVisible({ timeout: 15_000 })

  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Nastavení — each tab renders its form + Save (no mutation)', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/nastaveni')

  await expect(page.getByTestId('app-nastaveni')).toBeVisible({ timeout: 15_000 })

  // ICP sektory tab.
  await page.getByTestId('app-nastaveni-tab-icp').click()
  await expect(page.getByTestId('app-nastaveni-icp')).toBeVisible()
  await expect(page.getByTestId('app-nastaveni-save-icp')).toBeVisible({ timeout: 15_000 })

  // Provozní pravidla tab.
  await page.getByTestId('app-nastaveni-tab-thresholds').click()
  await expect(page.getByTestId('app-nastaveni-thresholds')).toBeVisible()
  await expect(page.getByTestId('app-nastaveni-save-thresholds')).toBeVisible({ timeout: 15_000 })

  // Back to branding — confirms tab switching does not crash.
  await page.getByTestId('app-nastaveni-tab-branding').click()
  await expect(page.getByTestId('app-nastaveni-branding')).toBeVisible()

  // Save button present but never clicked — smoke mutates nothing.
  expect(errs, errs.join('\n')).toHaveLength(0)
})
