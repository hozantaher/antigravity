// app-schranky.smoke.spec.ts
//
// Schránky (Mailboxes) — the largest + most safety-critical ported surface
// (anti-trace egress, warmup caps, AP6 auth-lock, bulk pause/resume). Per HARD
// RULE feedback_playwright_smoke_required. Drives the real local BFF
// (/api/mailboxes/*) and asserts the page renders its frame (headline + stat
// strip + health bar + mailbox list with the 8 hozan.taher.NN@post.cz rows +
// a warmup/limit badge) with no console errors.
//
// STRICTLY READ-ONLY: it selects rows (local UI state only — no network) to
// reveal the bulk bar and asserts the pause/resume controls EXIST, but never
// clicks them — pausing the live send fleet must not happen in a smoke.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

// operator_id cookie satisfies BOTH the BFF auth middleware AND the dev-only
// Firebase auth seam in authStore.js (import.meta.env.DEV + operator_id cookie).
async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}
function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // Tolerate only benign 404s (e.g. an optional endpoint missing locally).
    if (/404/.test(t)) return
    errs.push(`console.error: ${t}`)
  })
  return errs
}

test('Schránky — frame, stat strip, mailbox list, warmup badge, bulk controls', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/schranky')

  // Shell + headline.
  await expect(page.getByTestId('app-schranky')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { level: 1, name: /Schránky/ })).toBeVisible()

  // Stat strip + the anti-trace/egress/watchdog/bounce-guard health bar.
  await expect(page.getByTestId('app-schranky-stats')).toBeVisible()
  await expect(page.getByTestId('app-schranky-health')).toBeVisible()

  // Mailbox list rows — this DB holds 8 hozan.taher.NN@post.cz send mailboxes.
  await expect(page.getByTestId('app-schranky-list')).toBeVisible({ timeout: 15_000 })
  const rows = page.getByTestId('app-schranky-row')
  const rowCount = await rows.count()
  expect(rowCount).toBeGreaterThanOrEqual(1)
  await expect(page.getByText(/hozan\.taher\.\d+@post\.cz/).first()).toBeVisible()

  // A warmup / daily-limit badge is shown per row (read-only cap surface).
  await expect(page.getByTestId('app-schranky-warmup-badge').first()).toBeVisible()

  // Bulk pause/resume controls EXIST — reveal the bulk bar by selecting (local
  // state only, no network), assert the controls, but DO NOT click them.
  await page.getByTestId('app-schranky-select-all').check()
  await expect(page.getByTestId('app-schranky-bulkbar')).toBeVisible()
  await expect(page.getByTestId('app-schranky-bulk-pause')).toBeVisible()
  await expect(page.getByTestId('app-schranky-bulk-resume')).toBeVisible()
  // Clear selection again — leave no UI state behind.
  await page.getByTestId('app-schranky-bulk-clear').click()
  await expect(page.getByTestId('app-schranky-bulkbar')).toHaveCount(0)

  expect(errs, errs.join('\n')).toHaveLength(0)
})
