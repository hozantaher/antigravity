// verify-queue-health.spec.ts — ADD-2 (2026-05-14)
// ─────────────────────────────────────────────────────────────────────────────
// Playwright E2E for the ADD-2 verify-queue-health UX: cron liveness
// indicator + manual trigger button on the Home VerifyQueueWidget.
//
// Past incident (2026-05-14 evening): operator panicked seeing
// "31198 pending, 0 processed" because UX-2 widget did not reveal whether
// the cron was draining the queue. ADD-2 exposes status_reason +
// last_tick_at + a manual trigger so the operator can act from /.
//
// HARD RULE feedback_playwright_smoke_required (T0).

import { test, expect, Page } from '@playwright/test'

const PROGRESS_FIXTURE = {
  total_eligible: 31_198,
  verified_total: 12_547,
  pending: 18_651,
  daily_used: 1_200,
  daily_max: 31_200,
  eta_days_remaining: 3,
  status_breakdown: { valid: 12_547, risky: 200, invalid: 100 },
  recent_per_minute: 0,
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

async function seedHomeRoutes(page: Page) {
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
}

test('[ADD2-A] stuck health → red status pill + manual trigger button', async ({ page }) => {
  await seedHomeRoutes(page)
  await page.route('**/api/verify-queue/health', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        last_tick_at: new Date(Date.now() - 200 * 60_000).toISOString(),
        last_tick_processed: 30,
        pending_now: 18_651,
        daily_max: 31_200,
        enabled: true,
        paused: false,
        is_healthy: false,
        status_reason: 'stuck',
        stuck_threshold_minutes: 90,
        stale_threshold_minutes: 45,
        minutes_since_last_tick: 200,
      }),
    })
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  const card = page.getByTestId('card-verify-queue')
  await expect(card).toBeVisible({ timeout: 10_000 })

  const pill = page.getByTestId('verify-queue-status-pill')
  await expect(pill).toHaveAttribute('data-status-kind', 'stuck')
  await expect(pill).toContainText(/Cron stojí/i)

  const trigger = page.getByTestId('verify-queue-manual-trigger')
  await expect(trigger).toBeVisible()
})

test('[ADD2-B] healthy → green status pill + no trigger button', async ({ page }) => {
  await seedHomeRoutes(page)
  await page.route('**/api/verify-queue/health', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        last_tick_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        last_tick_processed: 50,
        pending_now: 18_651,
        daily_max: 31_200,
        enabled: true,
        paused: false,
        is_healthy: true,
        status_reason: 'running',
        stuck_threshold_minutes: 90,
        stale_threshold_minutes: 45,
        minutes_since_last_tick: 5,
      }),
    })
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  const card = page.getByTestId('card-verify-queue')
  await expect(card).toBeVisible({ timeout: 10_000 })

  const pill = page.getByTestId('verify-queue-status-pill')
  await expect(pill).toHaveAttribute('data-status-kind', 'running')

  await expect(page.getByTestId('verify-queue-manual-trigger')).toHaveCount(0)
})

test('[ADD2-C] manual trigger button POSTs to /api/contacts/verify/tick', async ({ page }) => {
  await seedHomeRoutes(page)
  await page.route('**/api/verify-queue/health', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        last_tick_at: new Date(Date.now() - 200 * 60_000).toISOString(),
        last_tick_processed: 30,
        pending_now: 18_651,
        daily_max: 31_200,
        enabled: true,
        paused: false,
        is_healthy: false,
        status_reason: 'stuck',
        stuck_threshold_minutes: 90,
        stale_threshold_minutes: 45,
        minutes_since_last_tick: 200,
      }),
    })
  })

  let tickPosted = false
  await page.route('**/api/contacts/verify/tick', async route => {
    const req = route.request()
    if (req.method() === 'POST') {
      // HARD RULE feedback_audit_log_on_mutations — confirm header is present.
      expect(req.headers()['x-confirm-send']).toBe('yes')
      tickPosted = true
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, started: true }),
      })
    } else {
      await route.continue()
    }
  })

  await ensureLoggedIn(page)
  await page.goto('/')
  await page.getByTestId('verify-queue-manual-trigger').click()

  await expect.poll(() => tickPosted, { timeout: 5_000 }).toBe(true)
})

test('[ADD2-D] stale health → amber pill + trigger button', async ({ page }) => {
  await seedHomeRoutes(page)
  await page.route('**/api/verify-queue/health', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        last_tick_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        last_tick_processed: 20,
        pending_now: 18_651,
        daily_max: 31_200,
        enabled: true,
        paused: false,
        is_healthy: false,
        status_reason: 'stale',
        stuck_threshold_minutes: 90,
        stale_threshold_minutes: 45,
        minutes_since_last_tick: 60,
      }),
    })
  })

  await ensureLoggedIn(page)
  await page.goto('/')
  const pill = page.getByTestId('verify-queue-status-pill')
  await expect(pill).toHaveAttribute('data-status-kind', 'stale')
  await expect(page.getByTestId('verify-queue-manual-trigger')).toBeVisible()
})
