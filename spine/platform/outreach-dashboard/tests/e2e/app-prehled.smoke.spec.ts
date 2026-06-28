// app-prehled.smoke.spec.ts
//
// UX — the Přehled (Home) live pipeline glance. Per HARD RULE
// feedback_playwright_smoke_required. Real local PROD data; the cards pull
// live counts from the same endpoints the surfaces use.

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

test('Přehled renders the three live pipeline cards', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/')
  await expect(page.getByTestId('app-home')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-home-card-Odpovědi')).toBeVisible()
  await expect(page.getByTestId('app-home-card-Vozidla')).toBeVisible()
  await expect(page.getByTestId('app-home-card-Kampaň')).toBeVisible()
  // Kvalita dat card — landing now links to the úkolovník.
  await expect(page.getByTestId('app-home-card-Kvalita dat')).toBeVisible()
  await expect(page.getByTestId('app-home-card-Kvalita dat')).toHaveAttribute('href', '/kvalita')
  // Live data settles to a real number, never a false 0 placeholder dash.
  await expect(page.getByTestId('app-home-card-Odpovědi')).toContainText('nevyřízených', { timeout: 15_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Přehled cards link to their surfaces', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/')
  await page.getByTestId('app-home-card-Vozidla').click()
  await expect(page).toHaveURL(/\/vozidla$/)
  await expect(page.getByTestId('app-vozidla')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Přehled surfaces the aging hot-backlog age', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await ensureLoggedIn(page)
  await page.goto('/')
  // Topbar pipeline-heartbeat: "kdy se naposledy vyzvedly data".
  await expect(page.getByTestId('app-ingest-freshness')).toBeVisible({ timeout: 12_000 })
  // The hot backlog is weeks old in prod → the urgency note renders (stale tier
  // reads "stydne", nag tier "čeká"; both name the aging "zájem" + a day count).
  await expect(page.getByTestId('app-home-oldest-hot')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-home-oldest-hot')).toContainText(/nejstarší zájem.*dn[íy]/)
  // The Odpovědi card deep-links straight into the triage lane.
  await expect(page.getByTestId('app-home-card-Odpovědi')).toHaveAttribute('href', /mode=hot/)
  expect(errs, errs.join('\n')).toHaveLength(0)
})
