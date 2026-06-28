// ═══════════════════════════════════════════════════════════════════════════
//  AL-F2 — /replies/:id sticky bottom dock smoke
//
// Verifies the chat-input style dock landed:
//  • dock container is visible (data-testid="thread-action-dock")
//  • the 5 compact classify icon buttons are present + accessible
//  • the composer textarea + Odeslat send button render
//  • no console errors / pageerrors / failed XHRs (per
//    feedback_smoke_gate_operator_strict T0 HARD RULE)
//
// Triage flow + send behavior have deeper coverage in
// tests/e2e/thread-detail.spec.ts and the vitest unit suite — this
// pack is the cheap "did the surface land" gate.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, assertClean } from './_fixtures/console-guard'
import type { Page } from '@playwright/test'

const REPLY_ID = 42
const REPLY_UNHANDLED = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Jan Novák',
    from_email: 'jan@alpha.cz',
    subject: 'Re: spolupráce',
    campaign_name: 'Strojírenství — první kontakt',
    classification: 'positive',
    handled: false,
    received_at: '2026-04-22T10:00:00Z',
  },
}

const REPLY_HANDLED = {
  reply: { ...REPLY_UNHANDLED.reply, handled: true },
}

async function stubThread(page: Page, opts: { reply?: unknown } = {}) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(opts.reply ?? REPLY_UNHANDLED),
    })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"messages":[]}' }),
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  )
  await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' }),
  )
}

test.describe('/replies/:id — AL-F2 sticky bottom dock', () => {
  test('dock renders at bottom with classify icons + composer (happy path)', async ({ page, errs }) => {
    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)

    // Header proves React mounted + reply fetch succeeded.
    await expect(page.locator('text=/Jan Novák/').first()).toBeVisible({ timeout: 10_000 })

    // Dock container itself.
    const dock = page.getByTestId('thread-action-dock')
    await expect(dock).toBeVisible()

    // Compact classify-actions row inside the dock.
    const classify = page.getByTestId('classify-actions')
    await expect(classify).toBeVisible()

    // AS-F3 (2026-05-19) — 4 classify buttons; the standalone "Vyřízeno"
    // button was removed because any classify action already marks the
    // thread as handled via handleClassify. Operators tap one of:
    // Zájem / Není zájem / Otázka / Unsubscribe.
    for (const label of ['Zájem', 'Není zájem', 'Otázka', 'Unsubscribe']) {
      await expect(page.getByRole('button', { name: label }).first()).toBeVisible()
    }
    // Vyřízeno button is gone from the classify row (reuse `classify` from above).
    await expect(classify.getByRole('button', { name: 'Vyřízeno' })).toHaveCount(0)

    // Composer textarea + Odeslat send button.
    await expect(page.getByPlaceholder(/Napište odpověď/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Odeslat/i }).first()).toBeVisible()

    // Sticky positioning sanity — the dock sits inside the page document
    // (sticky elements aren't position:fixed; bottom alignment is enforced
    // by CSS sticky on scroll).
    const styles = await dock.evaluate((el) => ({
      position: getComputedStyle(el).position,
      bottom: getComputedStyle(el).bottom,
    }))
    expect(styles.position).toBe('sticky')
    expect(styles.bottom).toBe('0px')

    assertClean(errs)
  })

  test('handled thread hides composer + classify, shows "Označeno jako vyřízeno"', async ({ page, errs }) => {
    await stubThread(page, { reply: REPLY_HANDLED })
    await page.goto(`/replies/${REPLY_ID}`)
    await expect(page.locator('text=/Jan Novák/').first()).toBeVisible({ timeout: 10_000 })

    const dock = page.getByTestId('thread-action-dock')
    await expect(dock).toBeVisible()

    // Compact icon classify row is hidden (handled === true gate).
    await expect(page.getByTestId('classify-actions')).toHaveCount(0)
    // Composer textarea hidden too.
    await expect(page.getByPlaceholder(/Napište odpověď/)).toHaveCount(0)

    // Handled caption + reopen-triage link present.
    await expect(page.getByTestId('thread-handled-caption')).toBeVisible()
    await expect(page.getByText(/Označeno jako vyřízeno/)).toBeVisible()
    await expect(page.getByTestId('thread-reopen-triage')).toBeVisible()

    assertClean(errs)
  })
})
