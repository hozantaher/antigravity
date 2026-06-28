// ═══════════════════════════════════════════════════════════════════════════
//  AV-F2 — Auto-classify banner smoke
//
// Stubs /api/replies/:id + /api/threads/:id/{messages,context} + the new
// /api/replies/:id/classification endpoint, then verifies the banner renders
// with the expected label + percentage and the Schválit / Opravit ▾ flow
// PATCHes /api/replies/:id/classify with the right body.
//
// Strict console gate per HARD rule feedback_smoke_gate_operator_strict.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test'

const REPLY_ID = 7711
const NOW = Date.now()

const REPLY_PAYLOAD = {
  reply: {
    id: REPLY_ID,
    contact_name: 'Jan Novák',
    from_email: 'novak@stavby.cz',
    subject: 'Re: poptávka',
    campaign_name: 'Výkup techniky',
    classification: null,
    handled: false,
    received_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
    body_preview: 'Máme na prodej Hitachi ZX 130.',
  },
}

const CONTEXT_PAYLOAD = {
  company: { name: 'STAVBY s.r.o.', ico: '99887766' },
  contact: { name: 'Jan Novák', email: 'novak@stavby.cz' },
  campaign: { id: 7, name: 'Výkup techniky', status: 'running' },
}

const MESSAGES_PAYLOAD = {
  messages: [
    {
      id: 1,
      type: 'incoming',
      sender: 'novak@stavby.cz',
      sender_name: 'Jan Novák',
      sent_at: new Date(NOW - 30 * 60 * 1000).toISOString(),
      body: 'Máme na prodej Hitachi ZX 130.',
    },
  ],
}

const VERDICT_PAYLOAD = {
  ok: true,
  verdict: {
    classifier_version: 'regex_v1',
    classification: 'positive',
    confidence: 0.9,
    reasoning: {
      matched_patterns: ['máme', 'Hitachi'],
      score_breakdown: { selling: 0.8, brand: 0.1 },
      classifier_version: 'regex_v1',
    },
    applied: false,
    operator_override: null,
    operator_override_at: null,
    created_at: new Date(NOW - 60_000).toISOString(),
  },
}

async function stubThread(page: Page) {
  await page.route(`**/api/replies/${REPLY_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REPLY_PAYLOAD),
    })
  })
  await page.route(`**/api/threads/${REPLY_ID}/messages`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MESSAGES_PAYLOAD) }),
  )
  await page.route(`**/api/threads/${REPLY_ID}/context`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CONTEXT_PAYLOAD) }),
  )
  await page.route(`**/api/replies/${REPLY_ID}/attachments`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"attachments":[]}' }),
  )
  await page.route(`**/api/replies/${REPLY_ID}/classification`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VERDICT_PAYLOAD) }),
  )
}

function isHarmlessConsoleNoise(msg: ConsoleMessage): boolean {
  const text = msg.text()
  if (msg.type() !== 'error' && msg.type() !== 'warning') return true
  if (/React DevTools/i.test(text)) return true
  if (/favicon/i.test(text)) return true
  if (/sourcemap/i.test(text)) return true
  if (/preloaded using link preload but not used/i.test(text)) return true
  return false
}

test.describe('AV-F2 — Auto-classify banner', () => {
  test('renders banner with verdict and accepts via Schválit', async ({ page }) => {
    const consoleNoise: string[] = []
    page.on('console', (m) => {
      if (!isHarmlessConsoleNoise(m)) consoleNoise.push(`[${m.type()}] ${m.text()}`)
    })

    await stubThread(page)

    let patchedBody: unknown = null
    await page.route(`**/api/replies/${REPLY_ID}/classify`, (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      try {
        patchedBody = JSON.parse(route.request().postData() || 'null')
      } catch {
        patchedBody = null
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          reply: { ...REPLY_PAYLOAD.reply, classification: 'positive', handled: true },
        }),
      })
    })

    await page.goto(`/replies/${REPLY_ID}`)

    // Banner appears.
    const banner = page.getByTestId('auto-classify-banner')
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('auto-classify-label')).toHaveText('ZÁJEM')
    await expect(page.getByTestId('auto-classify-confidence')).toContainText('90')

    // AV-F4 (2026-05-19) — source chip shows which stage decided.
    // The VERDICT_PAYLOAD above sets classifier_version='regex_v1', so we
    // expect the chip to read "regex".
    await expect(page.getByTestId('auto-classify-source')).toHaveText('regex')

    // Schválit → PATCH /classify with classification=positive.
    await page.getByTestId('auto-classify-accept').click()
    await expect.poll(() => patchedBody).not.toBeNull()
    expect(patchedBody).toMatchObject({ classification: 'positive' })

    // Strict console gate.
    expect(consoleNoise, `Console noise:\n${consoleNoise.join('\n')}`).toEqual([])
  })

  test('AV-F4 — banner shows "ollama" chip when LLM stage decided', async ({ page }) => {
    const consoleNoise: string[] = []
    page.on('console', (m) => {
      if (!isHarmlessConsoleNoise(m)) consoleNoise.push(`[${m.type()}] ${m.text()}`)
    })

    await stubThread(page)
    // Override the classification stub so this case returns ollama_v1.
    await page.route(`**/api/replies/${REPLY_ID}/classification`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          verdict: {
            ...VERDICT_PAYLOAD.verdict,
            classifier_version: 'ollama_v1',
            reasoning: {
              ...VERDICT_PAYLOAD.verdict.reasoning,
              classifier_version: 'ollama_v1',
              rationale: 'Odesilatel popisuje stroj k prodeji.',
            },
          },
        }),
      }),
    )

    await page.goto(`/replies/${REPLY_ID}`)
    await expect(page.getByTestId('auto-classify-banner')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('auto-classify-source')).toHaveText('ollama')

    expect(consoleNoise, `Console noise:\n${consoleNoise.join('\n')}`).toEqual([])
  })

  test('Opravit ▾ overrides with a different classification', async ({ page }) => {
    const consoleNoise: string[] = []
    page.on('console', (m) => {
      if (!isHarmlessConsoleNoise(m)) consoleNoise.push(`[${m.type()}] ${m.text()}`)
    })

    await stubThread(page)

    let patchedBody: unknown = null
    await page.route(`**/api/replies/${REPLY_ID}/classify`, (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback()
      try {
        patchedBody = JSON.parse(route.request().postData() || 'null')
      } catch {
        patchedBody = null
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          reply: { ...REPLY_PAYLOAD.reply, classification: 'question', handled: true },
        }),
      })
    })

    await page.goto(`/replies/${REPLY_ID}`)
    await expect(page.getByTestId('auto-classify-banner')).toBeVisible({ timeout: 10_000 })

    await page.getByTestId('auto-classify-override-toggle').click()
    await expect(page.getByTestId('auto-classify-override-menu')).toBeVisible()
    await page.getByTestId('auto-classify-override-question').click()

    await expect.poll(() => patchedBody).not.toBeNull()
    expect(patchedBody).toMatchObject({ classification: 'question' })

    expect(consoleNoise, `Console noise:\n${consoleNoise.join('\n')}`).toEqual([])
  })
})
