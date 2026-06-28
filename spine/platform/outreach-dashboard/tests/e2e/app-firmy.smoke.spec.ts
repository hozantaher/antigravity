// app-firmy.smoke.spec.ts
//
// UX Phase 5 — the Firmy prospecting directory. Per HARD RULE
// feedback_playwright_smoke_required. Real local PROD data (426k companies).

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

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

test('Firmy renders the directory + search box', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/firmy')
  await expect(page.getByTestId('app-firmy')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-company-search')).toBeVisible()
  await expect(page.getByTestId('app-company-row').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-company-empty')).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('selecting a company opens the card with its vehicles section', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/firmy')
  await page.getByTestId('app-company-row').first().click()
  await expect(page).toHaveURL(/[?&]ico=/)
  await expect(page.getByTestId('app-company-detail')).toBeVisible({ timeout: 10_000 })
  // The Vozidla section header is always rendered (count may be 0).
  await expect(page.getByText(/^Vozidla \(/)).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('search filters the company base', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/firmy')
  await page.getByTestId('app-company-search').fill('trans')
  await expect(page).toHaveURL(/[?&]q=trans/, { timeout: 5_000 })
  await expect(page.getByTestId('app-company-row').first()).toBeVisible({ timeout: 15_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Firmy ICP filter segments the base (data-mining)', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await ensureLoggedIn(page)
  await page.goto('/firmy')
  await expect(page.getByTestId('app-firmy-filters')).toBeVisible({ timeout: 12_000 })
  await page.getByTestId('app-firmy-icp-good').click()
  await expect(page).toHaveURL(/[?&]icp=good/)
  await expect(page.getByTestId('app-firmy-icp-good')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('app-company-row').first()).toBeVisible({ timeout: 12_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})
