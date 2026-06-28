// app-odpovedi.smoke.spec.ts
//
// Smoke pack for the single-screen triage (#1586) — now the canonical
// /odpovedi surface (Odpovedi superseded the original Odpovedi list).
// Per HARD RULE feedback_playwright_smoke_required: goto + visible headline +
// open a reply + assert ActionRail + composer visible + NO console error.
// Per feedback_smoke_gate_operator_strict: any 4xx/5xx surfaces as a failure
// (response listener captures the offending URL — #1298 guard).
//
// Self-contained: route-stubs all /api/* so it passes headless without a live
// BFF. Captures light + dark screenshots (localStorage uiTheme) to /tmp.

import { test, expect, Page } from '@playwright/test'

const REPLY_ID = 9301

const ROW = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  contact_id: id,
  campaign_id: 71,
  from_email: `petr${id}@strojirna.cz`,
  contact_name: `Petr Beneš ${id}`,
  subject: `RE: výkup bagru Komatsu ${id}`,
  body_text_preview: `Dobrý den, máme zájem prodat bagr. Zavolejte na 603 ${id}.`,
  classification: 'positive',
  received_at: new Date(Date.now() - id % 100 * 3600_000).toISOString(),
  handled: false,
  flagged: false,
  campaign_name: 'Výkup techniky Q2',
  has_vehicle: false,
  mined: { phones: [{ display: '+420 603 123 456', tel: '+420603123456' }], prices: [{ amount: 320000 }], callback: true, urgent: true, locations: ['Brno'] },
  ...over,
})

const ROWS = [ROW(REPLY_ID), ROW(9302), ROW(9303)]

const DETAIL = {
  reply: {
    ...ROW(REPLY_ID),
    pre_classification: { intent: 'positive', confidence: 0.84, classifier_version: 'v3' },
    signature: { company: 'Brněnská strojírna s.r.o.', ico: '12345678', crmMatch: { name: 'Strojírna', crm_status: 'active' } },
  },
}

const STATS = { nezpracovane: 3, zajem: 2, dotazy: 0, odmitnuti: 0, hot_unhandled: 2, phone_unhandled: 2 }

const MESSAGES = {
  messages: [
    { id: 1, direction: 'outbound', kind: 'auto_send', sent_at: new Date(Date.now() - 2 * 86400_000).toISOString(), body_text: 'Dobrý den, vykupujeme techniku. Máte zájem o prodej?' },
    { id: 2, direction: 'inbound', sent_at: new Date(Date.now() - 3600_000).toISOString(), body_text: 'Ano, máme bagr na prodej. Zavolejte mi.' },
  ],
}

async function ensureLoggedIn(page: Page) {
  // Dev-only auth seam (project_v2_local_auth_seam): the operator_id cookie
  // bypasses the Firebase RequireAuth gate that otherwise redirects /* to
  // /login headlessly. Same pattern as app-reply-attachments.smoke.spec.ts.
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
  // SSE endpoints (real-time, Track C) MUST be served as text/event-stream —
  // otherwise EventSource logs a MIME console.error that trips the operator-strict
  // gate. Registered LAST so they win over the greedy **/api/replies/* detail
  // route that would otherwise serve /api/replies/stream as application/json.
  await page.route('**/api/replies/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }))
  await page.route('**/api/threads/stream', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' }))
}

function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  // Capture the URL of any 4xx/5xx (the bare "Failed to load resource: 404"
  // console error omits it — #1298).
  page.on('response', (r) => { if (r.status() >= 400) errs.push(`http ${r.status()}: ${r.url()}`) })
  return errs
}

test('/odpovedi — headline, 4 chips, lead opens with phone hero + composer', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await stub(page)
  await page.goto('/odpovedi')

  // Headline (the badge was dropped — this is the canonical page now, #1586).
  await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 15_000 })
  // Title now lives in the topbar <h1> (folder-rail duplicate removed in S2).
  await expect(page.getByRole('heading', { name: 'Odpovědi', level: 1 })).toBeVisible()
  await expect(page.locator('.app-badge')).toHaveCount(0)

  // Exactly 4 filter chips.
  for (const key of ['unhandled', 'hot', 'phone', 'all']) {
    await expect(page.getByTestId(`app-chip-${key}`)).toBeVisible()
  }

  // Open the first lead → right pane shows the conversation + hero + facts.
  await page.getByTestId('app-reply-row').first().click()
  await expect(page).toHaveURL(/[?&]id=\d+/)
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })

  // Phone-as-hero ActionRail with a tel: call button.
  await expect(page.getByTestId('app-actionrail')).toBeVisible()
  const call = page.getByTestId('app-actionrail-call')
  await expect(call).toBeVisible()
  await expect(call).toHaveAttribute('href', /^tel:\+420603123456$/)

  // Merged Facts strip surfaces the company + price.
  await expect(page.getByTestId('app-facts')).toBeVisible()
  await expect(page.getByTestId('app-fact-company')).toContainText('Brněnská strojírna')

  // AI classification is behind a collapsed disclosure.
  await expect(page.getByTestId('app-ai-disclosure')).toBeVisible()

  // Sticky composer present.
  await expect(page.getByTestId('app-composer')).toBeVisible()
  await expect(page.getByTestId('app-compose-text')).toBeVisible()

  // Conversation rendered.
  await expect(page.getByText('Ano, máme bagr na prodej. Zavolejte mi.')).toBeVisible({ timeout: 8_000 })

  // Light screenshot.
  await page.screenshot({ path: '/tmp/app-odpovedi-light.png', fullPage: false })

  // Dark mode — AppShell reads localStorage 'uiTheme' + flips .app-shell[data-theme].
  await page.evaluate(() => localStorage.setItem('uiTheme', 'dark'))
  await page.reload()
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.app-shell')?.getAttribute('data-theme')), { timeout: 5_000 })
    .toBe('dark')
  await page.screenshot({ path: '/tmp/app-odpovedi-dark.png', fullPage: false })

  expect(errs, errs.join('\n')).toHaveLength(0)
})
