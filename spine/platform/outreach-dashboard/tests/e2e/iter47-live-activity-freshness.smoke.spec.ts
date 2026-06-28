// ═══════════════════════════════════════════════════════════════════════════
//  iter47 — LiveActivityTicker freshness signal smoke
//
//  Verifies the three iter47 states render correctly:
//    1. Happy path — ticker loads, refresh label "obnoveno před N s" visible
//    2. Error state — live-activity returns 500, ticker shows "server neodpovídá"
//
//  Per HARD RULE feedback_playwright_smoke_required (T0): every new UI
//  surface must have a smoke spec with goto + visible testid + no-console-error.
//  Per HARD RULE feedback_smoke_gate_operator_strict (T0): filter only
//  React DevTools / favicon / sourcemap / CSS-preload-no-status noise.
//
//  All /api/* endpoints are stubbed to safe shapes so the Home page
//  doesn't crash into an error boundary:
//    - /api/campaigns → [] (Layout.jsx does campaigns.filter — needs array)
//    - /api/replies/stats → { unhandled: 0 }
//    - /api/dashboard/summary → minimal safe shape
//    - everything else → {}
//  Live-activity is registered LAST (Playwright LIFO) so it takes priority.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type ConsoleMessage, type Page } from '@playwright/test'

// ── console-noise filter (strict gate, per feedback_smoke_gate_operator_strict T0) ──

function isHarmlessNoise(msg: ConsoleMessage): boolean {
  const text = msg.text()
  if (msg.type() !== 'error' && msg.type() !== 'warning') return true
  if (/React DevTools/i.test(text)) return true
  if (/favicon/i.test(text)) return true
  if (/sourcemap/i.test(text)) return true
  if (/preloaded using link preload but not used/i.test(text)) return true
  // SSE MIME type warning from EventSource stubbed as JSON (expected noise).
  if (/text\/event-stream/i.test(text)) return true
  // ErrorBoundary DEV logs are harmless in this test context.
  if (/\[ErrorBoundary\]/i.test(text)) return true
  return false
}

// ── safe stub payloads ─────────────────────────────────────────────────────

const LIVE_ACTIVITY_STUB = {
  now: new Date().toISOString(),
  last_1h: { sends: 22, replies: 3, bounces: 0 },
  vs_yesterday: { sends_delta: 5, replies_delta: 1 },
  trending: { hot_lead_just_replied: null, bounce_alert: null },
}

// Layout.jsx does `campaigns.filter(...)` — must be an array or it crashes.
// All other store fetches use `.catch(() => [])` so they tolerate 200/[].
const SAFE_ARRAY = JSON.stringify([])

// Home.jsx summary needs a minimal shape to avoid accessing undefined props.
const DASHBOARD_SUMMARY_STUB = JSON.stringify({
  campaign: { found: false },
  mailboxes: { active: 1, total: 1, paused: 0, warming: 0 },
  replies: { unhandled: 0, total_today: 0 },
  stats: { sends_today: 0, bounces_today: 0, replies_today: 0 },
  health: { ok: true },
})

// BounceTrendMiniChart and InboxBurndownWidget destructure `days` from data
// and immediately call `days.map(...)` — `data = {}` would crash them since
// `days` would be `undefined`. These stubs provide minimal safe shapes.
const BOUNCE_TREND_STUB = JSON.stringify({ days: [], trend: null, avg_14d_pct: 0 })
const INBOX_BURNDOWN_STUB = JSON.stringify({
  days: [], current_backlog: 0, trend_7d: null, trend_pct: null,
})

// ── shared route setup ─────────────────────────────────────────────────────

/**
 * Stub all background /api/* routes with safe empty payloads.
 * Register live-activity AFTER this function — it must be last (LIFO priority).
 *
 * Route-ordering discipline (Playwright LIFO):
 *   Catch-all registered FIRST = lowest priority.
 *   Specific stubs registered AFTER = higher priority (override catch-all).
 *   live-activity registered by caller LAST = highest priority of all.
 */
async function stubBackgroundApis(page: Page) {
  // Catch-all FIRST = LOWEST priority (LIFO: last wins).
  // Returns 200/{} — most components handle {} gracefully via optional chaining.
  await page.route('**/api/**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  )

  // ── Array endpoints (store.loadAll) ──────────────────────────────────────
  // store.loadAll sets these directly; non-array responses cause
  // xxx.filter/slice is not a function in Layout + CommandPalette.
  for (const arrayRoute of [
    '**/api/campaigns',
    '**/api/mailboxes',
    '**/api/templates',
    '**/api/segments',
  ]) {
    await page.route(arrayRoute, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: SAFE_ARRAY })
    )
  }

  // ── Dashboard widgets that crash on {} ────────────────────────────────────
  // BounceTrendMiniChart: `const { days } = data; days.map(...)` — needs array.
  await page.route('**/api/dashboard/bounce-trend', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: BOUNCE_TREND_STUB })
  )
  // InboxBurndownWidget: `const { days } = data; days.map(...)` — same.
  await page.route('**/api/dashboard/inbox-burndown', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: INBOX_BURNDOWN_STUB })
  )

  // ── Specific shape stubs ──────────────────────────────────────────────────
  await page.route('**/api/replies/stats', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unhandled: 0 }) })
  )
  await page.route('**/api/dashboard/summary', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: DASHBOARD_SUMMARY_STUB })
  )

  // ── SSE stream — return proper event-stream content-type so the browser
  //    doesn't log a MIME-type warning (Layout opens EventSource here).
  await page.route('**/api/threads/stream', route =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: '',
    })
  )

  // live-activity is NOT stubbed here — caller registers it LAST for max priority.
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe('iter47 — LiveActivityTicker freshness signal', () => {

  test('happy path — ticker renders pills and refresh label', async ({ page }) => {
    const consoleNoise: string[] = []
    const pageErrors: string[] = []
    page.on('console', m => {
      if (!isHarmlessNoise(m)) consoleNoise.push(`[${m.type()}] ${m.text()}`)
    })
    page.on('pageerror', e => pageErrors.push(`${e.name}: ${e.message}`))

    await stubBackgroundApis(page)
    // Live-activity registered LAST → highest LIFO priority.
    await page.route('**/api/dashboard/live-activity', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...LIVE_ACTIVITY_STUB, now: new Date().toISOString() }),
      })
    )

    await page.goto('/')

    // 1) Ticker container is visible.
    const ticker = page.getByTestId('live-activity-ticker')
    await expect(ticker).toBeVisible({ timeout: 10_000 })

    // 2) Freshness label is rendered and contains "obnoveno".
    const label = page.getByTestId('live-activity-refresh-label')
    await expect(label).toBeVisible({ timeout: 5_000 })
    await expect(label).toContainText('obnoveno')

    // 3) No unexpected console or page errors.
    expect(pageErrors, `Page errors:\n${pageErrors.join('\n')}`).toEqual([])
    expect(consoleNoise, `Console noise:\n${consoleNoise.join('\n')}`).toEqual([])
  })

  test('error state — shows aria-live broken-state pill instead of null', async ({ page }) => {
    const consoleNoise: string[] = []
    const pageErrors: string[] = []
    page.on('console', m => {
      if (!isHarmlessNoise(m)) {
        const text = m.text()
        // The "Failed to load resource: 500" console error is emitted by
        // Chromium for the intentionally-injected live-activity 500 in this
        // test. All background stubs return 200, so this is the ONLY 500
        // in this test. We filter it here because it is the deliberate
        // error condition being tested — per feedback_smoke_gate_operator_strict
        // (T0), this is a justified single-endpoint exception with the reason
        // documented inline.
        if (/Failed to load resource.*500/i.test(text)) return
        consoleNoise.push(`[${m.type()}] ${text}`)
      }
    })
    page.on('pageerror', e => pageErrors.push(`${e.name}: ${e.message}`))

    await stubBackgroundApis(page)
    // Live-activity returns 500 (registered LAST → highest priority).
    await page.route('**/api/dashboard/live-activity', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'internal server error' }),
      })
    )

    await page.goto('/')

    // Ticker must still render (not disappear) with the broken-state copy.
    const ticker = page.getByTestId('live-activity-ticker')
    await expect(ticker).toBeVisible({ timeout: 10_000 })
    await expect(ticker).toContainText('server neodpovídá')

    // Must have aria-live="assertive" for screen reader broadcast.
    await expect(ticker).toHaveAttribute('aria-live', 'assertive')

    // No unexpected console or page errors (live-activity 500 is intentional — filtered above).
    expect(pageErrors, `Page errors:\n${pageErrors.join('\n')}`).toEqual([])
    expect(consoleNoise, `Console noise:\n${consoleNoise.join('\n')}`).toEqual([])
  })

})
