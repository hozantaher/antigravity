// home-yesterday-widget.spec.ts — ADD-3 (2026-05-14)
//
// Verifies the Home page Yesterday-summary widget renders headline +
// metrics when the /api/operator-metrics/daily-summary endpoint
// resolves with a populated payload. Empty-state copy is covered by
// unit tests; this spec only ensures route registration + DOM wiring.

import { test, expect } from '@playwright/test'

test.beforeEach(async ({ context }) => {
  await context.addCookies([{
    name: 'operator_id',
    value: 'operator',
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    sameSite: 'Lax',
  }])
})

test('Home — Yesterday summary widget renders date + metrics', async ({ page }) => {
  await page.route('**/api/operator-metrics/daily-summary**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        date: '2026-05-13',
        sent: 247,
        bounces: 9,
        bounce_rate_pct: 3.6,
        replies: 0,
        reply_rate_pct: 0,
        new_unmatched: 7,
        expected_reply_rate_pct: 1.5,
        vs_baseline: {
          baseline_sent: 250,
          baseline_replies: 1,
          sent_delta: -3,
          sent_delta_pct: -1,
          reply_delta: -1,
          trend: 'flat',
        },
      }),
    })
  })

  await page.goto('/')

  // The widget is the 6th card in the Home grid.
  await expect(page.getByTestId('card-yesterday')).toBeVisible({ timeout: 8_000 })
  await expect(page.getByText(/Včera \(13\. 5\. 2026\)/)).toBeVisible()
  await expect(page.getByTestId('yesterday-sent')).toContainText('247')
  await expect(page.getByTestId('yesterday-bounces')).toContainText('9')
  await expect(page.getByTestId('yesterday-unmatched')).toContainText('7')
})
