// app-reply-draft.smoke.spec.ts
//
// UX — reply composer in the Odpovědi pane. The operator writes (or has
// Ollama draft) a reply and sends it via the safe outbox→relay path. Per HARD
// RULE feedback_playwright_smoke_required.
//
// SAFETY: this smoke MUST NOT dispatch real mail. It exercises everything up to
// (and including arming) the confirm gate, then CANCELS — it never clicks
// "Ano, odeslat". The draft path fires a real Ollama generation (~15–40s).

import { test, expect, Page } from '@playwright/test'

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

test('reply pane shows the composer with a send + Ollama-draft button', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await ensureLoggedIn(page)
  // Reply 97 is positive with a stored body.
  await page.goto('/odpovedi-legacy?vse=1&id=97')
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByTestId('app-compose')).toBeVisible()
  await expect(page.getByTestId('app-compose-send')).toBeVisible()
  await expect(page.getByTestId('app-compose-draft')).toBeVisible()
  // Vehicle capture is now a small button in the composer (moved out of a
  // standalone panel); clicking it reveals the capture form / linked chip.
  await expect(page.getByTestId('app-compose-vehicle')).toBeVisible()
  await page.getByTestId('app-compose-vehicle').click()
  await expect(page.getByTestId('app-capture').or(page.getByTestId('app-capture-linked')))
    .toBeVisible({ timeout: 8_000 })
  // Empty body → send disabled (can't dispatch a blank reply).
  await expect(page.getByTestId('app-compose-send')).toBeDisabled()
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('"Zájem" lane filters to waiting hot leads and stays accessible', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await ensureLoggedIn(page)
  await page.goto('/odpovedi-legacy')
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 12_000 })
  const hot = page.getByTestId('app-filter-hot')
  await expect(hot).toBeVisible()
  await hot.click()
  await expect(hot).toHaveAttribute('aria-pressed', 'true')
  // Either the hot backlog renders rows, or the calm "all cleared" empty state.
  await expect(page.getByTestId('app-reply-row').first().or(page.getByTestId('app-list-empty')))
    .toBeVisible({ timeout: 8_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('send is a two-step confirm — never dispatches on a single click', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await ensureLoggedIn(page)
  await page.goto('/odpovedi-legacy?vse=1&id=97')
  await page.getByTestId('app-compose-text').fill('Dobrý den, děkuji za zprávu — ozvu se.')
  await page.getByTestId('app-compose-send').click()
  // First click only arms the confirm; the real send button now appears.
  await expect(page.getByTestId('app-compose-confirm')).toBeVisible()
  // SAFETY: cancel — we never click "Ano, odeslat" in a smoke test.
  await page.getByTestId('app-compose-cancel').click()
  await expect(page.getByTestId('app-compose-send')).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})
