import { test } from '@playwright/test'
test('home with ticker', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('http://localhost:18175/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: '/tmp/iter26-home.png', fullPage: false })
})
