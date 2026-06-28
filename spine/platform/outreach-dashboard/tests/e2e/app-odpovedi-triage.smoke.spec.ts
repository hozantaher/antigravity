// app-odpovedi-triage.smoke.spec.ts
//
// Smoke + regression guard for the Odpovědi triage list (S5 cluster):
//   #1019 nav unread badge, #1020 classification control, #1021 bulk select.
//
// Regression: #1021's bulk-select wrapper made the row a flex child that
// inherited the base .app-row width:100% as its flex-basis and collapsed to
// ~26px — rows rendered blank (operator screenshot 2026-06-01). The width
// assertion below would have caught it. Per feedback_playwright_smoke_required
// + feedback_smoke_gate_operator_strict (fail on any console error).

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  return errs
}

test('Odpovědi list renders rows with content (not collapsed)', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })

  const firstRow = page.getByTestId('app-reply-row').first()
  await expect(firstRow).toBeVisible()
  // Regression guard: the row button must span a real width, not the ~26px
  // collapse. The list column is ~300px; anything < 120px is the bug.
  const box = await firstRow.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThan(120)
  // …and it must actually show the sender text.
  await expect(firstRow.locator('.app-row__name')).not.toBeEmpty()

  expect(errs, errs.join('\n')).toEqual([])
})

test('bulk select-all + per-row checkbox present', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })

  await expect(page.getByTestId('app-bulk-selectall')).toBeVisible()
  const firstCheck = page.getByTestId('app-reply-select').first()
  await expect(firstCheck).toBeVisible()
  // Selecting a row reveals the bulk action button.
  await firstCheck.check()
  await expect(page.getByTestId('app-bulk-handle')).toBeVisible()

  expect(errs, errs.join('\n')).toEqual([])
})

test('inbox rows show a mail-client snippet line', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  // At least one row renders a body snippet under the subject.
  await expect(page.getByTestId('app-row-snippet').first()).toBeVisible()
  expect(errs, errs.join('\n')).toEqual([])
})

test('opening a conversation shows the mail-client toolbar', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('app-reply-row').first().click()
  await expect(page.getByTestId('app-pane-toolbar')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('app-toolbar-reply')).toBeVisible()
  expect(errs, errs.join('\n')).toEqual([])
})

test('keyboard "j" opens/advances a conversation', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-reply-row').first()).toBeVisible()
  await page.keyboard.press('j')
  // j selects a conversation → the reading pane (toolbar) appears + ?id= is set.
  await expect(page.getByTestId('app-pane-toolbar')).toBeVisible({ timeout: 10_000 })
  await expect.poll(() => new URL(page.url()).searchParams.get('id')).not.toBeNull()
  expect(errs, errs.join('\n')).toEqual([])
})

test('flag toggle + Označené lane', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('app-reply-row').first().click()
  const flagBtn = page.getByTestId('app-toolbar-flag')
  await expect(flagBtn).toBeVisible({ timeout: 10_000 })
  await flagBtn.click()
  await expect(flagBtn).toHaveText(/Označeno/)
  // The Označené lane now lists the flagged conversation.
  await page.getByTestId('app-filter-flagged').click()
  await expect(page.locator('.app-row__star').first()).toBeVisible({ timeout: 10_000 })
  // Cleanup: unflag so the lane returns to empty for the next run.
  await page.getByTestId('app-reply-row').first().click()
  await expect(page.getByTestId('app-toolbar-flag')).toHaveText(/Označeno/)
  await page.getByTestId('app-toolbar-flag').click()
  await expect(page.getByTestId('app-toolbar-flag')).toHaveText(/Označit/)
  expect(errs, errs.join('\n')).toEqual([])
})

test('📞 call-queue filter narrows to replies with a mined phone (#1578 M1)', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('app-filter-phone').click()
  // Prod has 23 replies carrying a phone number — the lane must show rows, and
  // each visible row must carry the 📞 phone chip (the mined signal surfaced
  // straight in the inbox so the operator dials without opening the mail).
  const firstRow = page.getByTestId('app-reply-row').first()
  await expect(firstRow).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('app-row-phone').first()).toBeVisible()
  expect(errs, errs.join('\n')).toEqual([])
})

test('reply detail shows the signature contact card when present (#1581 M2.1)', async ({ page }) => {
  const errs = watchConsole(page)
  // The 📞 lane (replies that left a phone) reliably carry a signature block —
  // a phone in the body almost always means a contact signature. The card
  // surfaces company / IČO / email parsed from it.
  await page.goto('/odpovedi-legacy?mode=phone')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  const rows = page.getByTestId('app-reply-row')
  await expect(rows.first()).toBeVisible({ timeout: 10_000 })
  const count = Math.min(await rows.count(), 15)
  let found = false
  for (let i = 0; i < count; i++) {
    await rows.nth(i).click()
    await expect(page.getByTestId('app-pane-toolbar')).toBeVisible({ timeout: 10_000 })
    if (await page.getByTestId('app-signature').count()) { found = true; break }
  }
  expect(found, 'no reply in the first 12 surfaced a signature card').toBe(true)
  expect(errs, errs.join('\n')).toEqual([])
})

test('mined phone offers "uložit ke kontaktu" on a matched reply (#1581 M2.2)', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy?mode=phone')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  const rows = page.getByTestId('app-reply-row')
  await expect(rows.first()).toBeVisible({ timeout: 10_000 })
  const count = Math.min(await rows.count(), 15)
  let found = false
  for (let i = 0; i < count; i++) {
    await rows.nth(i).click()
    await expect(page.getByTestId('app-pane-toolbar')).toBeVisible({ timeout: 10_000 })
    if (await page.getByTestId('app-savephone').count()) { found = true; break }
  }
  expect(found, 'no matched phone-reply offered the save-to-contact button').toBe(true)
  expect(errs, errs.join('\n')).toEqual([])
})

test('nav shows the unread-replies badge', async ({ page }) => {
  const errs = watchConsole(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 })
  // Badge appears once the stats poll lands (there is an unhandled backlog on
  // prod). Allow a beat for the fetch.
  await expect(page.getByTestId('app-nav-unread-badge')).toBeVisible({ timeout: 10_000 })

  expect(errs, errs.join('\n')).toEqual([])
})
