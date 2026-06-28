import { test, expect } from '@playwright/test'

/**
 * Rank 4 (2026-05-29) — Inline keystroke hints + persistent '?' shortcut discoverability cue.
 *
 * Smoke spec validates:
 *   1. Classification pills show keystroke hints (e.g., '[P]' for positive)
 *   2. Action bar buttons show keystroke hints (e.g., '[P]' on "Označit zájem")
 *   3. Keystroke cue "Klávesové zkratky: ?" appears below the filter row
 *   4. Keystroke hints fade after the operator uses the key (localStorage)
 *   5. No console errors
 */

test.describe('Replies Rank 4 — Keystroke hints', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:18175/replies')
    await page.waitForSelector('[data-testid^="replies-row-"]', { timeout: 15000 }).catch(() => {})
  })

  test('shows keystroke hints on classification pills', async ({ page }) => {
    // Find a positive reply (classification=Zájem, !handled)
    const positiveRow = await page.locator('[data-classification="Zájem"]').first()
    await expect(positiveRow).toContainText('[P]')
  })

  test('shows keystroke hints on action bar buttons', async ({ page }) => {
    // Action bar buttons should display keystroke hints
    const markPositiveBtn = page.locator('[data-testid="bulk-mark-positive"]')
    await expect(markPositiveBtn).toContainText('[P]')

    const markNegativeBtn = page.locator('[data-testid="bulk-mark-negative"]')
    await expect(markNegativeBtn).toContainText('[N]')

    const forwardCrmBtn = page.locator('[data-testid="bulk-forward-crm"]')
    await expect(forwardCrmBtn).toContainText('[C]')
  })

  test('shows keystroke discoverability cue below filter row', async ({ page }) => {
    const cue = page.locator('[data-testid="replies-keystroke-cue"]')
    await expect(cue).toBeVisible()
    await expect(cue).toContainText('Klávesové zkratky:')
  })

  test('fades keystroke hints after key is used', async ({ page }) => {
    // Get initial state (hints should be visible)
    const positiveRow = await page.locator('[data-classification="Zájem"]').first()
    const hint1 = positiveRow.locator('[data-testid="keystroke-hint"]').first()
    await expect(hint1).toBeVisible()

    // Simulate pressing 'P'
    await page.keyboard.press('p')
    await page.waitForTimeout(100)

    // Check localStorage was updated
    const used = await page.evaluate(() => {
      return JSON.parse(localStorage.getItem('replies_keystroke_badges_used') || '{}')
    })
    expect(used.p).toBe(true)

    // Reload and verify the [P] badge for the now-used 'p' key has faded.
    // (Other keys' badges legitimately persist, so we assert the 'p' badge
    // specifically — not "any keystroke-hint" — and that localStorage persists.)
    await page.reload()
    await page.waitForSelector('[data-testid^="replies-row-"]', { timeout: 15000 }).catch(() => {})
    const stillUsed = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('replies_keystroke_badges_used') || '{}').p === true)
    expect(stillUsed).toBe(true)
    const pBadges = page.locator('[data-classification="Zájem"]').filter({ hasText: '[P]' })
    await expect(pBadges).toHaveCount(0)
  })

  test('no console errors', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    await page.waitForTimeout(500)
    expect(errors).toEqual([])
  })
})
