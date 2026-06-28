import { test, expect, assertClean } from './_fixtures/console-guard'

// Visit each route in the dashboard, exercise basic interaction,
// fail if any console.error / pageerror / failed XHR fires.
//
// F2c — Dashboard removed; `/` redirects to `/replies?handled=false`.
// We keep `/` in the list so the redirect itself is exercised.
const ROUTES = [
  { path: '/',          name: 'Index → Odpovědi' },
  { path: '/mailboxes', name: 'Schránky' },
  { path: '/campaigns', name: 'Kampaně' },
  { path: '/contacts',  name: 'Kontakty' },
  { path: '/segments',  name: 'Segmenty' },
  { path: '/templates', name: 'Šablony' },
  { path: '/replies',   name: 'Odpovědi' },
  { path: '/analytics', name: 'Analýzy' },
  { path: '/companies', name: 'Firmy' },
  { path: '/watchdog',  name: 'Watchdog' },
]

for (const r of ROUTES) {
  test(`console-clean: ${r.path} (${r.name})`, async ({ page, errs }) => {
    await page.goto(r.path)
    // Wait for the topbar title (proof React mounted) + idle for late XHRs.
    await expect(page.locator('.topbar-title')).toBeVisible({ timeout: 10_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    assertClean(errs)
  })
}
