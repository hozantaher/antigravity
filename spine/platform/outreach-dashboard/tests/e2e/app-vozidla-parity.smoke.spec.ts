// app-vozidla-parity.smoke.spec.ts
//
// Parity smoke for the Vozidla inventory once it absorbed /vehicles +
// /vehicles/:id (search + make/price filters, editable deal prices/marže +
// notes, status stepper). Per HARD RULE feedback_playwright_smoke_required.
// Drives the real local BFF (/api/vehicles) against PROD data. READ-ONLY: it
// asserts presence of the mutating controls but never saves a price / advances
// status / edits notes (those PATCH real vehicles — proven separately).

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

test('Vozidla — parity frame: toolbar + filters + table render', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')

  await expect(page.getByTestId('app-vozidla')).toBeVisible({ timeout: 15_000 })
  // New parity toolbar — search + make filter + price-range inputs.
  await expect(page.getByTestId('app-vozidla-toolbar')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-search')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-make-filter')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-price-min')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-price-max')).toBeVisible()
  // Existing surface preserved: table + at least one row.
  await expect(page.getByTestId('app-vehicle-table')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-vehicle-row').first()).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Vozidla — search filters the list (and reset restores it)', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')

  await expect(page.getByTestId('app-vehicle-table')).toBeVisible({ timeout: 15_000 })

  // A gibberish term matches no real vehicle → the filtered-empty state shows,
  // which deterministically proves the search re-filters the loaded list.
  await page.getByTestId('app-vehicle-search').fill('zzqx-nonexistent-vehicle-9931')
  await expect(page.getByTestId('app-vozidla-empty-filtered')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('app-vehicle-reset-filters')).toBeVisible()

  // Reset → table returns.
  await page.getByTestId('app-vehicle-reset-filters').click()
  await expect(page.getByTestId('app-vehicle-table')).toBeVisible({ timeout: 10_000 })

  expect(errs, errs.join('\n')).toHaveLength(0)
})

// Opens the detail aside and asserts the parity controls are PRESENT — the
// pipeline stepper + the three editable deal prices + the computed margin.
// Does NOT save / advance / edit — those PATCH a real vehicle.
test('Vozidla — detail aside shows stepper + editable price fields', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')

  await page.getByTestId('app-vehicle-row').first().click()
  await expect(page.getByTestId('app-vehicle-detail')).toBeVisible({ timeout: 10_000 })

  // Status stepper (advance flow) present with a current stage marked.
  await expect(page.getByTestId('app-status-stepper')).toBeVisible()
  await expect(page.getByTestId('app-step-cancel')).toBeVisible()

  // Editable price/margin block present (buy/sell/margin parity with v1).
  await expect(page.getByTestId('app-vehicle-prices')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-price-asking')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-price-offered')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-price-agreed')).toBeVisible()
  await expect(page.getByTestId('app-vehicle-margin')).toBeVisible()
  // Editable notes present.
  await expect(page.getByTestId('app-vehicle-notes')).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})
