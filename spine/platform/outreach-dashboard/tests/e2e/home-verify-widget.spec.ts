// home-verify-widget.spec.ts — Playwright E2E for UX-2 verify-queue widget.
// ─────────────────────────────────────────────────────────────────────────────
// HARD RULE (feedback_playwright_smoke_required, T0): every new UI surface
// in features/platform/outreach-dashboard MUST ship a Playwright smoke spec in the same
// PR. Minimum bar: goto + visible headline + no console errors.
//
// This spec exceeds the minimum:
//   - mocks GET /api/contacts/verify/progress with a known fixture
//   - mocks GET /api/dashboard/summary so the rest of Home renders too
//   - asserts the Verify queue card + progress bar + percentage are visible
//   - asserts the CTA link points to /priprava
//   - operator-strict console-error gate (4xx/5xx are real failures)

import { test, expect, Page } from '@playwright/test'

const PROGRESS_FIXTURE = {
  total_eligible: 31_198,
  verified_total: 12_547,
  pending: 18_651,
  daily_used: 1_200,
  daily_max: 31_200,
  eta_days_remaining: 3,
  status_breakdown: { valid: 12_547, risky: 200, invalid: 100 },
  recent_per_minute: 8,
  paused: false,
  enabled: true,
}

const SUMMARY_FIXTURE = {
  generated_at: new Date().toISOString(),
  home_campaign_id: 457,
  campaign: {
    key: 'campaign',
    campaign_id: 457,
    found: true,
    name: 'Výkup techniky',
    status: 'active',
    sent_24h: 24,
    bounced_24h: 1,
    in_flight: 5,
    send_rate_per_hour: 1.0,
  },
  replies: { key: 'replies', unhandled: 3, today: 2, recent: [] },
  mailboxes: {
    key: 'mailboxes',
    total: 4,
    active: 3,
    paused: 1,
    auth_locked: 0,
    bounce_hold: 0,
    avg_score: 75.5,
  },
  notifications: { key: 'notifications', total_critical: 0, top: [] },
  metrics: { key: 'metrics', sent_24h: 24, bounced_24h: 1, replied_24h: 3, bounce_rate_pct: 4.2 },
}

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id',
    value: 'operator',
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    sameSite: 'Lax',
  }])
  await page.goto('/')
  const op = page.locator('input[name="operator_id"], input[placeholder*="operator"]').first()
  if (await op.isVisible({ timeout: 1000 }).catch(() => false)) {
    await op.fill('operator')
    await page.locator('button[type="submit"]').first().click()
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/dashboard/summary', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SUMMARY_FIXTURE),
    })
  })
  await page.route('**/api/contacts/verify/progress', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PROGRESS_FIXTURE),
    })
  })
})

test('UX-2: Home renders "Verify queue" card with progress bar + percentage', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // Operator-strict filter: only React DevTools / favicon / sourcemap /
    // CSS-preload-without-status noise is allowed through.
    if (/React DevTools|favicon|sourceMappingURL/i.test(t)) return
    if (/preload/i.test(t) && !/status of/i.test(t)) return
    consoleErrors.push(`console.error: ${t}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Card is visible
  await expect(page.getByTestId('card-verify-queue')).toBeVisible({ timeout: 10_000 })

  // Headline
  await expect(page.getByText('Verify queue').first()).toBeVisible()

  // Progress bar rendered with correct aria value (40% of 31198)
  const bar = page.getByTestId('verify-queue-progress-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('aria-valuenow', '40')

  // Percentage cell shows "40%"
  await expect(page.getByTestId('verify-queue-progress-pct')).toContainText('40%')

  // No real console errors.
  expect(consoleErrors).toEqual([])
})

test('UX-2: status pill reflects fixture state (Běží)', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.goto('/')
  const pill = page.getByTestId('verify-queue-status-pill')
  await expect(pill).toBeVisible({ timeout: 10_000 })
  await expect(pill).toHaveAttribute('data-status-kind', 'running')
})

test('UX-2: "Otevřít nastavení verify-loop →" navigates to /priprava', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.goto('/')
  const link = page.getByTestId('link-open-verify-settings')
  await expect(link).toBeVisible({ timeout: 10_000 })
  await expect(link).toHaveAttribute('href', '/priprava')
})
