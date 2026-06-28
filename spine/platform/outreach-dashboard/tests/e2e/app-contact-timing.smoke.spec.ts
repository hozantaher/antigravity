// app-contact-timing.smoke.spec.ts — #1403 per-contact send-timing reset.
// Operator opens a contact scheduled in a campaign and sees "Odeslat teď".
// SAFETY: arms the confirm then CANCELS — never actually resets (no mutation).
import { test, expect, Page } from '@playwright/test'

async function login(page: Page) {
  await page.context().addCookies([{ name: 'operator_id', value: 'operator', domain: 'localhost', path: '/', sameSite: 'Lax' }])
}

test('contact campaign timing shows a guarded "Odeslat teď" reset', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await login(page)
  // 205609 is pending in campaign 457 with a future next_send_at (PROD).
  await page.goto('/kontakty?id=205609')
  await expect(page.getByTestId('app-contact-detail')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByTestId('app-contact-campaigns')).toBeVisible()
  await page.getByTestId('app-timing-reset').click()
  await expect(page.getByTestId('app-timing-confirm')).toBeVisible()
  // SAFETY: cancel — a smoke must not reschedule a real contact.
  await page.getByTestId('app-timing-cancel').click()
  await expect(page.getByTestId('app-timing-reset')).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})
