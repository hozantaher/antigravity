// app-vozidla.smoke.spec.ts
//
// Smoke pack for UX — the Vozidla acquisition inventory TABLE.
// Per HARD RULE feedback_playwright_smoke_required. Runs against real local
// PROD data (BFF serves /api/vehicles). "Leady JSOU vozidla."

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

test('Vozidla renders the inventory table with rows', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')
  await expect(page.getByTestId('app-vozidla')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-vehicle-table')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-vehicle-row').first()).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('sorting by a column header reorders + toggles direction', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')
  const th = page.getByTestId('app-th-vehicle')
  await th.click()
  await expect(th).toHaveAttribute('aria-sort', 'ascending')
  await th.click()
  await expect(th).toHaveAttribute('aria-sort', 'descending')
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('clicking a row opens the detail aside + deep-links ?id, close clears it', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')
  await page.getByTestId('app-vehicle-row').first().click()
  await expect(page).toHaveURL(/[?&]id=\d+/)
  await expect(page.getByTestId('app-vehicle-detail')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Zavřít' }).click()
  await expect(page.getByTestId('app-vehicle-detail')).toBeHidden()
  expect(errs, errs.join('\n')).toHaveLength(0)
})

// Renders the pipeline status stepper with the current stage marked active.
// Does NOT click a stage — that PATCHes a real vehicle's status; the PATCH path
// is proven end-to-end against a synthetic vehicle + unit-tested separately.
test('detail aside shows the status stepper with current stage active', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')
  await page.getByTestId('app-vehicle-row').first().click()
  await expect(page.getByTestId('app-status-stepper')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('app-step-offered')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('app-step-picked_up')).toBeVisible()
  await expect(page.getByTestId('app-step-cancel')).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})
