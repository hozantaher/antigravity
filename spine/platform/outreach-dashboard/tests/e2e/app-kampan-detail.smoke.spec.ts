// app-kampan-detail.smoke.spec.ts
//
// campaign editor — detail + full edit surface. Per HARD RULE
// feedback_playwright_smoke_required. Drives real local PROD data: opens the
// first campaign from /kampane and asserts the editor renders with all
// sections + no console errors. Edit interaction is exercised non-destructively
// (open Identita editor, no save — a fresh page per test mutates nothing).

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

test('Kampaň detail — editor renders all sections', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  // Enter via the list so we also cover the card → detail link.
  await page.goto('/kampane')
  const firstLink = page.getByTestId('app-campaign-link').first()
  await expect(firstLink).toBeVisible({ timeout: 15_000 })
  await firstLink.click()

  // Detail shell + status + KPIs.
  await expect(page.getByTestId('app-kampan-detail')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('kd-status')).toBeVisible()
  await expect(page.getByTestId('kd-kpis')).toBeVisible()

  // All editor sections present (incl. the machinery-priority panel, 2026-06-26).
  for (const id of ['kd-identity', 'kd-audience', 'kd-sequence', 'kd-priority', 'kd-pacing', 'kd-window', 'kd-staircase', 'kd-danger']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }

  // Priority panel renders its tier breakdown + the re-score action (visible
  // only — clicking it would reprice real local PROD data, so the smoke does
  // not mutate).
  await expect(page.getByTestId('kd-priority-tiers')).toBeVisible()
  await expect(page.getByTestId('kd-rescore')).toBeVisible()

  // Identity is always editable (non-structural). Open the inline editor.
  await page.getByTestId('kd-identity').getByTestId('kd-edit').click()
  await expect(page.getByTestId('kd-name')).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Kampaň detail — unknown id shows not-found, no crash', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/kampane/99999999')
  await expect(page.getByTestId('kd-error')).toBeVisible({ timeout: 15_000 })
  // This test deliberately loads a missing campaign → the BFF returns 404 and
  // the browser logs a benign "Failed to load resource: 404". That single line
  // is the expected outcome here; the strict gate still catches everything else
  // (uncaught pageerrors, other 4xx/5xx).
  const realErrs = errs.filter((e) => !/Failed to load resource.*404/.test(e))
  expect(realErrs, realErrs.join('\n')).toHaveLength(0)
})
