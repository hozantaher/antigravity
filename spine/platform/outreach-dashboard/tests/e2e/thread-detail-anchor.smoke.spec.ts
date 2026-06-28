// ═══════════════════════════════════════════════════════════════════════════
//  AM-F2 — ThreadDetail anchor + rhythm-divider smoke
//
// Goto /replies/<id> with a stubbed 6-day-old conversation and verify:
//   - the big 24px contact-name anchor renders
//   - a rhythm divider with "dní bez odpovědi" sits between the two bubbles
//   - the page loads without 4xx/5xx console errors (strict gate per
//     HARD rule `feedback_smoke_gate_operator_strict`).
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

const REPLY_ID = 4242
const NOW = Date.now()

const REPLY = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Petr Beneš',
    from_email: 'petr@brnenska-strojirna.cz',
    subject: 'Re: nabídka pro Brněnskou strojírnu',
    campaign_name: 'Strojírny Q2',
    classification: 'positive',
    handled: false,
    received_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
  },
}

// 3 messages spanning 6 days:
//   - outbound 6 days ago (auto_send)
//   - inbound 1 day ago (incoming) → 5-day gap divider
//   - inbound 1 hour ago (incoming) → 23-hour gap divider
const MESSAGES = {
  messages: [
    {
      id: 1,
      type: 'auto_send',
      sender: 'sales@brand.cz',
      sender_name: 'Sales',
      sent_at: new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString(),
      body: 'Dobrý den, posíláme nabídku.',
    },
    {
      id: 2,
      type: 'incoming',
      sender: 'petr@brnenska-strojirna.cz',
      sender_name: 'Petr Beneš',
      sent_at: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
      body: 'Děkuji za nabídku, ozvu se.',
    },
    {
      id: 3,
      type: 'incoming',
      sender: 'petr@brnenska-strojirna.cz',
      sender_name: 'Petr Beneš',
      sent_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
      body: 'Mám pár doplňujících dotazů.',
    },
  ],
}

const CONTEXT = {
  company: { name: 'Brněnská strojírna s.r.o.', ico: '12345678' },
  campaign: { id: 5, name: 'Strojírny Q2', status: 'running' },
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES) })
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTEXT) })
  )
  await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' })
  )
}

// Console-error guard mirroring the operator-strict pattern in
// today-shipped-surfaces.smoke.spec.ts. Filter known-harmless noise;
// fail on anything that smells like a real 4xx/5xx.
function isHarmlessConsoleNoise(msg: ConsoleMessage): boolean {
  const text = msg.text()
  if (msg.type() !== 'error' && msg.type() !== 'warning') return true
  if (/React DevTools/i.test(text)) return true
  if (/favicon/i.test(text)) return true
  if (/sourcemap/i.test(text)) return true
  if (/preloaded using link preload but not used/i.test(text)) return true
  return false
}

test.describe('AM-F2 — /replies/:id detail anchor + rhythm timeline', () => {
  test('renders the big-anchor header + a rhythm divider between bubbles', async ({ page }) => {
    const consoleNoise: string[] = []
    page.on('console', (m) => {
      if (!isHarmlessConsoleNoise(m)) consoleNoise.push(`[${m.type()}] ${m.text()}`)
    })

    await stubThread(page)
    await page.goto(`/replies/${REPLY_ID}`)

    // 1) Big anchor header — contact name as h2 heading.
    const heading = page.getByRole('heading', { name: 'Petr Beneš', level: 2 })
    await expect(heading).toBeVisible({ timeout: 10_000 })

    // 2) Company chip + IČO chip in the supporting context row.
    await expect(page.getByTestId('anchor-company-chip')).toBeVisible()
    await expect(page.getByTestId('anchor-ico-chip')).toHaveText(/IČO 12345678/)

    // 3) Classification badge.
    await expect(page.getByTestId('anchor-classification-badge')).toHaveText('Zájem')

    // 4) Rhythm divider between the 6-day-apart bubbles.
    const dividers = page.getByTestId('rhythm-divider')
    await expect(dividers.first()).toBeVisible()
    await expect(dividers.first()).toContainText(/dní bez odpovědi/)

    // 5) No 4xx/5xx console errors leaked (strict gate).
    expect(consoleNoise, `Console noise observed:\n${consoleNoise.join('\n')}`).toEqual([])
  })
})
