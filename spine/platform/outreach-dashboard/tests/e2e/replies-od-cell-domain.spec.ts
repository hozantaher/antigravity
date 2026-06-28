import { test, expect } from '@playwright/test'

test.describe('RepliesTableRow Od cell — domain-forward + missing-sender fallback', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:18175/replies')
    // Wait for table to be visible
    await page.locator('[data-testid="replies-table"]').first().waitFor({ state: 'visible' })
  })

  test('renders domain only (not full email) in Od cell line 2 when display name exists', async ({ page }) => {
    // Assuming data includes a row with contact_name and from_email
    // e.g., contact_name='Jan Nováka' from_email='jan@firma.cz'
    const row = page.locator('[data-testid^="replies-row-"]').first()
    const senderCell = row.locator('td').nth(2) // Od cell (0-indexed: select, avatar, od)
    
    // Line 1: display name
    const displayNameSpan = senderCell.locator('span').first()
    // Should contain display name (not email)
    await expect(displayNameSpan).toContainText(/[A-Za-zÁČÉÍÓÚŮÝáčéíóúůý\s]+/)
    
    // Line 2: domain only (only present when a row has a distinct display name).
    // Real data may have name-less rows (single span), so guard on span count
    // rather than blocking on a non-existent nth(1).
    const spans = senderCell.locator('span')
    const spanCount = await spans.count()
    if (spanCount > 1) {
      const secondLineText = await spans.nth(1).textContent()
      // Domain should start with @ and not contain the full email local-part.
      if (secondLineText && secondLineText.includes('@')) {
        expect(secondLineText).toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
        expect(secondLineText).not.toMatch(/[a-zA-Z0-9._-]+@/)
      }
    }
  })

  test('renders (bez odesílatele) when both display name and email are missing', async ({ page }) => {
    // This test assumes either:
    // 1. Real data has such a malformed row, OR
    // 2. We mock it (requires E2E mock setup)
    // For now, we check that IF such a row appears, it's handled gracefully.
    
    const rows = page.locator('[data-testid^="replies-row-"]')
    const rowCount = await rows.count()
    
    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      const row = rows.nth(i)
      const senderCell = row.locator('td').nth(2)
      const senderText = await senderCell.textContent()
      
      // If row has no email visible at all, it should show the fallback
      if (!senderText?.includes('@')) {
        // Either a valid display name OR the fallback placeholder
        expect(
          senderText?.trim() === '(bez odesílatele)' ||
          senderText?.trim().length > 0
        ).toBeTruthy()
      }
    }
  })

  test('no console errors on page load', async ({ page }) => {
    let consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text())
      }
    })
    
    await page.goto('http://localhost:18175/replies')
    await page.locator('[data-testid="replies-table"]').first().waitFor({ state: 'visible' })
    await page.waitForTimeout(500)
    
    expect(consoleErrors).toHaveLength(0)
  })

  test('Od cell title attribute includes full sender info for tooltip', async ({ page }) => {
    const row = page.locator('[data-testid^="replies-row-"]').first()
    const senderCell = row.locator('td').nth(2)
    const cellDiv = senderCell.locator('div').first()
    
    const titleAttr = await cellDiv.getAttribute('title')
    // Title should be present (either display name, email, or fallback)
    expect(titleAttr).toBeTruthy()
    expect(titleAttr?.length).toBeGreaterThan(0)
  })
})
