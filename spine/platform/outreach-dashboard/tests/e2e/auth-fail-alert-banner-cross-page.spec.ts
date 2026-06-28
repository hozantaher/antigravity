// ═══════════════════════════════════════════════════════════════════════════
//  AuthFailAlertBanner — cross-page presence lock
//
// Banner is mounted in Layout.jsx so it MUST appear on every authenticated
// page when an alert is active. Existing auth-fail-alert-banner.spec.ts only
// covers /. This locks /mailboxes, /campaigns, /analytics, /healing — the
// 4 most likely operator destinations during an AUTH-fail incident.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect } from '@playwright/test'

const ONE_ALERT = {
  alerts: [
    {
      mailbox_id: 99,
      from_address: 'test.cross.page@email.cz',
      created_at: new Date().toISOString(),
      fail_count: 5,
    },
  ],
  count: 1,
}

const NO_ALERTS = { alerts: [], count: 0 }

const PAGES = ['/', '/mailboxes', '/campaigns', '/analytics', '/healing'] as const

test.describe('AuthFailAlertBanner — cross-page presence', () => {
  for (const path of PAGES) {
    test(`banner visible on ${path} when alert active`, async ({ page }) => {
      await page.route('**/api/health/auth-fail-alerts', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_ALERT) })
      )
      await page.goto(path)
      const banner = page.getByTestId('auth-fail-alert-banner')
      await expect(banner).toBeVisible()
      await expect(banner).toHaveAttribute('role', 'alert')
      await expect(banner).toContainText('AUTH')
    })
  }

  for (const path of PAGES) {
    test(`banner absent on ${path} when count=0`, async ({ page }) => {
      await page.route('**/api/health/auth-fail-alerts', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(NO_ALERTS) })
      )
      await page.goto(path)
      // Layout polls on mount — give fetch a moment.
      await page.waitForTimeout(400)
      await expect(page.getByTestId('auth-fail-alert-banner')).toHaveCount(0)
    })
  }

  test('banner content is identical across pages (single component, not duplicated)', async ({ page }) => {
    await page.route('**/api/health/auth-fail-alerts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_ALERT) })
    )
    const texts: string[] = []
    for (const path of PAGES) {
      await page.goto(path)
      const banner = page.getByTestId('auth-fail-alert-banner')
      await banner.waitFor({ timeout: 5_000 })
      texts.push(((await banner.textContent()) ?? '').trim())
    }
    // All variations of the banner text should be identical: same component,
    // same data, no per-page styling drift.
    const uniq = new Set(texts)
    expect(uniq.size).toBe(1)
  })

  test('exactly ONE banner instance per page (no double-render in Layout)', async ({ page }) => {
    await page.route('**/api/health/auth-fail-alerts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_ALERT) })
    )
    for (const path of PAGES) {
      await page.goto(path)
      await expect(page.getByTestId('auth-fail-alert-banner')).toHaveCount(1)
    }
  })
})
