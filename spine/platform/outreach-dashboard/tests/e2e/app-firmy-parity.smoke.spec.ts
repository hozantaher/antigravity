// app-firmy-parity.smoke.spec.ts
//
// Firmy — prospecting directory brought to twin-parity with
// src/pages/Companies.jsx. Per HARD RULE feedback_playwright_smoke_required.
// Drives the real local BFF (/api/companies) and asserts the page renders its
// frame (search + filters), the list settles into a terminal state (rows /
// empty / error), and selecting a row reveals the bulk action bar with the
// launch + verify-email + export controls. Read-only: the smoke selects a row
// (safe — global checkbox guard) but NEVER clicks verify-email / export, so it
// mutates nothing. Tolerates the prod DB's intermittent heavy-scan 500 + benign
// resource 404s by asserting a terminal list state instead of green-on-blind.

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

// Real (non-benign) console errors. Tolerate browser resource-load logs for
// 404 (optional endpoints e.g. score-trends) and the documented heavy-scan 500
// on /api/companies; never tolerate pageerrors (React crashes).
function realErrors(errs: string[]): string[] {
  return errs.filter((e) => {
    if (/Failed to load resource/i.test(e) && /(404|500)/.test(e)) return false
    if (/favicon|sourcemap|\.map\b/i.test(e)) return false
    return true
  })
}

test('Firmy — renders frame + list settles into a terminal state', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/firmy')

  // Shell + the directory toolbar (search + filter chips).
  await expect(page.getByTestId('app-firmy')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-company-search')).toBeVisible()
  await expect(page.getByTestId('app-firmy-filters')).toBeVisible()

  // List must reach one of the three terminal states (not stuck on skeleton).
  const row = page.getByTestId('app-company-row').first()
  const empty = page.getByTestId('app-companies-list-empty')
  const error = page.getByTestId('app-companies-list-error')
  await expect(row.or(empty).or(error)).toBeVisible({ timeout: 15_000 })

  // Empty detail aside present until a firma is opened.
  await expect(page.getByTestId('app-company-empty')).toBeVisible()

  expect(realErrors(errs), realErrors(errs).join('\n')).toHaveLength(0)
})

test('Firmy — advanced filters toggle + selecting a row reveals the bulk bar', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/firmy')

  await expect(page.getByTestId('app-firmy')).toBeVisible({ timeout: 15_000 })

  // Advanced firmographic filters open without crashing.
  await page.getByTestId('app-firmy-advanced-toggle').click()
  await expect(page.getByTestId('app-firmy-advanced')).toBeVisible()
  await expect(page.getByTestId('app-firmy-size-1-9')).toBeVisible()

  // Settle the list.
  const row = page.getByTestId('app-company-row').first()
  const empty = page.getByTestId('app-companies-list-empty')
  const error = page.getByTestId('app-companies-list-error')
  await expect(row.or(empty).or(error)).toBeVisible({ timeout: 15_000 })

  const firstCheckbox = page.locator('[data-testid^="app-firmy-select-"]').first()
  const hasRows = await firstCheckbox.isVisible().catch(() => false)

  if (hasRows) {
    // Export control is present in the toolbar whenever rows render.
    await expect(page.getByTestId('app-firmy-export')).toBeVisible()

    // Select a row (safe — global checkbox guard; does NOT open the detail).
    await firstCheckbox.check()

    // Bulk bar appears with launch + verify-email controls. PRESENCE ONLY —
    // we never click verify-email / export (they mutate / download).
    await expect(page.getByTestId('app-firmy-bulkbar')).toBeVisible()
    await expect(page.getByTestId('app-firmy-bulk-launch')).toBeVisible()
    await expect(page.getByTestId('app-firmy-bulk-verify')).toBeVisible()
    await expect(page.getByTestId('app-firmy-bulk-clear')).toBeVisible()
  } else {
    // Degraded (empty / heavy-scan 500) — terminal state is enough.
    await expect(empty.or(error)).toBeVisible()
  }

  expect(realErrors(errs), realErrors(errs).join('\n')).toHaveLength(0)
})
