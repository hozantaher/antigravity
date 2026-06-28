// ═══════════════════════════════════════════════════════════════════════════
//  /replies/:id (ThreadDetail) — E2E (previously only vitest ThreadDetail.test.jsx)
//
// Locks the single-reply triage surface — thread header, classification
// badge, mark-handled action, reply composer submission, back navigation,
// graceful degradation when secondary /messages + /context fetches fail.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test'

const REPLY_ID = 42
const REPLY_UNHANDLED = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Jan Novák',
    from_email: 'jan@alpha.cz',
    subject: 'Re: spolupráce na projektu X',
    campaign_name: 'Strojírenství — první kontakt',
    classification: 'positive',
    handled: false,
    received_at: '2026-04-22T10:00:00Z',
  },
}

const REPLY_HANDLED = {
  reply: {
    ...REPLY_UNHANDLED.reply,
    handled: true,
  },
}

const MESSAGES = {
  messages: [
    { id: 1, from_email: 'jan@alpha.cz', to_email: 'sales@firma.cz', subject: 'Re: spolupráce', body: 'Děkuji za nabídku. Zájem máme.', sent_at: '2026-04-22T10:00:00Z', direction: 'inbound' },
    { id: 2, from_email: 'sales@firma.cz', to_email: 'jan@alpha.cz', subject: 'spolupráce', body: 'Dobrý den, rádi bychom navázali…', sent_at: '2026-04-20T09:00:00Z', direction: 'outbound' },
  ],
}

const CONTEXT = {
  company_name: 'Alpha Strojírna s.r.o.',
  company_id: 101,
  website: 'https://alpha-stroj.cz',
  open_deals: 0,
}

async function stubThread(page: Page, opts: {
  reply?: unknown,
  replyStatus?: number,
  messages?: unknown,
  messagesStatus?: number,
  context?: unknown,
  contextStatus?: number,
} = {}) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: opts.replyStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.reply ?? REPLY_UNHANDLED),
    })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({
      status: opts.messagesStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.messages ?? MESSAGES),
    })
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({
      status: opts.contextStatus ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.context ?? CONTEXT),
    })
  )
}

test.describe('/replies/:id — happy path', () => {
  test('renders reply header with contact + subject + classification badge', async ({ page }) => {
    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await expect(page.locator('text=/jan@alpha.cz/').first()).toBeVisible()
    await expect(page.locator('text=/Re: spolupráce/').first()).toBeVisible()
    await expect(page.locator('text=/Strojírenství/').first()).toBeVisible()
    // Classification badge label (positive → "Zájem")
    await expect(page.locator('text=/^Zájem$/').first()).toBeVisible()
  })

  test('message body renders (inbound + outbound from /threads/:id/messages)', async ({ page }) => {
    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    // Both messages render (testid data-testid="message-body")
    const bodies = page.getByTestId('message-body')
    await expect(bodies).toHaveCount(2)
    await expect(bodies.first()).toContainText(/Děkuji za nabídku/)
  })

  test('"Zpět" button navigates to /replies', async ({ page }) => {
    await stubThread(page)
    // Stub /replies so the listing page loads after back-navigation.
    await page.route('**/api/replies?**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"rows":[],"total":0}' })
    )
    await page.route('**/api/replies/stats', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"unhandled":0}' })
    )
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await page.getByRole('button', { name: /Zpět/ }).click()
    // URL is now /replies
    await expect(page).toHaveURL(/\/replies$/)
  })
})

test.describe('/replies/:id — mark handled action', () => {
  test('PATCH /api/replies/:id fires with {handled:true} + success toast', async ({ page }) => {
    let patchBody: unknown = null
    await stubThread(page)
    await page.route(`**/api/replies/${REPLY_ID}`, async (route) => {
      const m = route.request().method()
      if (m === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPLY_UNHANDLED) })
      }
      if (m === 'PATCH') {
        try { patchBody = JSON.parse(route.request().postData() ?? '{}') } catch {}
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      }
      return route.fallback()
    })
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    const btn = page.getByRole('button', { name: /Zpracováno/ })
    await expect(btn).toBeVisible()
    await btn.click()
    await expect.poll(() => patchBody, { timeout: 5_000 }).toEqual({ handled: true })
    await expect(page.locator('text=/Označeno jako zpracováno/')).toBeVisible({ timeout: 3_000 })
  })

  test('button is hidden when reply already handled', async ({ page }) => {
    await stubThread(page, { reply: REPLY_HANDLED })
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await expect(page.getByRole('button', { name: /Zpracováno/ })).toHaveCount(0)
  })

  test('PATCH 500 surfaces "Nepodařilo se uložit" error toast', async ({ page }) => {
    await stubThread(page)
    await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPLY_UNHANDLED) })
      }
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'db down' })
    })
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await page.getByRole('button', { name: /Zpracováno/ }).click()
    await expect(page.locator('text=/Nepodařilo se uložit/')).toBeVisible({ timeout: 3_000 })
  })
})

test.describe('/replies/:id — graceful degradation', () => {
  test('messages fetch 500 → page still renders with reply header (log-only failure)', async ({ page }) => {
    await stubThread(page, { messagesStatus: 500, messages: { error: 'db' } })
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    // No error state shown to user for secondary fetch failure.
    await expect(page.locator('text=/Jan Novák/')).toBeVisible()
  })

  test('context fetch 500 → page still renders', async ({ page }) => {
    await stubThread(page, { contextStatus: 500, context: { error: 'db' } })
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    await expect(page.locator('text=/Jan Novák/')).toBeVisible()
  })
})

test.describe('/replies/:id — error states', () => {
  test('reply 404 renders friendly Czech "Nenalezeno" (does NOT leak backend error)', async ({ page }) => {
    await stubThread(page, { replyStatus: 404, reply: { error: 'internal DB stacktrace with secrets' } })
    await page.goto(`/replies/${REPLY_ID}`)
    // Friendly copy rendered (role=alert)
    await expect(page.locator('text=/Nenalezeno/')).toBeVisible({ timeout: 10_000 })
    // Backend error text MUST NOT appear in UI (security: no raw error leak).
    await expect(page.locator('text=/stacktrace with secrets/')).toHaveCount(0)
  })
})

test.describe('/replies/:id — reply composer', () => {
  test('sending empty body is a no-op (disabled)', async ({ page }) => {
    let postFired = false
    await stubThread(page)
    await page.route(`**/api/replies/${REPLY_ID}/reply`, (route) => {
      postFired = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    })
    await page.goto(`/replies/${REPLY_ID}`)
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })
    // Try to find Odeslat (send) button and click it without body text.
    const send = page.getByRole('button', { name: /Odeslat/i })
    if (await send.count() > 0) {
      await send.first().click({ force: true }).catch(() => {})
    }
    await page.waitForTimeout(400)
    expect(postFired).toBe(false)
  })
})
