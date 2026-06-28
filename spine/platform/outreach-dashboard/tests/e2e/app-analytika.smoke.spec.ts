// app-analytika.smoke.spec.ts
//
// Analytika — metrics hub (KPI / Trendy / Crony / Funnel) on the frame.
// Per HARD RULE feedback_playwright_smoke_required. Drives the real local BFF
// and asserts the page renders its frame (headline + tab bar) and that every
// tab's panel renders one of its terminal states (data / empty / error) with no
// console errors. Read-only surface — the smoke mutates nothing.
//
// Heavy-endpoint note (per task brief + project memory): some analytics queries
// (funnel/summary, synthetic-runs, reputation-score, …) are heavy on the PROD
// DB the local BFF points at and can intermittently 500 ("shared memory" / "No
// space left"). The page renders a graceful error state for those (useResource),
// and the smoke asserts panel-or-error visibility rather than raw network
// success. The strict 0-console-error gate is preserved by (a) defaulting to the
// LIGHTER KPI tab on initial load, and (b) a NARROW filter that tolerates a 5xx
// ONLY on the named heavy analytics endpoints — any 4xx (auth!) or any other 5xx
// still fails the gate (feedback_smoke_gate_operator_strict).

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

// operator_id cookie satisfies BOTH the BFF auth middleware AND the dev-only
// Firebase auth seam in authStore.js (import.meta.env.DEV + operator_id cookie).
async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

// Heavy analytics data endpoints whose intermittent prod-DB 5xx is tolerated.
const HEAVY_ENDPOINTS = [
  '/api/funnel/summary',
  '/api/synthetic-runs',
  '/api/mailboxes/reputation-score',
  '/api/mailboxes/bounce-stats',
  '/api/mailboxes/spam-complaint-stats',
  '/api/mailboxes/blacklist-alerts',
  '/api/templates/metrics',
  '/api/analytics/timeline',
]
function isBenign(line: string): boolean {
  if (/React DevTools/i.test(line)) return true
  if (/favicon\.ico/i.test(line)) return true
  if (/sourcemap|source ?map/i.test(line)) return true
  // Narrow prod-DB heavy-query tolerance: 5xx ONLY on a named heavy endpoint.
  if (/Failed to load resource/i.test(line) && /\b(500|502|503|504)\b/.test(line)
      && HEAVY_ENDPOINTS.some((h) => line.includes(h))) return true
  return false
}
function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const url = m.location()?.url || ''
    errs.push(`console.error: ${m.text()} @ ${url}`)
  })
  return errs
}
function realErrors(errs: string[]): string[] { return errs.filter((e) => !isBenign(e)) }

const TABS = ['kpi', 'trendy', 'crony', 'funnel'] as const

test('Analytika — frame, tab bar, and every tab panel renders', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/analytika')

  // Shell + headline + tab bar.
  await expect(page.getByTestId('app-analytika')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Analytika' })).toBeVisible()
  await expect(page.getByTestId('app-analytika-tabs')).toBeVisible()
  for (const key of TABS) {
    await expect(page.getByTestId(`app-analytika-tab-${key}`)).toBeVisible()
  }

  // KPI is the default tab — its panel + stat strip render (always present,
  // even when a feed is loading/erroring — never a false-blank).
  await expect(page.getByTestId('app-analytika-tab-kpi')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('app-analytika-panel-kpi')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('app-analytika-kpi-stats')).toBeVisible()

  // Trendy — first deliverability card frame is always present.
  await page.getByTestId('app-analytika-tab-trendy').click()
  await expect(page.getByTestId('app-analytika-panel-trendy')).toBeVisible()
  await expect(page.getByTestId('app-analytika-tab-trendy')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('app-analytika-bounce')).toBeVisible({ timeout: 20_000 })

  // Crony — stat strip frame always present.
  await page.getByTestId('app-analytika-tab-crony').click()
  await expect(page.getByTestId('app-analytika-panel-crony')).toBeVisible()
  await expect(page.getByTestId('app-analytika-crony-stats')).toBeVisible({ timeout: 20_000 })

  // Funnel — the day-window chips live outside the data-gated body, so they
  // render regardless of whether the heavy /funnel/summary query settled.
  await page.getByTestId('app-analytika-tab-funnel').click()
  await expect(page.getByTestId('app-analytika-panel-funnel')).toBeVisible()
  await expect(page.getByTestId('app-analytika-funnel-d-14')).toBeVisible({ timeout: 20_000 })

  const real = realErrors(errs)
  expect(real, real.join('\n')).toHaveLength(0)
})

test('Analytika — ?tab=crony deep-link selects Crony (redirect back-compat)', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  // /observability redirected to /analytics?tab=crony in v1; the page keeps
  // the same ?tab= contract so that deep-link survives the port.
  await page.goto('/analytika?tab=crony')

  await expect(page.getByTestId('app-analytika')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('app-analytika-tab-crony')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('app-analytika-panel-crony')).toBeVisible()
  await expect(page.getByTestId('app-analytika-crony-stats')).toBeVisible({ timeout: 20_000 })

  const real = realErrors(errs)
  expect(real, real.join('\n')).toHaveLength(0)
})
