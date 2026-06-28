// app-discoverability.smoke.spec.ts
//
// The topbar carries a 'UX →' entry point so the (complete, clean)
// parallel app is reachable without typing the URL. Per HARD RULE
// feedback_playwright_smoke_required.

import { test, expect, Page } from '@playwright/test'

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

test('topbar exposes a working UX entry point', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await ensureLoggedIn(page)
  await page.goto('/')
  const link = page.getByTestId('topbar-app-link')
  await expect(link).toBeVisible({ timeout: 15_000 })
  await link.click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})
