// app-crm-parity.smoke.spec.ts
//
// CRM klienti — twin-parity surface (pipeline stat strip + import freshness +
// facet filters + paginated directory + detail card with linked kontakty/firmy/
// vozidla). Per HARD RULE feedback_playwright_smoke_required. Drives the real
// local BFF (/api/crm/clients{,/:id,/stats,/freshness} + /api/vehicles) and
// asserts the page renders its frame (headline + stat strip + directory) with no
// console errors. Companion to app-crm.smoke.spec.ts — read-only, mutates nothing.

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

// Collect real console/page errors but tolerate benign resource 404s (a
// search-/filter-driven endpoint legitimately 404s as "no results"; useResource
// treats those as empty, not an error).
function watchConsole(page: Page): string[] {
  const errs: string[] = []
  const benign = (t: string) => /favicon|404|Failed to load resource/i.test(t)
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !benign(m.text())) errs.push(`console.error: ${m.text()}`) })
  return errs
}

test('CRM parity — frame, stat strip, directory render', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/crm')

  // Page shell + headline.
  await expect(page.getByTestId('app-crm-page')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { level: 1, name: /CRM klienti/i })).toBeVisible()

  // Pipeline stat strip is always present (Celkem cell + per-status cells).
  await expect(page.getByTestId('app-crm-stats')).toBeVisible()

  // The directory split + its search box.
  await expect(page.getByTestId('app-crm')).toBeVisible()
  await expect(page.getByTestId('app-crm-search')).toBeVisible()

  // The list settles into a terminal state: rows, empty, or inline error.
  const row = page.getByTestId('app-crm-row').first()
  const empty = page.getByTestId('app-crm-list-empty')
  const err = page.getByTestId('app-crm-list-error')
  await expect(row.or(empty).or(err)).toBeVisible({ timeout: 15_000 })

  // Detail aside shows the calm "pick a client" empty state on first load.
  await expect(page.getByTestId('app-crm-empty')).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('CRM parity — filters + refresh re-query without crashing', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/crm')

  await expect(page.getByTestId('app-crm-page')).toBeVisible({ timeout: 15_000 })

  // "S e-mailem" toggle is rendered whenever the filter bar is present.
  const filters = page.getByTestId('app-crm-filters')
  if (await filters.isVisible().catch(() => false)) {
    await page.getByTestId('app-crm-hasemail').click()
    await expect(page.getByTestId('app-crm-stats')).toBeVisible()
    // A status facet chip, if any, re-queries the directory.
    const statusChip = page.getByTestId('app-crm-status-filter').first()
    if (await statusChip.isVisible().catch(() => false)) {
      await statusChip.click()
      await expect(page.getByTestId('app-crm')).toBeVisible()
    }
  }

  // Refresh re-pulls list + stats + freshness without error.
  await page.getByTestId('app-crm-refresh').click()
  await expect(page.getByTestId('app-crm-stats')).toBeVisible()

  expect(errs, errs.join('\n')).toHaveLength(0)
})
