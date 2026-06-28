// ═══════════════════════════════════════════════════════════════════════════
//  AP-F5 (2026-05-18) — /replies/:id composer-first dock smoke.
//
//  Verifies the AP-F5 reorder landed:
//    • Composer textarea sits ABOVE the classify row in DOM order.
//    • Czech framing label "Hotovo s tímhle? →" precedes the classify
//      icons (post-action framing, not pre-compose distraction).
//    • Send button is disabled (data-active="false") when textarea empty.
//    • Typing into the textarea flips the send button to data-active="true"
//      and removes the disabled attribute.
//    • Background of the active send button resolves to Signal blue
//      rgb(44, 107, 237) — the AO --c-accent token.
//    • No 4xx/5xx console errors during load (HARD RULE
//      feedback_smoke_gate_operator_strict T0).
//
//  All /api/* calls are mocked with page.route() so the spec runs without
//  a live BFF — matching the operator-strict smoke gate convention.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, assertClean } from './_fixtures/console-guard'
import type { Page } from '@playwright/test'

const REPLY_ID = 77
const REPLY_UNHANDLED = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Petra Marková',
    from_email: 'petra@beta.cz',
    subject: 'Re: poptávka',
    campaign_name: 'Strojírenství — první kontakt',
    classification: null,
    handled: false,
    received_at: '2026-05-17T08:00:00Z',
  },
}

async function stubThread(page: Page) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REPLY_UNHANDLED),
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
  await page.route('**/api/operator-settings**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
  await page.route('**/api/notifications**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  )
}

test.describe('/replies/:id — AP-F5 composer-first dock', () => {
  test('composer textarea sits ABOVE the classify row + framing label visible', async ({ page, errs }) => {
    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)

    await expect(page.locator('text=/Petra Marková/').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('thread-action-dock')).toBeVisible()

    // Framing label precedes the classify icons.
    await expect(page.getByTestId('thread-dock-post-label')).toHaveText('Hotovo s tímhle? →')

    // DOM order: textarea ABOVE classify row.
    const order = await page.evaluate(() => {
      const textarea = document.querySelector('[data-testid="thread-composer-textarea"]')
      const classify = document.querySelector('[data-testid="classify-actions"]')
      if (!textarea || !classify) return null
      // eslint-disable-next-line no-bitwise
      return Boolean(textarea.compareDocumentPosition(classify) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(order).toBe(true)

    assertClean(errs)
  })

  test('send button is disabled when empty, active + accent-colored once text typed', async ({ page, errs }) => {
    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)

    await expect(page.getByTestId('thread-action-dock')).toBeVisible({ timeout: 10_000 })

    const send = page.getByTestId('thread-composer-send')
    const textarea = page.getByTestId('thread-composer-textarea')

    // Empty — disabled + data-active="false".
    await expect(send).toBeDisabled()
    await expect(send).toHaveAttribute('data-active', 'false')

    // Type something. data-active flips, disabled clears.
    await textarea.fill('Díky za zájem, vrátím se s konkrétní nabídkou.')
    await expect(send).toHaveAttribute('data-active', 'true')
    await expect(send).not.toBeDisabled()

    // Active background resolves to Signal blue (AO --c-accent).
    const bg = await send.evaluate((el) => window.getComputedStyle(el as HTMLElement).backgroundColor)
    expect(bg).toBe('rgb(44, 107, 237)')

    assertClean(errs)
  })
})
