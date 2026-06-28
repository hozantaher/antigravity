// app-reply-attachments.smoke.spec.ts — STORY: seller sends machine photos.
//
// Operator opens an inbound reply that carries image attachments and SEES the
// photos (the keystone toward assigning them to a vehicle). Reply -557 is an
// unmatched (orphan) reply with 4 image/jpeg attachments in PROD. This guards
// two things that were broken before 2026-06-01:
//   - the chat 404'd for unmatched (negative-id) replies → console error
//   - inbound images weren't displayed anywhere
// Per feedback_playwright_smoke_required + feedback_smoke_gate_operator_strict.

import { test, expect, Page } from '@playwright/test'

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

test('inbound reply with photos shows an attachment strip, no console error', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  await ensureLoggedIn(page)
  await page.goto('/odpovedi-legacy?vse=1&id=-557')
  await expect(page.getByTestId('app-pane-detail')).toBeVisible({ timeout: 12_000 })
  // Attachment strip renders with at least one image thumbnail (the seller photos).
  await expect(page.getByTestId('app-attachments')).toBeVisible({ timeout: 8_000 })
  await expect(page.getByTestId('app-att-thumb').first()).toBeVisible()
  // The chat must NOT 404 for an unmatched reply (regression guard).
  expect(errs, errs.join('\n')).toHaveLength(0)
})
