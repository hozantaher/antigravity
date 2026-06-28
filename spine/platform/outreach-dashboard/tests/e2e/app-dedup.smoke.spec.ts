// app-dedup.smoke.spec.ts
//
// Ochrana proti duplicitám (Dedup Guard) — block-axes + segment eligibility
// funnel surface. Per HARD RULE feedback_playwright_smoke_required. Drives the
// real local BFF (/api/dedup-guard/*) and asserts the page renders its frame
// (headline + stat strip + block-axes + funnel section) with no console errors.
// Read-only surface — the smoke mutates nothing.

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

test('Dedup — page renders frame, stat strip, axes + funnel', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/dedup')

  // Shell + headline.
  await expect(page.getByTestId('app-dedup')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { level: 1, name: /duplicit/i })).toBeVisible()

  // Stat strip (4 cells) + the two core visualizations.
  await expect(page.getByTestId('app-dedup-stats')).toBeVisible()
  // Block-axes appears once stats load (or its calm empty/error variant); the
  // funnel section wrapper is always present. Assert the funnel; then assert the
  // axes settle into one of the three terminal states (not stuck on skeleton).
  await expect(page.getByTestId('app-dedup-funnel')).toBeVisible()
  await expect(page.getByTestId('app-dedup-segment-input')).toBeVisible()

  const axes = page.getByTestId('app-dedup-axes')
  const axesEmpty = page.getByTestId('app-dedup-axes-empty')
  const axesError = page.getByTestId('app-dedup-axes-error')
  await expect(axes.or(axesEmpty).or(axesError)).toBeVisible({ timeout: 15_000 })

  // Recent skips table frame.
  await expect(page.getByTestId('app-dedup-skips')).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Dedup — window chips re-query without crashing', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/dedup')

  await expect(page.getByTestId('app-dedup')).toBeVisible({ timeout: 15_000 })

  // Switch the stats time-window — exercises the useResource URL re-fetch path.
  await page.getByTestId('app-dedup-window-7d').click()
  await expect(page.getByTestId('app-dedup-stats')).toBeVisible()
  await page.getByTestId('app-dedup-window-all').click()
  await expect(page.getByTestId('app-dedup-stats')).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})
