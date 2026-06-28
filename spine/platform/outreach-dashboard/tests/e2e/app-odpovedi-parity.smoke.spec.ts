// app-odpovedi-parity.smoke.spec.ts
//
// Parity smoke for Odpovedi (the canonical /odpovedi triage surface) after
// it absorbed the pages/Replies.jsx bulk + forward-to-CRM feature set so
// can be retired. Per HARD RULE feedback_playwright_smoke_required.
//
// Asserts the NEW parity controls render + wire WITHOUT mutating anything:
//   - the reply list + per-row select checkboxes,
//   - the bulk-action bar (Vyřídit / Do CRM / Skrýt) once a reply is selected,
//   - the forward-to-CRM dialog OPENS (then we cancel — never confirm),
//   - the per-reply "Do CRM" handoff control in the reading pane.
// It deliberately does NOT click confirm/send/revert — those POST to the BFF
// (mark-handled / bulk-revert / forward-to-crm) and would mutate real state.
//
// Self-contained: route-stubs all /api/* so it runs headless without a live BFF
// (mirrors app-odpovedi.smoke.spec.ts). operator_id cookie satisfies the BFF auth
// middleware + the dev-only Firebase auth seam (mirrors app-dedup.smoke.spec.ts).

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

const REPLY_ID = 9401

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
  mined: { phones: [{ display: '+420 603 123 456', tel: '+420603123456' }], callback: true, urgent: true, locations: ['Brno'] },
  ...over,
})

const ROWS = [ROW(REPLY_ID), ROW(9402), ROW(9403)]

const DETAIL = {
  reply: {
    ...ROW(REPLY_ID),
    pre_classification: { intent: 'positive', confidence: 0.84, classifier_version: 'v3' },
    signature: { company: 'Brněnská strojírna s.r.o.', ico: '12345678' },
  },
}

const STATS = { unhandled: 3, nezpracovane: 3, hot_unhandled: 2, phone_unhandled: 2, total: 3 }

const MESSAGES = {
  messages: [
    { id: 1, direction: 'outbound', kind: 'auto_send', sent_at: new Date(Date.now() - 2 * 86400_000).toISOString(), body_text: 'Dobrý den, vykupujeme techniku.' },
    { id: 2, direction: 'inbound', sent_at: new Date(Date.now() - 3600_000).toISOString(), body_text: 'Ano, máme bagr na prodej. Zavolejte mi.' },
  ],
}

// Guard: fail loudly if the test ever triggers a mutating reply endpoint — the
// parity smoke must observe controls only, never mark-handled / revert / forward.
const MUTATION_RE = /\/(bulk-revert|bulk-handled|forward-to-crm|forward-to-garaaage|bulk-suppress-check)\b|\/replies\/-?\d+(\/(handled|flag|classify|reply))?$/

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

async function stub(page: Page) {
  // Catch-all first (lowest priority — Playwright last-registered wins).
  await page.route('**/api/**', (route) => {
    const u = route.request().url()
    if (/stream|events|sse/i.test(u)) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  })
  await page.route('**/api/replies/stats', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATS) }))
  await page.route('**/api/replies?**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: ROWS, total: 3 }) }))
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETAIL) })
  })
  await page.route('**/api/replies/*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DETAIL) }))
  await page.route('**/api/threads/*/messages', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES) }))
  await page.route('**/api/reply-templates', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"templates":[]}' }))
  // Registered LAST so it wins over `**/api/replies?**` (Playwright's `?` glob is
  // a single-char wildcard, so that pattern also matches `/api/replies/stream`).
  // The SSE endpoint MUST answer text/event-stream or EventSource console-errors.
  await page.route('**/api/replies/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' }))
}

function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  // Capture any 4xx/5xx EXCEPT a benign 404 (the only tolerated status).
  page.on('response', (r) => { if (r.status() >= 400 && r.status() !== 404) errs.push(`http ${r.status()}: ${r.url()}`) })
  return errs
}

test('Odpovědi — bulk bar + forward-to-CRM controls present on selection (no mutation)', async ({ page }) => {
  const errs = watchConsole(page)
  // Hard guard: if any mutating reply endpoint is hit, surface it as a failure.
  const mutations: string[] = []
  page.on('request', (r) => {
    const m = r.method()
    if ((m === 'POST' || m === 'PATCH' || m === 'DELETE') && MUTATION_RE.test(new URL(r.url()).pathname)) {
      mutations.push(`${m} ${r.url()}`)
    }
  })

  await ensureLoggedIn(page)
  await stub(page)
  await page.goto('/odpovedi')

  // Shell + reply list render.
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-reply-row').first()).toBeVisible({ timeout: 12_000 })

  // Bulk bar present (always while rows exist) with the master select-all.
  await expect(page.getByTestId('app-bulkbar')).toBeVisible()
  await expect(page.getByTestId('app-bulk-selectall')).toBeVisible()

  // Select a reply via its row checkbox (pure client state — NOT a mutation).
  await page.getByTestId('app-reply-select').first().check()
  await expect(page.getByTestId('app-bulk-count')).toContainText('vybráno')

  // The batch actions appear — including the forward-to-CRM control.
  await expect(page.getByTestId('app-bulk-handle')).toBeVisible()
  await expect(page.getByTestId('app-bulk-crm')).toBeVisible()
  await expect(page.getByTestId('app-bulk-hide')).toBeVisible()

  // Forward-to-CRM dialog OPENS (proves the control is wired) — then cancel.
  // No confirm click → no POST /api/replies/:id/forward-to-crm.
  await page.getByTestId('app-bulk-crm').click()
  await expect(page.getByTestId('app-forward-dialog')).toBeVisible()
  await expect(page.getByTestId('app-forward-confirm')).toBeVisible()
  await page.getByTestId('app-forward-cancel').click()
  await expect(page.getByTestId('app-forward-dialog')).toHaveCount(0)

  // Open a reply → the reading pane carries the per-reply "Do CRM" handoff.
  await page.getByTestId('app-reply-row').first().click()
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByTestId('app-detail-crm')).toBeVisible()

  // Composer (send-email reply capability) + vehicle-capture toggle still wired.
  await expect(page.getByTestId('app-composer')).toBeVisible()
  await expect(page.getByTestId('app-compose-text')).toBeVisible()

  expect(mutations, `mutating endpoints must not be hit:\n${mutations.join('\n')}`).toHaveLength(0)
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Odpovědi — bulk hide opens a confirm dialog (no mutation)', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await stub(page)
  await page.goto('/odpovedi')

  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('app-reply-select').first().check()

  // Skrýt opens a destructive-confirm dialog; we cancel without confirming.
  await page.getByTestId('app-bulk-hide').click()
  await expect(page.getByTestId('app-confirm-dialog')).toBeVisible()
  await expect(page.getByTestId('app-confirm-dialog-ok')).toBeVisible()
  await page.getByTestId('app-confirm-dialog-cancel').click()
  await expect(page.getByTestId('app-confirm-dialog')).toHaveCount(0)

  expect(errs, errs.join('\n')).toHaveLength(0)
})
