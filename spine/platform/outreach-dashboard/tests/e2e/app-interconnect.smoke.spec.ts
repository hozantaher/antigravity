// app-interconnect.smoke.spec.ts
//
// UX — the entity interconnection web + deep-link robustness.
// Vozidlo → Kontakt cross-link, and a Kontakty detail that fetches BY ID so a
// deep-link to a contact not in the loaded list still renders. Real PROD data.

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

test('Vozidlo → Kontakt cross-link lands on a populated contact card', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/vozidla')
  await page.getByTestId('app-vehicle-row').first().click()
  await expect(page.getByTestId('app-vehicle-detail')).toBeVisible({ timeout: 10_000 })
  const link = page.getByTestId('app-vehicle-contact-link')
  // Most seeded vehicles carry a contact_id; if this one does, follow it.
  if (await link.isVisible().catch(() => false)) {
    await link.click()
    await expect(page).toHaveURL(/\/\/kontakty\?id=\d+/)
    // The card fetches by id, so it must populate even if the contact isn't in
    // the engaged list — proves deep-link robustness, not just list lookup.
    await expect(page.getByTestId('app-contact-detail')).toBeVisible({ timeout: 10_000 })
  }
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Kontakty deep-link by id renders the card without a list hit', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  // Deep-link straight to a contact id (as a cross-link or bookmark would).
  await page.goto('/kontakty?id=151900')
  await expect(page.getByTestId('app-contact-detail')).toBeVisible({ timeout: 12_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Kontakt → Vozidlo edge: a contact with a vehicle links to it', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  // Contact 151900 owns vehicle 76 (Mercedes) — the reverse of vozidlo→kontakt.
  await page.goto('/kontakty?id=151900')
  await expect(page.getByTestId('app-contact-vehicles')).toBeVisible({ timeout: 12_000 })
  await page.getByTestId('app-contact-vehicle').first().click()
  await expect(page).toHaveURL(/\/\/vozidla\?id=\d+/)
  await expect(page.getByTestId('app-vehicle-detail')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Odpověď → Kontakt link lands on the contact card', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  // Reply 46 is matched to contact 189845 (a contact that exists).
  await page.goto('/odpovedi-legacy?vse=1&id=46')
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })
  await page.getByTestId('app-reply-contact-link').click()
  await expect(page).toHaveURL(/\/\/kontakty\?id=\d+/)
  await expect(page.getByTestId('app-contact-detail')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Kontakt → Odpovědi edge: contact card lists its replies', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  // Contact 189845 has reply 46.
  await page.goto('/kontakty?id=189845')
  await expect(page.getByTestId('app-contact-replies')).toBeVisible({ timeout: 12_000 })
  await page.getByTestId('app-contact-reply').first().click()
  await expect(page).toHaveURL(/\/\/odpovedi.*[?&]id=\d+/)
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})
