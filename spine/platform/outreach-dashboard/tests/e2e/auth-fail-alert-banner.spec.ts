// ═══════════════════════════════════════════════════════════════════════════
//  SEND-S6.3 — E2E: auth_fail_alert indicator banner
//
// We stub /api/health/auth-fail-alerts via page.route() so the test is
// deterministic (no DB write required) and doesn't pollute the local dev
// watchdog_events table. Validates:
//   1. banner renders with "1 schránka" + role=alert when count > 0
//   2. clicking the in-banner link lands on /mailboxes
//   3. banner is absent when count = 0
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect } from '@playwright/test'

const ONE_ALERT = {
  alerts: [
    {
      mailbox_id: 3,
      from_address: 'a.mazher@email.cz',
      created_at: new Date().toISOString(),
      fail_count: 4,
    },
  ],
  count: 1,
}

const NO_ALERTS = { alerts: [], count: 0 }

test.describe('Auth-fail-alert banner', () => {
  test('visible with 1-mailbox copy when alert present', async ({ page }) => {
    await page.route('**/api/health/auth-fail-alerts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_ALERT) })
    )
    await page.goto('/')
    const banner = page.getByTestId('auth-fail-alert-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toHaveAttribute('role', 'alert')
    await expect(banner).toContainText('1 schránka')
    await expect(banner).toContainText('AUTH')

    await page.screenshot({ path: 'test-results/auth-fail-alert-banner-visible.png', fullPage: false })
  })

  test('link navigates to /mailboxes', async ({ page }) => {
    await page.route('**/api/health/auth-fail-alerts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_ALERT) })
    )
    await page.goto('/')
    const link = page.getByTestId('auth-fail-alert-banner').getByRole('link')
    await link.click()
    await expect(page).toHaveURL(/\/mailboxes$/)
  })

  test('hidden when count=0', async ({ page }) => {
    await page.route('**/api/health/auth-fail-alerts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NO_ALERTS) })
    )
    await page.goto('/')
    // Give the fetch a moment to resolve before asserting absence.
    await page.waitForTimeout(500)
    await expect(page.getByTestId('auth-fail-alert-banner')).toHaveCount(0)
  })
})
