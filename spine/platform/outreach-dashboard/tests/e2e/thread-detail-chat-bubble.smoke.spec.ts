// ═══════════════════════════════════════════════════════════════════════════
//  AL-F1 — /replies/:id chat-bubble unify (orphan + matched paths)
//
// Smoke spec required by HARD rule `feedback_playwright_smoke_required`.
// AL-F1 doesn't add a new route, but it materially changes /replies/:id
// visuals (orphan reply now renders through MessageBubble instead of a
// separate static card) → smoke spec required.
//
// All BFF endpoints are stubbed via page.route() so the spec doesn't
// depend on a live BFF.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test'

// Two fixture replies — one orphan (no thread history) and one matched
// (with a 3-message timeline). Both should render through MessageBubble.
const ORPHAN_REPLY_ID = 7777
const MATCHED_REPLY_ID = 7778

const ORPHAN_REPLY = {
  reply: {
    id: ORPHAN_REPLY_ID,
    contact_name: 'Jan Novák',
    from_email: 'jan@orphan.cz',
    subject: 'Re: dotaz na nabídku',
    campaign_name: null,
    campaign_id: null,
    classification: 'unknown',
    handled: false,
    received_at: '2026-05-18T10:00:00Z',
    body_html: '<p>Dobrý den, mám zájem o vaši nabídku. Můžeme se sejít?</p>',
    body_preview: 'Dobrý den, mám zájem o vaši nabídku.',
  },
}

const MATCHED_REPLY = {
  reply: {
    id: MATCHED_REPLY_ID,
    contact_name: 'Petr Dvořák',
    from_email: 'petr@matched.cz',
    subject: 'Re: nabídka — odpověď',
    campaign_name: 'Kampaň Beta',
    campaign_id: 99,
    classification: 'positive',
    handled: false,
    received_at: '2026-05-18T11:00:00Z',
    body_html: '<p>Souhlasíme.</p>',
    body_preview: 'Souhlasíme.',
  },
}

const MATCHED_MESSAGES = {
  messages: [
    { id: 1, type: 'auto_send', sender: 'outreach@nas.cz', body: 'Dobrý den, posílám nabídku.', sent_at: '2026-05-17T09:00:00Z' },
    { id: 2, type: 'incoming',  sender: 'petr@matched.cz', body: 'Souhlasíme.',                sent_at: '2026-05-18T11:00:00Z' },
    { id: 3, type: 'manual',    sender: 'outreach@nas.cz', body: 'Skvělé, posílám smlouvu.',   sent_at: '2026-05-18T12:00:00Z' },
  ],
}

const EMPTY_CONTEXT = { company_name: null, company_id: null, website: null, open_deals: 0 }

async function stubReply(page: Page, id: number, body: unknown, messages: unknown) {
  await page.route(`**/api/replies/${id}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
  await page.route(`**/api/threads/${id}/messages`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(messages),
    })
  )
  await page.route(`**/api/threads/${id}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_CONTEXT) })
  )
  // Operator settings + any other passive GETs are harmless if unstubbed,
  // but stub the most chatty ones to avoid background 404s polluting the
  // console-error gate.
  await page.route('**/api/operator-settings**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  )
}

// Collect console errors as an assertion target — per the
// smoke_gate_operator_strict HARD rule, the spec MUST fail on 4xx/5xx
// console noise. We filter only the well-known noise list.
function setupConsoleErrorGate(page: Page): { errors: string[] } {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    // Skip the canonical noise: React DevTools nag, favicon 404s,
    // sourcemap warnings, CSS preload-without-status warnings.
    if (/react devtools/i.test(text)) return
    if (/favicon/i.test(text)) return
    if (/sourcemap/i.test(text)) return
    if (/preload.*was not used/i.test(text)) return
    errors.push(text)
  })
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`)
  })
  return { errors }
}

test.describe('AL-F1 — /replies/:id chat-bubble unify (orphan path)', () => {
  test('orphan reply renders as a single inbound chat bubble with avatar', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)
    await stubReply(page, ORPHAN_REPLY_ID, ORPHAN_REPLY, { messages: [] })

    await page.goto(`/replies/${ORPHAN_REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })

    // Bubble is visible — orphan now uses MessageBubble (testid preserved).
    const bodies = page.getByTestId('message-body')
    await expect(bodies).toHaveCount(1)
    await expect(bodies.first()).toContainText(/mám zájem/i)

    // AP-F4 — inbound avatar dropped (1:1 chat; sender already shown in
    // DetailAnchorHeader). Bubble itself must still render.
    await expect(page.getByTestId('message-avatar')).toHaveCount(0)

    // Inbound bubble carries the data-msg-type marker.
    await expect(page.locator('[data-msg-type="incoming"]').first()).toBeVisible()

    // No console errors slipped through.
    expect(gate.errors).toEqual([])
  })
})

test.describe('AL-F1 — /replies/:id chat-bubble unify (matched path)', () => {
  test('matched thread renders multiple bubbles with avatars on inbound only', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)
    await stubReply(page, MATCHED_REPLY_ID, MATCHED_REPLY, MATCHED_MESSAGES)

    await page.goto(`/replies/${MATCHED_REPLY_ID}`)
    await page.waitForSelector('text=/Petr Dvořák/', { timeout: 10_000 })

    const bodies = page.getByTestId('message-body')
    await expect(bodies).toHaveCount(3)

    // AP-F4 — avatars dropped from inbound bubbles entirely.
    const avatars = page.getByTestId('message-avatar')
    await expect(avatars).toHaveCount(0)

    // Outbound bubbles still render (auto_send + manual).
    await expect(page.locator('[data-msg-type="auto_send"]').first()).toBeVisible()
    await expect(page.locator('[data-msg-type="manual"]').first()).toBeVisible()

    expect(gate.errors).toEqual([])
  })
})
