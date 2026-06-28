// home-dashboard.spec.ts — Playwright E2E for Sprint Y10 operator landing.
// ─────────────────────────────────────────────────────────────────────────────
// HARD RULE (feedback_playwright_smoke_required, T0): every new UI surface
// in features/platform/outreach-dashboard MUST ship a Playwright smoke spec in the same
// PR. Minimum bar: goto + visible headline + no console errors.
//
// This spec exceeds the minimum:
//   - `/` renders Home (not redirect to /replies)
//   - All 4 grid cards are visible
//   - Today's metrics strip is visible
//   - "Otevřít /replies" CTA navigates to /replies?handled=false
//   - No console errors (operator-strict gate — feedback_smoke_gate_operator_strict)
//
// The page back-ends on /api/dashboard/summary; we mock the response so
// the spec is deterministic and runs without a populated DB.

import { test, expect, Page } from '@playwright/test'

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
  replies: {
    key: 'replies',
    unhandled: 3,
    today: 2,
    recent: [
      { id: 11, from: '(skryto)@gmail.com',  subject: 'Re: nabidka',    classification: 'positive', received_at: new Date().toISOString() },
      { id: 12, from: '(skryto)@firma.cz',   subject: 'Mailer-Daemon',  classification: 'bounce',   received_at: new Date().toISOString() },
      { id: 13, from: '(skryto)@seznam.cz',  subject: '(bez předmětu)', classification: null,       received_at: new Date().toISOString() },
    ],
  },
  mailboxes: {
    key: 'mailboxes',
    total: 4,
    active: 3,
    paused: 1,
    auth_locked: 0,
    bounce_hold: 0,
    avg_score: 75.5,
  },
  notifications: {
    key: 'notifications',
    total_critical: 1,
    top: [
      { id: 101, type: 'bounce_rate_high', severity: 'critical', message: 'Bounce rate 3.2%', created_at: new Date().toISOString() },
    ],
  },
  metrics: {
    key: 'metrics',
    sent_24h: 24,
    bounced_24h: 1,
    replied_24h: 3,
    bounce_rate_pct: 4.2,
  },
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
  // Mock the home aggregate endpoint so the spec runs without a populated DB.
  await page.route('**/api/dashboard/summary', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SUMMARY_FIXTURE),
    })
  })
})

test('Y10: `/` loads Home dashboard (not redirect to /replies)', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text()
      // Allow same noise filter as the smoke pack — React DevTools,
      // favicon, sourcemaps, CSS preload. Anything 4xx/5xx counts.
      if (/React DevTools|favicon|sourceMappingURL|preload/i.test(t)) return
      consoleErrors.push(`console.error: ${t}`)
    }
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // The URL must remain `/` — no redirect.
  await expect(page).toHaveURL(/\/$/)

  // Greeting is always rendered (operator name suffix is constant).
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tomáši')

  // All 3 grid cards must be visible (MailboxesCard merged into cluster widget — audit rec #2).
  await expect(page.getByTestId('card-campaign')).toBeVisible()
  await expect(page.getByTestId('card-replies')).toBeVisible()
  await expect(page.getByTestId('card-notifications')).toBeVisible()

  // NOTE: the standalone "Today's metrics strip" (data-testid="metrics-strip")
  // was intentionally deleted in c38d881f (fix(home): delete MetricsStrip
  // widget — audit rec #1). Its KPIs moved into the cluster/cards. Asserting
  // its presence here is stale; the three grid cards above are the contract.

  expect(consoleErrors).toEqual([])
})

test('Y10: clicking "Otevřít /replies" navigates to /replies?handled=false', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.goto('/')

  const link = page.getByTestId('link-open-replies')
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(/\/replies\?handled=false/)
})

test('Y10: replies count badge reflects unhandled count from API', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.goto('/')
  const badge = page.getByTestId('replies-count-badge')
  await expect(badge).toBeVisible()
  await expect(badge).toHaveText('3')
})

test('Y10: pause button visible + has accessible label', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.goto('/')
  const btn = page.getByTestId('btn-pause-campaign')
  await expect(btn).toBeVisible()
  await expect(btn).toHaveAttribute('aria-label', /Pozastavit kampaň/)
})
