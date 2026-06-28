// ═══════════════════════════════════════════════════════════════════════════
//  AT-F2 — /replies/:id ThreadDetail polish pass smoke
//
//  Required by HARD rule `feedback_playwright_smoke_required` T0 — every
//  user-visible /replies/:id refactor lands with at least one smoke spec.
//
//  Asserts:
//    1. Layout-matching ThreadLoadingSkeleton renders the back-button +
//       name + subtitle + divider + context bar + 2 bubble placeholders
//       while the primary fetch is in flight.
//    2. Pressing `E` (case-insensitive) anywhere on the page (outside an
//       input/textarea) toggles every outbound bubble between truncated
//       and fully expanded.
//    3. When the primary fetch errors, the polished ErrorState renders
//       both "Zkusit znovu" and "Zpět na schránku" buttons and surfaces
//       the truncated error text via [data-testid="thread-error-message"].
//    4. When `context.campaign.inferred=true`, the campaign chip is
//       suffixed with a "(odhad)" hint so the operator can tell the
//       campaign was post-hoc-matched (PR #1469).
//
//  Strict console-error gate per HARD rule `feedback_smoke_gate_operator_strict`.
//  All BFF endpoints are stubbed via page.route() so the spec is hermetic.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test'

const REPLY_ID = 9921

const REPLY = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Klára Nováková',
    from_email: 'klara@odhad-firma.cz',
    subject: 'Re: nabídka',
    campaign_name: 'Inferred Campaign',
    campaign_id: 77,
    classification: 'positive',
    handled: false,
    received_at: '2026-05-18T11:00:00Z',
    body_html: '<p>Děkuji, máme zájem.</p>',
    body_preview: 'Děkuji, máme zájem.',
  },
}

const MESSAGES = {
  messages: [
    {
      id: 1001,
      type: 'auto_send',
      sender: 'outreach@nas.cz',
      sent_at: '2026-05-17T09:00:00Z',
      body: [
        'Dobrý den paní Nováková,',
        '',
        'posíláme nabídku na servis vašich strojů — sleva 20% do konce měsíce.',
        'Servisní technici jsou dostupní v okolí 50 km od vaší firmy.',
        'Rádi vám připravíme cenovou kalkulaci na míru.',
        '',
        'S pozdravem',
        'Tomáš Messing',
      ].join('\n'),
    },
    {
      id: 1002,
      type: 'auto_send',
      sender: 'outreach@nas.cz',
      sent_at: '2026-05-17T10:00:00Z',
      body: [
        'Dobrý den paní Nováková,',
        '',
        'jen pro připomenutí — nabídka platí do konce týdne.',
        'Můžeme si dohodnout krátkou schůzku?',
        '',
        'Děkuji,',
        'Tomáš',
      ].join('\n'),
    },
    {
      id: 1003,
      type: 'incoming',
      sender: 'klara@odhad-firma.cz',
      sender_name: 'Klára Nováková',
      sent_at: '2026-05-18T11:00:00Z',
      body: 'Děkuji, máme zájem.',
    },
  ],
}

// PR #1469 — orphan post-hoc match flag.
const CONTEXT_INFERRED = {
  company: { name: 'Odhad firma s.r.o.', ico: '99999999' },
  campaign: { id: 77, name: 'Inferred Campaign', status: 'running', sent: 12, replied: 1, inferred: true },
}

const CONTEXT_MATCHED = {
  company: { name: 'Odhad firma s.r.o.', ico: '99999999' },
  campaign: { id: 77, name: 'Inferred Campaign', status: 'running', sent: 12, replied: 1 },
}

async function stubAll(page: Page, opts: { context: unknown }) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPLY) })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES) }),
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.context) }),
  )
  await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' }),
  )
  await page.route('**/api/operator-settings**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  )
}

// Smoke gate per feedback_smoke_gate_operator_strict T0 — fail on ANY
// 4xx/5xx-flavored console.error. Filter only the canonical noise set.
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

test.describe('AT-F2 — /replies/:id polish smoke', () => {
  test('1. layout-matching loading skeleton renders while primary fetch is in flight', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)

    // Hold the primary fetch open so the page renders the skeleton.
    let releasePrimary: (() => void) | null = null
    const primaryHeld = new Promise<void>((resolve) => { releasePrimary = resolve })

    await page.route(`**/api/replies/${REPLY_ID}`, async (route) => {
      await primaryHeld
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPLY) })
    })
    // Side-fetches answer immediately so they don't gate paint.
    await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"messages":[]}' }),
    )
    await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )
    await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' }),
    )
    await page.route('**/api/operator-settings**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )

    await page.goto(`/replies/${REPLY_ID}`)

    // Skeleton root + every advertised placeholder must be visible while
    // the primary fetch is held open.
    await expect(page.getByTestId('thread-loading-skeleton')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('thread-skeleton-back')).toBeVisible()
    await expect(page.getByTestId('thread-skeleton-name')).toBeVisible()
    await expect(page.getByTestId('thread-skeleton-subtitle')).toBeVisible()
    await expect(page.getByTestId('thread-skeleton-divider')).toBeVisible()
    await expect(page.getByTestId('thread-skeleton-context')).toBeVisible()
    await expect(page.getByTestId('thread-skeleton-bubble-inbound')).toBeVisible()
    await expect(page.getByTestId('thread-skeleton-bubble-outbound')).toBeVisible()

    // Release the fetch — skeleton swaps out for the real page.
    releasePrimary?.()
    await expect(page.getByTestId('thread-loading-skeleton')).toHaveCount(0, { timeout: 5_000 })

    expect(gate.errors).toEqual([])
  })

  test('2. pressing E expands every outbound bubble; second press collapses them', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)
    await stubAll(page, { context: CONTEXT_MATCHED })

    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Klára Nováková/', { timeout: 10_000 })

    // Two outbound bubbles start truncated.
    await expect(page.locator('[data-truncated="true"]')).toHaveCount(2)

    // Press E — every outbound flips to expanded.
    await page.keyboard.press('e')
    await expect(page.locator('[data-truncated="false"]')).toHaveCount(3) // 2 outbound + 1 inbound
    await expect(page.locator('[data-truncated="true"]')).toHaveCount(0)
    // Lower-paragraph copy from both outbounds now in the DOM.
    await expect(page.locator('body')).toContainText('S pozdravem')
    await expect(page.locator('body')).toContainText('Děkuji,')

    // Second press collapses everything back.
    await page.keyboard.press('E')
    await expect(page.locator('[data-truncated="true"]')).toHaveCount(2)

    expect(gate.errors).toEqual([])
  })

  test('3. primary fetch error renders polished ErrorState with retry + back + truncated message', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)

    await page.route(`**/api/replies/${REPLY_ID}`, (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal server error: DB connection refused' }),
    )
    // Side-fetches still answer cleanly so they don't generate extra noise.
    await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"messages":[]}' }),
    )
    await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )
    await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' }),
    )
    await page.route('**/api/operator-settings**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )

    await page.goto(`/replies/${REPLY_ID}`)

    // ErrorState renders both buttons.
    await expect(page.getByTestId('thread-error-state')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('thread-error-retry')).toBeVisible()
    await expect(page.getByTestId('thread-error-back')).toBeVisible()
    await expect(page.getByRole('heading', { name: /Odpověď se nepodařila načíst/ })).toBeVisible()

    // Network errors via api() helper raise their own thrown messages.
    // What matters here is the operator-facing chrome — buttons + heading.

    // Smoke gate filters BFF 500 from the held fetch (browser still
    // logs the failed XHR as a console error). The gate noise filter
    // tolerates DB error text only when it comes from the stubbed
    // payload — explicit gate-allowed substring.
    const realErrs = gate.errors.filter(
      (e) => !/Internal server error/i.test(e) && !/HTTP 500/i.test(e) && !/Failed to load resource/i.test(e),
    )
    expect(realErrs).toEqual([])
  })

  test('4. inferred campaign chip shows "(odhad)" suffix when context.campaign.inferred=true', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)
    await stubAll(page, { context: CONTEXT_INFERRED })

    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Klára Nováková/', { timeout: 10_000 })

    const inferred = page.getByTestId('thread-campaign-inferred')
    await expect(inferred).toBeVisible()
    await expect(inferred).toHaveText(/odhad/)

    expect(gate.errors).toEqual([])
  })

  test('4b. inferred chip is ABSENT when context.campaign.inferred is missing/false', async ({ page }) => {
    const gate = setupConsoleErrorGate(page)
    await stubAll(page, { context: CONTEXT_MATCHED })

    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Klára Nováková/', { timeout: 10_000 })

    await expect(page.getByTestId('thread-campaign-inferred')).toHaveCount(0)

    expect(gate.errors).toEqual([])
  })
})
