// ═══════════════════════════════════════════════════════════════════════════
//  AP-F4 — /replies/:id outbound bubble truncation + chrome cleanup
//
//  Required by HARD rule `feedback_playwright_smoke_required` T0 — every
//  user-visible /replies/:id refactor lands with at least one smoke spec.
//  The cumulative ROUTES pack lives in tests/e2e/today-shipped-surfaces.
//  smoke.spec.ts; this file owns the AP-F4-specific behavior.
//
//  Asserts:
//    - Outbound bubbles render with a "Zobrazit celý email →" expander
//      by default (body is collapsed to a one-line preview).
//    - Clicking the expander reveals the full body and flips the
//      affordance label to "Skrýt ↑".
//    - Inbound bubbles render without an avatar slot (AP-F4 drop).
//    - No 4xx/5xx console errors slip through the smoke gate
//      (feedback_smoke_gate_operator_strict T0).
//
//  All BFF endpoints are stubbed via page.route() so the spec doesn't
//  depend on a live BFF.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test'

const REPLY_ID = 8801

const REPLY = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Anna Procházková',
    from_email: 'anna@firma.cz',
    subject: 'Re: nabídka servisu',
    campaign_name: 'Kampaň Servis',
    campaign_id: 42,
    classification: 'positive',
    handled: false,
    received_at: '2026-05-18T11:00:00Z',
    body_html: '<p>Děkuji za nabídku, můžeme se sejít příští týden?</p>',
    body_preview: 'Děkuji za nabídku, můžeme se sejít příští týden?',
  },
}

// One long outbound (auto_send cold-mail body) + one short inbound reply.
// The outbound body intentionally spans multiple paragraphs to force
// the truncation affordance to appear.
const MESSAGES = {
  messages: [
    {
      id: 101,
      type: 'auto_send',
      sender: 'outreach@nas.cz',
      sent_at: '2026-05-17T09:00:00Z',
      body: [
        'Dobrý den paní Procházková,',
        '',
        'posíláme nabídku na servis vašich strojů — sleva 20% do konce měsíce.',
        'Servisní technici jsou dostupní v okolí 50 km od vaší firmy.',
        'Rádi vám připravíme cenovou kalkulaci na míru.',
        '',
        'S pozdravem',
        'Tomáš Messing',
        'Garaaage s.r.o.',
      ].join('\n'),
    },
    {
      id: 102,
      type: 'incoming',
      sender: 'anna@firma.cz',
      sender_name: 'Anna Procházková',
      sent_at: '2026-05-18T11:00:00Z',
      body: 'Děkuji za nabídku, můžeme se sejít příští týden?',
    },
  ],
}

const EMPTY_CONTEXT = { company_name: null, company_id: null, website: null, open_deals: 0 }

async function stubAll(page: Page) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPLY) })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES) })
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_CONTEXT) })
  )
  await page.route('**/api/operator-settings**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  )
}

// Smoke gate per feedback_smoke_gate_operator_strict T0 — fail on ANY
// 4xx/5xx-flavored console.error. Filter only the canonical noise set
// (React DevTools nag, favicon 404, sourcemap warnings, preload-no-status).
function setupConsoleErrorGate(page: Page): { errors: string[] } {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
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

test.describe('AP-F4 — /replies/:id outbound bubble truncation', () => {
  test('outbound bubble starts truncated, expander reveals full body', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)
    await stubAll(page)

    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Anna Procházková/', { timeout: 10_000 })

    // Two bubbles render (outbound + inbound).
    await expect(page.getByTestId('message-body')).toHaveCount(2)

    // Outbound expander affordance present + outbound bubble starts truncated.
    const toggle = page.getByTestId('message-expand-toggle')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveText(/Zobrazit celý email/)
    await expect(page.locator('[data-truncated="true"]')).toHaveCount(1)

    // Lower-paragraph copy is hidden in the truncated preview.
    const before = await page.locator('[data-msg-type="auto_send"] [data-testid="message-body"]').first().textContent()
    expect(before).not.toMatch(/S pozdravem/)
    expect(before).not.toMatch(/sleva 20%/)

    // Click the expander → full body revealed + label flips to "Skrýt ↑".
    await toggle.click()
    await expect(toggle).toHaveText(/Skrýt/)
    await expect(page.locator('[data-truncated="false"]')).toHaveCount(2)
    const after = await page.locator('[data-msg-type="auto_send"] [data-testid="message-body"]').first().textContent()
    expect(after).toMatch(/S pozdravem/)
    expect(after).toMatch(/sleva 20%/)

    // AP-F4 — inbound avatars dropped entirely.
    await expect(page.getByTestId('message-avatar')).toHaveCount(0)

    // Smoke gate — no 4xx/5xx console noise.
    expect(gate.errors).toEqual([])
  })
})
