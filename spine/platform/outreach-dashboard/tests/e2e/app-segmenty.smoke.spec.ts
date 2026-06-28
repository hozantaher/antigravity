// app-segmenty.smoke.spec.ts
//
// Segmenty (saved filters / segment list) — list surface. Per HARD RULE
// feedback_playwright_smoke_required. Drives real local data: opens
// /segmenty and asserts the list shell renders (head + stat strip + either
// the segment list or the calm empty state) with no console errors. The single
// interaction is a NON-DESTRUCTIVE refresh (re-GET, no mutation) — rebuild /
// delete are deliberately NOT exercised so a smoke run never mutates data.

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

test('Segmenty — list shell renders + refresh', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/segmenty')

  // Shell: root + headline + stat strip are always present, data-independent.
  await expect(page.getByTestId('app-segmenty')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Segmenty' })).toBeVisible()
  await expect(page.getByTestId('app-segmenty-stats')).toBeVisible()

  // "Nový segment" wires to the builder route (sibling page). Verify the href
  // WITHOUT navigating — that page may not be mounted yet in this branch.
  await expect(page.getByTestId('app-segmenty-new')).toHaveAttribute('href', '/segmenty/novy')

  // One non-destructive interaction: refresh re-GETs the segment list.
  await page.getByTestId('app-segmenty-refresh').click()

  // Data state settles to either the populated list or the calm empty state.
  const list = page.getByTestId('app-segmenty-list')
  const empty = page.getByTestId('app-segmenty-empty')
  await expect(list.or(empty)).toBeVisible({ timeout: 15_000 })

  expect(errs, errs.join('\n')).toHaveLength(0)
})
