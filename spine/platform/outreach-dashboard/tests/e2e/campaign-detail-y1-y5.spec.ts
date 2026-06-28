// campaign-detail-y1-y5.spec.ts
//
// Interaction-level smoke for the Y1 (#1345) + Y5 (#1346) UX cleanup
// waves on /campaigns/:id. Y1 demoted four panels (TimingHeatmap,
// queue-health widgets, recovery tools, dry-run enrollment) behind
// accordions/toggles; Y5 extracted SequenceEditor + UnskipPanel +
// SequenceTimeline + TimingHeatmap + KpiCell + CollapsibleCardHeader
// + ContactTimeline (+ pure helpers in lib/campaignTimeline.js) out
// of the 2174-line CampaignDetail.jsx into dedicated component files.
//
// today-shipped-surfaces.smoke.spec.ts covers the always-rendered text
// (Ovládání kampaně, Stav kampaně, Nástroje obnovy kampaně). This file
// adds the interactions that the smoke pack cannot — clicking the
// Odeslání tab to reveal the "Stav fronty" accordion, and expanding the
// Nástroje obnovy accordion to verify the extracted SequenceEditor +
// UnskipPanel components actually mount.
//
// Per HARD RULE feedback_smoke_gate_operator_strict (T0) the console
// error gate is reused here.

import { test, expect, type Page } from '@playwright/test'

const CAMPAIGN_ID = 457

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

// Shared console-error filter — same exception list as the cumulative smoke
// pack so a flaky no-status preload here matches what the operator sees in
// the smoke gate.
function filterConsoleErrors(consoleErrors: string[]): string[] {
  return consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !(e.includes('preload') && !e.includes('status of')) &&
    !e.includes('status of 200') &&
    !e.includes('status of 301') &&
    !e.includes('status of 302') &&
    !e.includes('status of 304')
  )
}

function attachConsoleGate(page: Page): string[] {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })
  return consoleErrors
}

test.describe('Y1 — CampaignDetail Přehled defaults to lean Tempo card', () => {
  test('Y1-A — Tempo (pacing) card is rendered prominently on Přehled', async ({ page }) => {
    const consoleErrors = attachConsoleGate(page)
    await ensureLoggedIn(page)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)

    // Ovládání kampaně card always visible on Přehled (default tab).
    await expect(page.getByText(/Ovládání kampaně/).first()).toBeVisible({ timeout: 25_000 })

    // Tempo controls — spacing + daily cap — are inside the card.
    await expect(page.getByText(/Min\. rozestup mezi e-maily/).first()).toBeVisible()
    await expect(page.getByText(/Denní strop kampaně/).first()).toBeVisible()

    const ourErrors = filterConsoleErrors(consoleErrors)
    expect(ourErrors, `console errors:\n${ourErrors.join('\n')}`).toHaveLength(0)
  })

  test('Y1-C — Nástroje obnovy kampaně accordion is collapsed by default', async ({ page }) => {
    const consoleErrors = attachConsoleGate(page)
    await ensureLoggedIn(page)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)

    // Title is always rendered (CollapsibleCardHeader summary line).
    await expect(page.getByText(/Nástroje obnovy kampaně/).first()).toBeVisible({ timeout: 25_000 })

    // The panel content is hidden until expanded — `recovery-tools-panel`
    // testid is set on the inner div which only renders when open.
    await expect(page.locator('[data-testid="recovery-tools-panel"]')).toHaveCount(0)

    const ourErrors = filterConsoleErrors(consoleErrors)
    expect(ourErrors, `console errors:\n${ourErrors.join('\n')}`).toHaveLength(0)
  })

  test('Y5-A — Expanding Nástroje obnovy renders SequenceEditor + UnskipPanel', async ({ page }) => {
    const consoleErrors = attachConsoleGate(page)
    await ensureLoggedIn(page)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)

    await expect(page.getByText(/Nástroje obnovy kampaně/).first()).toBeVisible({ timeout: 25_000 })

    // Toggle button lives on the CollapsibleCardHeader. testIdBase is
    // "recovery-tools" → header toggle exposes data-testid="recovery-tools-toggle".
    const toggle = page.locator('[data-testid="recovery-tools-toggle"]').first()
    if (await toggle.count() === 0) {
      // Fallback: click the header text itself.
      await page.getByText(/Nástroje obnovy kampaně/).first().click()
    } else {
      await toggle.click()
    }

    // After expand, the inner panel + both extracted components mount.
    await expect(page.locator('[data-testid="recovery-tools-panel"]')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('[data-testid="sequence-editor"]')).toBeVisible()
    // UnskipPanel headline is rendered inline (not behind a testid we control).
    await expect(page.getByText(/Vrátit skipnuté zpět do queue/).first()).toBeVisible()

    const ourErrors = filterConsoleErrors(consoleErrors)
    expect(ourErrors, `console errors:\n${ourErrors.join('\n')}`).toHaveLength(0)
  })
})

test.describe('Y1 — CampaignDetail Odeslání tab queue-health accordion', () => {
  test('Y1-B — Switching to Odeslání tab reveals Stav fronty accordion', async ({ page }) => {
    const consoleErrors = attachConsoleGate(page)
    await ensureLoggedIn(page)
    await page.goto(`/campaigns/${CAMPAIGN_ID}`)

    // Wait for Přehled to settle before clicking the tab.
    await expect(page.getByText(/Ovládání kampaně/).first()).toBeVisible({ timeout: 25_000 })

    // Switch to Odeslání tab — TabBar exposes data-testid="campaign-tab-<key>".
    const tabBtn = page.locator('[data-testid="campaign-tab-odeslani"]').first()
    await expect(tabBtn).toBeVisible()
    await tabBtn.click()

    // "Stav fronty" accordion title is always rendered on this tab (collapsed
    // by default — operator opens it to see TierDistribution + InFlight +
    // Watchdog + Retry badges).
    await expect(page.getByText(/Stav fronty/).first()).toBeVisible({ timeout: 10_000 })

    // Accordion panel itself hidden until expanded.
    await expect(page.locator('[data-testid="queue-health-panel"]')).toHaveCount(0)

    const ourErrors = filterConsoleErrors(consoleErrors)
    expect(ourErrors, `console errors:\n${ourErrors.join('\n')}`).toHaveLength(0)
  })
})
