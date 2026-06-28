// app-forward-email.smoke.spec.ts
//
// Smoke for the "Přeposlat e-mail" (forward) surface in /odpovedi.
// Per HARD RULE feedback_playwright_smoke_required: open a reply, open the
// forward dialog, see the headline, drive the two-step confirm send, assert
// the POST /api/replies/:id/forward fired with the recipient — and NO console
// error (feedback_smoke_gate_operator_strict: any 4xx/5xx fails the run).
//
// Self-contained: route-stubs all /api/* so it passes headless without a live
// BFF. Captures light + dark screenshots to /tmp.

import { test, expect, Page } from '@playwright/test'

const REPLY_ID = 9301

const ROW = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  contact_id: id,
  campaign_id: 71,
  from_email: `petr${id}@strojirna.cz`,
  contact_name: `Petr Beneš ${id}`,
  subject: `RE: výkup bagru Komatsu ${id}`,
  body_text_preview: `Dobrý den, máme zájem prodat bagr. Zavolejte na 603 ${id}.`,
  classification: 'positive',
  received_at: new Date(Date.now() - (id % 100) * 3600_000).toISOString(),
  handled: false,
  flagged: false,
  campaign_name: 'Výkup techniky Q2',
  has_vehicle: false,
  mined: { phones: [{ display: '+420 603 123 456', tel: '+420603123456' }], callback: true, urgent: false, locations: ['Brno'] },
  ...over,
})

const ROWS = [ROW(REPLY_ID), ROW(9302)]

const DETAIL = {
  reply: {
    ...ROW(REPLY_ID),
    body_text: 'Dobrý den, máme bagr Komatsu PC210 na prodej, rok 2018. Kolik nabízíte?',
    attachments_meta: [{ filename: 'bagr.jpg', size_bytes: 204800, content_type: 'image/jpeg' }],
    pre_classification: { intent: 'positive', confidence: 0.84 },
  },
}

const STATS = { unhandled: 2, hot_unhandled: 1, phone_unhandled: 1, total: 2 }
const MESSAGES = { messages: [{ id: 1, direction: 'inbound', sent_at: new Date().toISOString(), body_text: 'Máme bagr na prodej.' }] }

type ForwardCapture = { hit: number; to: string | null; includeOriginal: string | null }

async function ensureLoggedIn(page: Page) {
  // Dev-only auth seam (project_v2_local_auth_seam): operator_id cookie bypasses
  // the Firebase RequireAuth gate that otherwise redirects headlessly to /login.
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

async function stub(page: Page, cap: ForwardCapture) {
  // Catch-all first (Playwright: last-registered wins, so specifics override).
  await page.route('**/api/**', (route) => {
    const u = route.request().url()
    if (/stream|events|sse/i.test(u)) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
  await page.route('**/api/replies/stats', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATS) }))
  await page.route('**/api/replies?**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: ROWS, total: 2 }) }))
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETAIL) })
  })
  await page.route('**/api/threads/*/messages', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES) }))
  await page.route('**/api/reply-templates', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"templates":[]}' }))
  await page.route('**/api/replies/*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETAIL) }))

  // The forward POST — capture the recipient + include_original from the
  // multipart body, then ack. Registered AFTER the greedy detail route so it
  // wins for the /forward URL.
  await page.route('**/api/replies/*/forward', async (route) => {
    cap.hit++
    const raw = route.request().postData()
    const toM = raw && /name="to"\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(raw)
    const incM = raw && /name="include_original"\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(raw)
    cap.to = toM ? toM[1] : null
    cap.includeOriginal = incM ? incM[1] : null
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, outbox_id: 5001, recipient_domain: 'bagry.cz' }) })
  })

  // SSE last so they win over the greedy detail route (MIME must be event-stream).
  await page.route('**/api/replies/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }))
  await page.route('**/api/threads/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }))
}

function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  page.on('response', (r) => { if (r.status() >= 400) errs.push(`http ${r.status()}: ${r.url()}`) })
  return errs
}

test('/odpovedi — Přeposlat dialog opens, quotes original, sends through POST /forward', async ({ page }) => {
  const errs = watchConsole(page)
  const cap: ForwardCapture = { hit: 0, to: null, includeOriginal: null }
  await ensureLoggedIn(page)
  await stub(page, cap)
  await page.goto('/odpovedi')

  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })

  // Open the first lead → reading pane with the Přeposlat header action.
  await page.getByTestId('app-reply-row').first().click()
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })
  const fwdBtn = page.getByTestId('app-detail-forward')
  await expect(fwdBtn).toBeVisible()

  // Open the dialog → headline + quoted original + attachment toggle.
  await fwdBtn.click()
  await expect(page.getByTestId('app-forward-email-dialog')).toBeVisible()
  await expect(page.getByText('Přeposlat e-mail')).toBeVisible()
  await expect(page.getByTestId('app-forward-email-quote')).toContainText('Komatsu PC210')
  await expect(page.getByTestId('app-forward-email-include')).toContainText('Připojit původní přílohy (1)')
  // animations:'disabled' fast-forwards the app-pop-dialog fade-in so the shot
  // captures the SETTLED (fully opaque) dialog, not a mid-animation frame.
  await page.screenshot({ path: '/tmp/app-forward-email-light.png', fullPage: false, animations: 'disabled' })

  // Invalid email keeps Send disabled.
  await page.getByTestId('app-forward-email-to').fill('notanemail')
  await expect(page.getByTestId('app-forward-email-err')).toBeVisible()
  await expect(page.getByTestId('app-forward-email-send')).toBeDisabled()

  // Valid email → two-step confirm → send.
  await page.getByTestId('app-forward-email-to').fill('dealer@bagry.cz')
  await page.getByTestId('app-forward-email-send').click()
  await page.getByTestId('app-forward-email-confirm').click()

  // Success state + the POST fired with the recipient.
  await expect(page.getByTestId('app-forward-email-done')).toBeVisible({ timeout: 8_000 })
  expect(cap.hit).toBe(1)
  expect(cap.to).toBe('dealer@bagry.cz')
  expect(cap.includeOriginal).toBe('true')

  // Dark screenshot.
  await page.getByTestId('app-forward-email-close').click()
  await page.evaluate(() => localStorage.setItem('uiTheme', 'dark'))
  await page.reload()
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })
  // Wait for the theme to actually apply before opening + shooting, else the
  // dialog can be captured under the light tokens (data-theme not yet flipped).
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.app-shell')?.getAttribute('data-theme')), { timeout: 5_000 })
    .toBe('dark')
  await page.getByTestId('app-detail-forward').click()
  await expect(page.getByTestId('app-forward-email-dialog')).toBeVisible()
  // Assert the dialog actually picked up the dark surface token (#271F14).
  await expect(page.getByTestId('app-forward-email-dialog'))
    .toHaveCSS('background-color', 'rgb(39, 31, 20)')
  await page.screenshot({ path: '/tmp/app-forward-email-dark.png', fullPage: false, animations: 'disabled' })

  expect(errs, errs.join('\n')).toHaveLength(0)
})
