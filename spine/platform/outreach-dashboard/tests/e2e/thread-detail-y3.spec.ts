// thread-detail-y3.spec.ts
//
// Interaction smoke for the Y3 (#1348) ThreadDetail cleanup wave on
// /replies/:id. Y3 cut redundant chrome (lastRefreshed clock, attachment
// header, classification block, "Otevřít firmu" link) and DEMOTED the
// right-rail context sidebar behind a collapsed-by-default toggle. The
// top context bar already surfaces Firma + IČO + ICP + region + campaign
// deep-link, so the sidebar is opt-in.
//
// This file asserts the toggle behavior:
//   1. Sidebar is collapsed by default (toggle button visible, panel not).
//   2. Clicking the toggle opens the panel + the toggle relabels to
//      "Detail kontextu".
//
// The existing thread-detail.spec.ts already covers happy-path render,
// PATCH /api/replies/:id mark-handled, graceful degradation, and 404 —
// this spec extends that surface with the Y3 sidebar mechanics.
//
// Per HARD RULE feedback_smoke_gate_operator_strict (T0) the console
// error gate is asserted.

import { test, expect, type Page } from '@playwright/test'

const REPLY_ID = 42

const REPLY = {
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

const MESSAGES = {
  messages: [
    {
      id: 1,
      from_email: 'jan@alpha.cz',
      to_email: 'sales@firma.cz',
      subject: 'Re: spolupráce',
      body: 'Děkuji za nabídku.',
      sent_at: '2026-04-22T10:00:00Z',
      direction: 'inbound',
    },
  ],
}

const CONTEXT = {
  company: {
    name: 'Alpha Strojírna s.r.o.',
    ico: '12345678',
    sector: 'Strojírenství',
  },
  campaign: {
    id: 457,
    name: 'Strojírenství — první kontakt',
    sent_count: 200,
    replied_count: 5,
  },
}

async function stubThread(page: Page) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REPLY),
    })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MESSAGES),
    })
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(CONTEXT),
    })
  )
}

function filterConsoleErrors(consoleErrors: string[]): string[] {
  return consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !(e.includes('preload') && !e.includes('status of')) &&
    !e.includes('status of 200') &&
    !e.includes('status of 301') &&
    !e.includes('status of 302') &&
    !e.includes('status of 304')
  )
}

function attachConsoleGate(page: Page): string[] {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })
  return consoleErrors
}

test.describe('Y3 — ThreadDetail sidebar collapsed by default', () => {
  test('Y3-A — Sidebar toggle is rendered "Detail" (collapsed) on first load', async ({ page }) => {
    const consoleErrors = attachConsoleGate(page)
    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)

    // Reply header loads — confirms the page rendered.
    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })

    // Toggle button is present + labeled "Detail" when collapsed.
    const toggle = page.locator('[data-testid="thread-sidebar-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 5000 })
    await expect(toggle).toHaveText(/Detail$/)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')

    // The context-sidebar panel itself is NOT rendered when closed.
    await expect(page.locator('[data-testid="context-sidebar"]')).toHaveCount(0)

    const ourErrors = filterConsoleErrors(consoleErrors)
    expect(ourErrors, `console errors:\n${ourErrors.join('\n')}`).toHaveLength(0)
  })

  test('Y3-B — Clicking the toggle expands the context sidebar', async ({ page }) => {
    const consoleErrors = attachConsoleGate(page)
    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)

    await page.waitForSelector('text=/Jan Novák/', { timeout: 10_000 })

    const toggle = page.locator('[data-testid="thread-sidebar-toggle"]')
    await expect(toggle).toBeVisible({ timeout: 5000 })
    await toggle.click()

    // After expand: panel renders, aria-expanded flips, label changes.
    await expect(page.locator('[data-testid="context-sidebar"]')).toBeVisible({ timeout: 3000 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveText(/Detail kontextu/)

    // Sidebar surfaces firma data fetched from /context. We scope the
    // assertion to inside the context-sidebar element since the top
    // context bar also renders the firma name when collapsed — the
    // sidebar version is the one Y3 demoted behind the toggle.
    await expect(
      page.locator('[data-testid="context-sidebar"]').getByText(/Alpha Strojírna/)
    ).toBeVisible()

    const ourErrors = filterConsoleErrors(consoleErrors)
    expect(ourErrors, `console errors:\n${ourErrors.join('\n')}`).toHaveLength(0)
  })
})
