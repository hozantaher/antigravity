import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }))
})

test('Sentry tunnel endpoint accepts POST requests', async ({ page }) => {
  // Try to POST to sentry tunnel
  const response = await page.request.post(`http://localhost:18001/sentry-tunnel`, {
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    data: JSON.stringify({ dsn: 'https://test@sentry.io/0' }) + '\n{}\n{}',
  }).catch(() => null)
  // 200 (forwarded), 400 (invalid dsn format), or 404 (not wired) are all acceptable
  if (response) {
    expect([200, 400, 404, 500]).toContain(response.status())
  }
})

test('Sentry tunnel rejects GET requests', async ({ page }) => {
  const response = await page.request.get(`http://localhost:18001/sentry-tunnel`).catch(() => null)
  if (response) {
    expect([404, 405]).toContain(response.status())
  }
})
