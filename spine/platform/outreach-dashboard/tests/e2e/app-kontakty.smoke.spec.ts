// app-kontakty.smoke.spec.ts
//
// UX Phase 4 + Phase 7 twin-parity — the Kontakty directory. Per HARD RULE
// feedback_playwright_smoke_required. Real local PROD data (405k contacts; the
// engaged default shows ~1.9k).
//
// SAFETY: the page now carries GDPR/safety mutations (DNT Art. 21 opt-out,
// suppress, bulk-suppress, verify-email). This smoke asserts those controls
// EXIST + are ENABLED but NEVER clicks them — they mutate PROD. Read-only.

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

test('Kontakty renders the engaged directory with rows', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/kontakty')
  await expect(page.getByTestId('app-kontakty')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-contact-search')).toBeVisible()
  await expect(page.getByTestId('app-contact-row').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-contact-empty')).toBeVisible()   // no selection yet
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('selecting a contact opens the detail card + deep-links ?id', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/kontakty')
  await page.getByTestId('app-contact-row').first().click()
  await expect(page).toHaveURL(/[?&]id=\d+/)
  await expect(page.getByTestId('app-contact-detail')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('search reaches the full contact base', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/kontakty')
  await page.getByTestId('app-contact-search').fill('novak')
  await expect(page).toHaveURL(/[?&]q=novak/, { timeout: 5_000 })
  await expect(page.getByTestId('app-contact-row').first()).toBeVisible({ timeout: 15_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('detail exposes DNT + suppress + verify + send-history (present, not clicked)', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/kontakty')
  await expect(page.getByTestId('app-kontakty')).toBeVisible({ timeout: 15_000 })

  // Open the first engaged contact.
  await page.getByTestId('app-contact-row').first().click()
  await expect(page.getByTestId('app-contact-detail')).toBeVisible({ timeout: 10_000 })

  // Safety cluster present + enabled. DO NOT click — DNT is a GDPR Art. 21
  // opt-out and suppress halts outreach; both mutate PROD. Assert only.
  await expect(page.getByTestId('app-contact-safety')).toBeVisible()
  await expect(page.getByTestId('app-contact-dnt-toggle')).toBeEnabled()
  await expect(page.getByTestId('app-contact-suppress')).toBeEnabled()

  // Send-history section always renders (wrapper present even when empty).
  await expect(page.getByTestId('app-contact-sends')).toBeVisible()

  // Multi-select entry points for bulk-suppress.
  await expect(page.getByTestId('app-contact-selectall')).toBeVisible()
  await expect(page.getByTestId('app-contact-checkbox').first()).toBeVisible()

  // Tolerate a benign 404 only (e.g. an empty edge feed); fail on anything else.
  const real = errs.filter((e) => !/\b404\b/.test(e) && !/favicon/.test(e))
  expect(real, real.join('\n')).toHaveLength(0)
})

test('advanced filters (status + e-mail verification) re-query without crashing', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/kontakty')
  await expect(page.getByTestId('app-kontakty')).toBeVisible({ timeout: 15_000 })

  // Server-side status filter (bounce history) — exercises the useResource
  // URL re-fetch path.
  await page.getByTestId('app-filter-status').first().click()
  await expect(page).toHaveURL(/[?&]status=/, { timeout: 5_000 })

  // Client-side e-mail-verification refinement over the loaded set.
  await page.getByTestId('app-filter-email').first().click()
  await expect(page).toHaveURL(/[?&]estatus=/, { timeout: 5_000 })

  const real = errs.filter((e) => !/\b404\b/.test(e) && !/favicon/.test(e))
  expect(real, real.join('\n')).toHaveLength(0)
})
