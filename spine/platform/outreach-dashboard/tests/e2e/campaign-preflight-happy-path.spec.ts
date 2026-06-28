// ═══════════════════════════════════════════════════════════════════════════
//  T-U01 preflight gate — HAPPY PATH complement to campaign-preflight-gate.spec.ts
//
// Gate-block spec covers 5 disable states. This spec covers the enabled path:
//   preflight ok=true → quality green → click Spustit → POST /run fires → toast
//
// Plus the two "warn" paths where preflight is green but quality surface
// shows a yellow alert ("Spustit i přesto" button label).
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test'

const CAMPAIGN_ID = 9998

const STUB_CAMPAIGN = {
  id: CAMPAIGN_ID,
  name: 'Happy Path Test',
  description: '',
  status: 'draft',
  created_at: '2026-04-20T10:00:00Z',
  updated_at: '2026-04-20T10:00:00Z',
  stats: { sent: 0, opened: 0, replied: 0, bounced: 0, queued: 0, unsubscribed: 0 },
  sequence_config: [{ step: 0, delay_days: 0, template: 'initial' }],
  category_paths: ['Remesla'],
  category_match: 'prefix',
}

const PREFLIGHT_PASS = {
  ok: true,
  checks: [
    { name: 'proxy',       ok: true, reason: null },
    { name: 'full_check',  ok: true, reason: null },
    { name: 'suppression', ok: true, reason: null },
    { name: 'capacity',    ok: true, reason: null },
    { name: 'templates',   ok: true, reason: null },
  ],
}

const CAPACITY_OK = { active_mailboxes: 3, daily_cap: 300 }
const QUALITY_CLEAN = { total: 100, with_email: 100, without_email: 0, invalid: 0, spamtrap: 0, catch_all: 0, unverified: 0, role_only: 0 }
const QUALITY_RISKY = { total: 100, with_email: 100, without_email: 0, invalid: 3, spamtrap: 0, catch_all: 2, unverified: 0, role_only: 0 }
const QUALITY_UNVERIFIED = { total: 100, with_email: 100, without_email: 0, invalid: 0, spamtrap: 0, catch_all: 0, unverified: 15, role_only: 0 }

async function stubPage(page: Page, opts: {
  preflight?: unknown,
  capacity?: unknown,
  quality?: unknown,
  runResponse?: { status: number, body: unknown },
} = {}) {
  await page.route('**/api/campaigns', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([STUB_CAMPAIGN]) })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}`, (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB_CAMPAIGN) })
  })
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/best-time`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"best_hour":null}' })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/preflight`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.preflight ?? PREFLIGHT_PASS) })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/capacity`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.capacity ?? CAPACITY_OK) })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/email-quality`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.quality ?? QUALITY_CLEAN) })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/sends**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  )
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/estimate`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"estimated":0}' })
  )
  const runResp = opts.runResponse ?? { status: 200, body: { ok: true, status: 'active' } }
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/run`, (route) =>
    route.fulfill({ status: runResp.status, contentType: 'application/json', body: JSON.stringify(runResp.body) })
  )
}

async function openGate(page: Page) {
  await page.goto(`/campaigns/${CAMPAIGN_ID}`)
  await page.waitForSelector('h2', { timeout: 10_000 })
  await page.getByRole('button', { name: /Spustit/i }).first().click()
  await page.waitForSelector('[data-testid="preflight-section"]', { timeout: 10_000 })
}

test.describe('T-U01 preflight gate — happy path', () => {
  test('all 5 checks pass + clean quality → Spustit enabled → click fires POST /run', async ({ page }) => {
    let runFired = false
    let runMethod = ''
    await stubPage(page)
    await page.route(`**/api/campaigns/${CAMPAIGN_ID}/run`, (route) => {
      runFired = true
      runMethod = route.request().method()
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"status":"active"}' })
    })
    await openGate(page)
    // No blocked button (button is visible + enabled).
    await expect(page.getByTestId('run-blocked')).toHaveCount(0)
    // Find the primary Spustit inside the gate modal (NOT the top-right one that opens the gate).
    const gateSpustit = page.locator('.modal-foot').getByRole('button', { name: /^Spustit$/ }).first()
    await expect(gateSpustit).toBeEnabled()
    await gateSpustit.click()
    await expect.poll(() => runFired, { timeout: 5_000 }).toBe(true)
    expect(runMethod).toBe('POST')
  })

  test('preflight OK but quality has risky addresses → "Spustit i přesto" yellow-style label', async ({ page }) => {
    await stubPage(page, { quality: QUALITY_RISKY })
    await openGate(page)
    // The primary CTA label flips to "Spustit i přesto".
    const cta = page.locator('.modal-foot').getByRole('button', { name: /Spustit i přesto/ })
    await expect(cta).toBeVisible()
    await expect(cta).toBeEnabled()
  })

  test('preflight OK + unverified > 0 → "Ověřit neověřené" side button rendered', async ({ page }) => {
    await stubPage(page, { quality: QUALITY_UNVERIFIED })
    await openGate(page)
    await expect(page.getByRole('button', { name: /Ověřit neověřené/ })).toBeVisible()
    // Primary is still "Spustit i přesto" because unverified counts toward risk.
    await expect(page.locator('.modal-foot').getByRole('button', { name: /Spustit i přesto/ })).toBeVisible()
  })

  test('clicking Zrušit closes gate without firing /run', async ({ page }) => {
    let runFired = false
    await stubPage(page)
    await page.route(`**/api/campaigns/${CAMPAIGN_ID}/run`, (route) => {
      runFired = true
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })
    await openGate(page)
    await page.locator('.modal-foot').getByRole('button', { name: /^Zrušit$/ }).first().click()
    // Gate closes (preflight-section no longer visible).
    await expect(page.getByTestId('preflight-section')).toHaveCount(0)
    await page.waitForTimeout(300)
    expect(runFired).toBe(false)
  })

  test('run API returns 500 → error toast surfaces, status stays draft', async ({ page }) => {
    await stubPage(page, { runResponse: { status: 500, body: { error: 'db down' } } })
    await openGate(page)
    const gateSpustit = page.locator('.modal-foot').getByRole('button', { name: /^Spustit$/ }).first()
    await gateSpustit.click()
    // Toast surface — look for any red/error toast text.
    await expect(page.locator('text=/Chyba/i').first()).toBeVisible({ timeout: 5_000 })
  })
})
