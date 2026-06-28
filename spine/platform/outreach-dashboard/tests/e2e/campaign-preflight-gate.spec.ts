// ═══════════════════════════════════════════════════════════════════════════
//  T-U01 — Preflight gate lock (#124 UI-2)
//
// /campaigns/:id Spustit button must be disabled when server preflight
// returns ok=false. Regression guard against: (a) gate silently enabling
// despite failed check, (b) reason label going missing, (c) local-3-check
// fallback breaking when BFF is unreachable.
//
// All endpoints stubbed — no prod DB mutation.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page, type Route } from '@playwright/test'

const CAMPAIGN_ID = 9999
const STUB_CAMPAIGN = {
  id: CAMPAIGN_ID,
  name: 'E2E Preflight Test',
  description: 'stub',
  status: 'draft',
  created_at: '2026-04-20T10:00:00Z',
  updated_at: '2026-04-20T10:00:00Z',
  stats: { sent: 0, opened: 0, replied: 0, bounced: 0, queued: 0, unsubscribed: 0 },
  sequence_config: [{ step: 0, delay_days: 0, template: 'initial' }],
  category_paths: ['Remesla'],
  category_match: 'prefix',
}

const PREFLIGHT_ALL_PASS = {
  ok: true,
  checks: [
    { name: 'proxy',      ok: true, reason: null },
    { name: 'full_check', ok: true, reason: null },
    { name: 'suppression', ok: true, reason: null },
    { name: 'capacity',   ok: true, reason: null },
    { name: 'templates',  ok: true, reason: null },
  ],
}

const PREFLIGHT_ONE_FAIL = {
  ok: false,
  checks: [
    { name: 'proxy',      ok: true,  reason: null },
    { name: 'full_check', ok: true,  reason: null },
    { name: 'suppression', ok: true, reason: null },
    { name: 'capacity',   ok: false, reason: 'Žádný aktivní mailbox s kapacitou' },
    { name: 'templates',  ok: true,  reason: null },
  ],
}

const PREFLIGHT_THREE_FAIL = {
  ok: false,
  checks: [
    { name: 'proxy',      ok: false, reason: 'Pool vyčerpán (0 CZ proxies)' },
    { name: 'full_check', ok: false, reason: 'Full-check stale > 24h na 3 mailboxech' },
    { name: 'suppression', ok: true, reason: null },
    { name: 'capacity',   ok: false, reason: 'Aktivní mailboxy: 0' },
    { name: 'templates',  ok: true,  reason: null },
  ],
}

const PREFLIGHT_ALL_FAIL = {
  ok: false,
  checks: [
    { name: 'proxy',      ok: false, reason: 'fail1' },
    { name: 'full_check', ok: false, reason: 'fail2' },
    { name: 'suppression', ok: false, reason: 'fail3' },
    { name: 'capacity',   ok: false, reason: 'fail4' },
    { name: 'templates',  ok: false, reason: 'fail5' },
  ],
}

const CAPACITY_OK = { active_mailboxes: 3, daily_cap: 300 }
const CAPACITY_ZERO = { active_mailboxes: 0, daily_cap: 0 }
const QUALITY_OK = { total: 100, with_email: 90, without_email: 10, invalid: 0, spamtrap: 0, catch_all: 0, unverified: 0, role_only: 0 }

async function stubCampaignPage(
  page: Page,
  opts: {
    preflight?: unknown,
    preflightStatus?: number,
    capacity?: unknown,
    quality?: unknown,
  } = {}
) {
  await page.route('**/api/campaigns', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([STUB_CAMPAIGN]) })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB_CAMPAIGN) })
  })
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/best-time`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ best_hour: null }) })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/preflight`, (route) => {
    const status = opts.preflightStatus ?? 200
    const body = opts.preflight ?? PREFLIGHT_ALL_PASS
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/capacity`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.capacity ?? CAPACITY_OK) })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/email-quality`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.quality ?? QUALITY_OK) })
  )
  // Additional endpoints that may fire on page mount — safe defaults:
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/sends**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/estimate`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ estimated: 0 }) })
  )
}

async function openPreflightGate(page: Page) {
  await page.goto(`/campaigns/${CAMPAIGN_ID}`)
  await page.waitForSelector('h2', { timeout: 10_000 })
  // Click the top-right Spustit button (primary action on a draft campaign).
  const spustit = page.getByRole('button', { name: /Spustit/i }).first()
  await spustit.click()
  await page.waitForSelector('[data-testid="preflight-section"]', { timeout: 10_000 })
}

test.describe('T-U01 preflight gate — disable states', () => {
  test('all 5 checks pass → Spustit enabled, no blocked button visible', async ({ page }) => {
    await stubCampaignPage(page, { preflight: PREFLIGHT_ALL_PASS })
    await openPreflightGate(page)
    // When ok=true, the disabled "run-blocked" button must NOT render.
    await expect(page.getByTestId('run-blocked')).toHaveCount(0)
    // All 5 checks shown as ok.
    const okChecks = page.locator('[data-preflight="ok"]')
    await expect(okChecks).toHaveCount(5)
  })

  test('1 check fails → Spustit disabled with exact reason text', async ({ page }) => {
    await stubCampaignPage(page, { preflight: PREFLIGHT_ONE_FAIL, capacity: CAPACITY_ZERO })
    await openPreflightGate(page)
    const blocked = page.getByTestId('run-blocked')
    await expect(blocked).toBeVisible()
    await expect(blocked).toBeDisabled()
    // Failing row has the Czech reason text.
    const capacityRow = page.locator('[data-check="capacity"]')
    await expect(capacityRow).toHaveAttribute('data-preflight', 'err')
    await expect(capacityRow).toContainText('Žádný aktivní mailbox s kapacitou')
  })

  test('3 checks fail → all failing reasons visible, button disabled', async ({ page }) => {
    await stubCampaignPage(page, { preflight: PREFLIGHT_THREE_FAIL, capacity: CAPACITY_ZERO })
    await openPreflightGate(page)
    await expect(page.getByTestId('run-blocked')).toBeDisabled()
    const errChecks = page.locator('[data-preflight="err"]')
    await expect(errChecks).toHaveCount(3)
    await expect(page.locator('[data-check="proxy"]')).toContainText('Pool vyčerpán')
    await expect(page.locator('[data-check="full_check"]')).toContainText('stale')
  })

  test('all 5 fail → all error rows, button disabled', async ({ page }) => {
    await stubCampaignPage(page, { preflight: PREFLIGHT_ALL_FAIL, capacity: CAPACITY_ZERO })
    await openPreflightGate(page)
    await expect(page.locator('[data-preflight="err"]')).toHaveCount(5)
    await expect(page.getByTestId('run-blocked')).toBeDisabled()
  })
})

test.describe('T-U01 preflight gate — fallback behavior', () => {
  test('preflight API returns 500 → local 3-check fallback renders', async ({ page }) => {
    await stubCampaignPage(page, { preflightStatus: 500, preflight: { error: 'db down' } })
    await openPreflightGate(page)
    // When server preflight fails, fallback shows 3 local checks.
    const section = page.getByTestId('preflight-section')
    const checks = section.locator('[data-check]')
    await expect(checks).toHaveCount(3)
    // keys should be the local ones (mailboxes/segment/template)
    await expect(section.locator('[data-check="mailboxes"]')).toBeVisible()
    await expect(section.locator('[data-check="segment"]')).toBeVisible()
    await expect(section.locator('[data-check="template"]')).toBeVisible()
  })

  test('preflight 500 but capacity=0 → local fallback shows mailboxes=err, gate blocks', async ({ page }) => {
    await stubCampaignPage(page, {
      preflightStatus: 500,
      preflight: { error: 'db' },
      capacity: CAPACITY_ZERO,
    })
    await openPreflightGate(page)
    await expect(page.locator('[data-check="mailboxes"]')).toHaveAttribute('data-preflight', 'err')
    await expect(page.getByTestId('run-blocked')).toBeDisabled()
  })
})

test.describe('T-U01 preflight gate — data-check keys match server contract', () => {
  test('server check names preserved as data-check attribute', async ({ page }) => {
    await stubCampaignPage(page, { preflight: PREFLIGHT_ALL_PASS })
    await openPreflightGate(page)
    // Lock the keys so backend contract + UI stay aligned.
    for (const key of ['proxy', 'full_check', 'suppression', 'capacity', 'templates']) {
      await expect(page.locator(`[data-check="${key}"]`)).toBeVisible()
    }
  })
})
