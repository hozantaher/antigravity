// live-cluster-rate.spec.ts — AH6 (2026-05-15)
//
// Verifies the Home page Live Cluster Throughput widget renders headline
// rate + per-mailbox rows when the
//   /api/operator-metrics/cluster-rate-live
// endpoint resolves with a populated payload. Status pill + stuck-mb
// edge cases are covered by unit tests; this spec ensures the route
// is wired through and the widget mounts on Home.

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

test('Home — Live cluster rate widget renders headline + per-mailbox rows', async ({ page }) => {
  await page.route('**/api/operator-metrics/cluster-rate-live', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        now_iso: '2026-05-15T17:00:00Z',
        window_minutes: 60,
        cluster: {
          sent_60min: 78,
          rate_per_hour: 78,
          bounce_60min: 1,
          bounce_rate_pct: 1.3,
        },
        mailboxes: [
          { from_address: 'hozan.taher.75@post.cz', sent_60min: 19, rate_per_hour: 19, bounce_60min: 0, last_sent_at: '2026-05-15T16:59:30Z', minutes_since_last_send: 0 },
          { from_address: 'hozan.taher.76@post.cz', sent_60min: 16, rate_per_hour: 16, bounce_60min: 1, last_sent_at: '2026-05-15T16:59:00Z', minutes_since_last_send: 1 },
          { from_address: 'hozan.taher.77@post.cz', sent_60min: 22, rate_per_hour: 22, bounce_60min: 0, last_sent_at: '2026-05-15T16:59:35Z', minutes_since_last_send: 0 },
          { from_address: 'hozan.taher.78@post.cz', sent_60min: 21, rate_per_hour: 21, bounce_60min: 0, last_sent_at: '2026-05-15T16:59:45Z', minutes_since_last_send: 0 },
        ],
        ceiling_per_h: 80,
        spacing_seconds: 180,
      }),
    })
  })

  await page.goto('/')

  await expect(page.getByTestId('card-cluster-rate')).toBeVisible({ timeout: 8_000 })
  await expect(page.getByTestId('cluster-rate-headline')).toContainText('78')
  await expect(page.getByTestId('cluster-rate-ceiling-pct')).toContainText('98%')
  // 4 per-mailbox rows present
  await expect(page.getByTestId('cluster-rate-mailbox-row')).toHaveCount(4)
})
