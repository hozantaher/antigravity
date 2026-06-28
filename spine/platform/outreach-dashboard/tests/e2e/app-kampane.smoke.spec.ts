// app-kampane.smoke.spec.ts
//
// UX Phase 6 — the Kampaně overview (read-only). Per HARD RULE
// feedback_playwright_smoke_required. Real local PROD data (campaign 457).
// No send controls asserted — campaign send needs explicit consent.

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

test('Kampaně renders a campaign card with delivery stats', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/kampane')
  await expect(page.getByTestId('app-kampane')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-campaign-card').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Odesláno')).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})
