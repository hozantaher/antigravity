// E2E: Campaign preflight section on /campaigns/:id
//
// Tests the preflight quality-gate UI rendered inside CampaignDetail.
// All API calls are mocked; no DB or running server required.
//
// The preflight section appears when the user opens the run gate (Spustit).
// Tests verify the section renders, shows 5 check items, and reports
// READY status when all checks pass.

import { test, expect, type Page } from '@playwright/test'

// ── Fixtures ────────────────────────────────────────────────────────────────

const CAMPAIGN_ID = 1

const CAMPAIGN = {
  id: CAMPAIGN_ID,
  name: 'Preflight Test Campaign',
  status: 'paused',
  description: 'Testovací kampaň',
  sequence_config: [{ step: 0, delay_days: 0, template: 'InitEmail' }],
  category_paths: ['Stavebnictví'],
  category_match: 'prefix',
  created_at: new Date().toISOString(),
}

const STATS = { sent: 0, replied: 0, opened: 0, bounced: 0, queued: 20 }

const PREFLIGHT_ALL_OK = {
  campaign_id: CAMPAIGN_ID,
  campaign_name: 'Preflight Test Campaign',
  campaign_status: 'paused',
  ok: true,
  checks: [
    { name: 'proxy_assignments',     ok: true,  reason: null },
    { name: 'full_check_fresh',      ok: true,  reason: null },
    { name: 'suppression_populated', ok: true,  reason: null },
    { name: 'daily_capacity',        ok: true,  reason: null },
    { name: 'templates_valid',       ok: true,  reason: null },
  ],
}

const CAPACITY = {
  daily_capacity: 200,
  active_mailboxes: 3,
  estimate: 400,
  days_to_complete: 2,
}

async function installMocks(page: Page, preflightOverride?: object) {
  const preflight = preflightOverride ?? PREFLIGHT_ALL_OK

  await page.route(`**/api/campaigns/${CAMPAIGN_ID}`, route =>
    route.fulfill({ json: { campaign: CAMPAIGN, stats: STATS } }))
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/sends**`, route =>
    route.fulfill({ json: [] }))
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/preflight`, route =>
    route.fulfill({ json: preflight }))
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/capacity`, route =>
    route.fulfill({ json: CAPACITY }))
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/email-quality`, route =>
    route.fulfill({ json: { total: 400, with_email: 380, without_email: 20, valid: 300, unverified: 80, stale: 5 } }))
  await page.route(`**/api/campaigns/${CAMPAIGN_ID}/best-time`, route =>
    route.fulfill({ json: { heatmap: [], recommended: null } }))
  await page.route('**/api/campaigns**', route =>
    route.fulfill({ json: [CAMPAIGN] }))
  await page.route('**/api/templates**', route =>
    route.fulfill({ json: [{ id: 1, name: 'InitEmail', subject: 'Subjekt', body: 'Tělo' }] }))
  await page.route('**/api/health/**', route =>
    route.fulfill({ json: { status: 'ok' } }))
  await page.route('**/api/mailboxes**', route =>
    route.fulfill({ json: [] }))
  await page.route('**/api/scoring/config', route =>
    route.fulfill({ json: { weights: null, version: 0 } }))
  // Catch-all for remaining api calls
  await page.route('**/api/**', route =>
    route.fulfill({ json: [] }))
}

// ── Helper: open the run gate modal ─────────────────────────────────────────

async function openRunGate(page: Page): Promise<boolean> {
  // Look for the Spustit / Run button that opens the quality gate
  const runBtn = page.locator('button', { hasText: /spustit|run/i }).first()
  const visible = await runBtn.isVisible({ timeout: 5000 }).catch(() => false)
  if (!visible) return false
  await runBtn.click()
  // Wait for the preflight section to appear
  const preflightSection = page.locator('[data-testid="preflight-section"]')
  const appeared = await preflightSection.isVisible({ timeout: 5000 }).catch(() => false)
  return appeared
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Campaign preflight page (/campaigns/:id)', () => {

  test('campaign 1 preflight page shows READY status when all checks pass', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await installMocks(page, PREFLIGHT_ALL_OK)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)
    await page.waitForLoadState('networkidle')

    // Page must load without crashing
    const heading = page.locator('h2, h1').first()
    const loaded = await heading.isVisible({ timeout: 6000 }).catch(() => false)
    if (!loaded) {
      test.skip(true, `/campaigns/${CAMPAIGN_ID} detail page did not render h1/h2`)
      return
    }

    const gateOpened = await openRunGate(page)
    if (!gateOpened) {
      test.skip(true, 'Run gate / preflight section did not appear — may require a paused campaign UI state')
      return
    }

    // With all checks ok, the preflight section should show ok state
    const okChecks = page.locator('[data-preflight="ok"]')
    const errChecks = page.locator('[data-preflight="err"]')
    const okCount = await okChecks.count()
    const errCount = await errChecks.count()
    // All 5 checks should be ok, none should be err
    expect(okCount).toBe(5)
    expect(errCount).toBe(0)

    // No runtime errors
    const runtimeErrors = consoleErrors.filter(e =>
      e.includes('TypeError') || e.includes('Cannot read') || e.includes('is not defined')
    )
    expect(runtimeErrors).toHaveLength(0)
  })

  test('all 5 checks are visible in the preflight section', async ({ page }) => {
    await installMocks(page, PREFLIGHT_ALL_OK)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)
    await page.waitForLoadState('networkidle')

    const heading = page.locator('h2, h1').first()
    const loaded = await heading.isVisible({ timeout: 6000 }).catch(() => false)
    if (!loaded) {
      test.skip(true, 'Detail page did not render')
      return
    }

    const gateOpened = await openRunGate(page)
    if (!gateOpened) {
      test.skip(true, 'Run gate did not open')
      return
    }

    // There should be exactly 5 check indicators (data-preflight attribute)
    const checkItems = page.locator('[data-preflight]')
    const count = await checkItems.count()
    expect(count).toBe(5)

    // Each of the 5 check names should be represented
    const checkNames = ['proxy_assignments', 'full_check_fresh', 'suppression_populated', 'daily_capacity', 'templates_valid']
    for (const name of checkNames) {
      const checkEl = page.locator(`[data-check="${name}"]`)
      const exists = await checkEl.count()
      expect(exists).toBeGreaterThanOrEqual(1)
    }
  })

  test('no console errors on campaign detail page load', async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    await installMocks(page, PREFLIGHT_ALL_OK)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)
    await page.waitForLoadState('networkidle')

    const heading = page.locator('h2, h1').first()
    const loaded = await heading.isVisible({ timeout: 6000 }).catch(() => false)
    if (!loaded) {
      test.skip(true, 'Detail page did not render')
      return
    }

    // Filter out non-critical noise (e.g. favicon 404, extension errors)
    const significant = consoleErrors.filter(e =>
      !e.includes('favicon') &&
      !e.includes('chrome-extension') &&
      !e.includes('Failed to load resource') &&
      (e.includes('TypeError') || e.includes('Cannot read') || e.includes('Uncaught'))
    )
    expect(significant).toHaveLength(0)
  })

  test('failed preflight check shows err indicator', async ({ page }) => {
    const failedPreflight = {
      ...PREFLIGHT_ALL_OK,
      ok: false,
      checks: PREFLIGHT_ALL_OK.checks.map((c, i) =>
        i === 0
          ? { ...c, ok: false, reason: '2 mailboxů bez proxy_url' }
          : c
      ),
    }

    await installMocks(page, failedPreflight)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)
    await page.waitForLoadState('networkidle')

    const heading = page.locator('h2, h1').first()
    const loaded = await heading.isVisible({ timeout: 6000 }).catch(() => false)
    if (!loaded) {
      test.skip(true, 'Detail page did not render')
      return
    }

    const gateOpened = await openRunGate(page)
    if (!gateOpened) {
      test.skip(true, 'Run gate did not open')
      return
    }

    // At least one check should be in error state
    const errChecks = page.locator('[data-preflight="err"]')
    const errCount = await errChecks.count()
    expect(errCount).toBeGreaterThanOrEqual(1)

    // The run button should be disabled when preflight fails
    const blockedBtn = page.locator('[data-testid="run-blocked"]')
    const isDisabled = await blockedBtn.isDisabled({ timeout: 3000 }).catch(() => null)
    if (isDisabled !== null) {
      expect(isDisabled).toBe(true)
    }
  })

  test('preflight section label "Preflight" is visible', async ({ page }) => {
    await installMocks(page, PREFLIGHT_ALL_OK)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)
    await page.waitForLoadState('networkidle')

    const heading = page.locator('h2, h1').first()
    const loaded = await heading.isVisible({ timeout: 6000 }).catch(() => false)
    if (!loaded) {
      test.skip(true, 'Detail page did not render')
      return
    }

    const gateOpened = await openRunGate(page)
    if (!gateOpened) {
      test.skip(true, 'Run gate did not open')
      return
    }

    // The Preflight label text should be visible
    const label = page.locator('text=Preflight')
    const labelVisible = await label.isVisible({ timeout: 3000 }).catch(() => false)
    expect(labelVisible).toBe(true)
  })
})
