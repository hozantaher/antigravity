// app-toptargets.smoke.spec.ts
//
// Top cíle — scored-prospect pool. Per HARD RULE
// feedback_playwright_smoke_required. Drives the real local stack (BFF :18001 +
// Go + Postgres): opens /cile, asserts the page renders with its headline +
// stat strip, then exercises a filter interaction (score tier + sector chip).
// Strict console gate: 0 errors. Read-only — no campaign is created.

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

test('Top cíle — renders + tier/sector filter interaction', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/cile')

  // Shell: root + headline + stat strip render immediately (data-independent).
  await expect(page.getByTestId('app-toptargets')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Top cíle' })).toBeVisible()
  await expect(page.getByTestId('app-toptargets-stats')).toBeVisible()
  // Filter card is collapsed by default (S3) — open the disclosure first.
  await page.getByTestId('app-toptargets-filter-toggle').click()
  await expect(page.getByTestId('app-toptargets-filters')).toBeVisible()

  // Interaction 1: filter by the "Vysoký" score tier.
  const tier = page.getByTestId('app-toptargets-tier-vysoky')
  await tier.click()
  await expect(tier).toHaveAttribute('aria-pressed', 'true')

  // Interaction 2: toggle a sector chip.
  const sector = page.getByTestId('app-toptargets-sector-machinery')
  await sector.click()
  await expect(sector).toHaveAttribute('aria-pressed', 'true')

  // The list resolves to either the prospect table or the calm empty state
  // (data-dependent — both are valid, the page must not hang on a skeleton).
  await expect(
    page.getByTestId('app-toptargets-table').or(page.getByTestId('app-toptargets-empty')),
  ).toBeVisible({ timeout: 15_000 })

  expect(errs, errs.join('\n')).toHaveLength(0)
})
