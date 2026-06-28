// app-capture.smoke.spec.ts
//
// UX — the Odpovědi → Vozidlo capture panel (interconnection + Ollama).
// Per HARD RULE feedback_playwright_smoke_required. Runs against real local
// PROD data. Does NOT click "Vytvořit vozidlo" — that would write a real
// vehicle; the create payload is unit-tested (vehicleDraft.test.js) and the
// POST endpoint is the existing, audited path.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

// Reply 103 already produced a vehicle; reply 97 (positive, has body) has none.
const REPLY_WITH_VEHICLE = 103
const REPLY_NO_VEHICLE = 97

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

test('a reply that already has a vehicle shows the linked chip', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto(`/odpovedi-legacy?vse=1&id=${REPLY_WITH_VEHICLE}`)
  await expect(page.getByTestId('app-capture-linked')).toBeVisible({ timeout: 15_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('a reply with no vehicle offers the Ollama extract action', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto(`/odpovedi-legacy?vse=1&id=${REPLY_NO_VEHICLE}`)
  await expect(page.getByTestId('app-capture-extract')).toBeVisible({ timeout: 15_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

// Slow: fires a real Ollama extraction (CPU inference ~15–40s). Proves the
// whole relative-extraction path renders an editable draft in the UI.
test('extract surfaces an editable vehicle draft form', async ({ page }) => {
  test.setTimeout(70_000)
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto(`/odpovedi-legacy?vse=1&id=${REPLY_NO_VEHICLE}`)
  await page.getByTestId('app-capture-extract').click()
  await expect(page.getByTestId('app-capture-make')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('app-capture-create')).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})
