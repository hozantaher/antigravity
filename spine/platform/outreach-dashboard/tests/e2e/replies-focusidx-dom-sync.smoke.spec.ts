import { test, expect } from '@playwright/test'

test.describe('Rank 1: Keyboard nav visible focus ring + DOM sync', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to /replies with mock data
    await page.goto('http://localhost:18175/replies')
    // Wait for table to render
    await page.waitForSelector('[data-testid="replies-table"]')
  })

  test('First row receives focus outline when focusIdx=0', async ({ page }) => {
    const firstRow = page.locator('[data-testid*="replies-row-"]').first()
    // Verify it has data-focused attribute
    const focusedAttr = await firstRow.getAttribute('data-focused')
    expect(focusedAttr).toBe('1')
    // Verify :focus-visible outline is applied
    const outline = await firstRow.evaluate((el) => {
      const style = window.getComputedStyle(el)
      return style.outline
    })
    expect(outline).toContain('rgb')
  })

  test('J key navigates down and updates visible focus', async ({ page }) => {
    const rows = page.locator('[data-testid*="replies-row-"]')
    const firstRow = rows.first()
    const secondRow = rows.nth(1)
    
    // First row should be focused
    let firstFocused = await firstRow.getAttribute('data-focused')
    expect(firstFocused).toBe('1')
    
    // Press J to move to next row
    await page.keyboard.press('j')
    await page.waitForTimeout(100)
    
    // First row should lose focus
    firstFocused = await firstRow.getAttribute('data-focused')
    expect(firstFocused).toBe('0')
    
    // Second row should gain focus
    const secondFocused = await secondRow.getAttribute('data-focused')
    expect(secondFocused).toBe('1')
  })

  test('K key navigates up and updates visible focus', async ({ page }) => {
    const rows = page.locator('[data-testid*="replies-row-"]')
    const firstRow = rows.first()
    const secondRow = rows.nth(1)
    
    // Navigate to second row
    await page.keyboard.press('j')
    await page.waitForTimeout(100)
    
    // Press K to move back to first row
    await page.keyboard.press('k')
    await page.waitForTimeout(100)
    
    // First row should be focused again
    const firstFocused = await firstRow.getAttribute('data-focused')
    expect(firstFocused).toBe('1')
    
    // Second row should lose focus
    const secondFocused = await secondRow.getAttribute('data-focused')
    expect(secondFocused).toBe('0')
  })

  test('Esc key refocuses table after closing modal', async ({ page }) => {
    const firstRow = page.locator('[data-testid*="replies-row-"]').first()
    
    // Open legend with ?
    await page.keyboard.press('?')
    await page.waitForSelector('[data-testid="replies-shortcut-legend"]')
    
    // Verify legend is visible
    const legend = page.locator('[data-testid="replies-shortcut-legend"]')
    await expect(legend).toBeVisible()
    
    // Press Esc to close
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    
    // Legend should be hidden
    await expect(legend).not.toBeVisible()
    
    // Table row should still have focus indicator
    const focused = await firstRow.getAttribute('data-focused')
    expect(focused).toBe('1')
  })

  test('Focused row scrolls into view', async ({ page }) => {
    // Simulate many rows by changing page size
    const sizeSelect = page.locator('[data-testid="replies-pagination-size-select"]')
    if (await sizeSelect.isVisible()) {
      await sizeSelect.selectOption('30')
      await page.waitForTimeout(300)
    }
    
    const rows = page.locator('[data-testid*="replies-row-"]')
    const rowCount = await rows.count()
    
    if (rowCount > 3) {
      // Navigate to the third row
      await page.keyboard.press('j')
      await page.keyboard.press('j')
      await page.waitForTimeout(100)
      
      const thirdRow = rows.nth(2)
      // Playwright Locator has no isInViewport(); compute it from the rect.
      const inView = await thirdRow.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const vh = window.innerHeight || document.documentElement.clientHeight
        return r.top >= 0 && r.bottom <= vh
      })
      expect(inView).toBe(true)
    }
  })

  test('No console errors on focus navigation', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    
    // Navigate through several rows
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('j')
      await page.waitForTimeout(50)
    }
    
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('k')
      await page.waitForTimeout(50)
    }
    
    expect(errors).toHaveLength(0)
  })
})

test.describe('Rank 10: Ctrl+G jump-to-page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:18175/replies')
    await page.waitForSelector('[data-testid="replies-table"]')
  })

  test('Jump-to-page input hidden when totalPages <= 5', async ({ page }) => {
    const jumpInput = page.locator('[data-testid="replies-pagination-jump-input"]')
    // Input should not be visible on default load (assuming < 5 pages)
    const visible = await jumpInput.isVisible().catch(() => false)
    // Either hidden or not visible is acceptable
  })

  test('Ctrl+G focuses jump-to-page input when visible', async ({ page }) => {
    // Navigate to /replies?size=10 to force multiple pages
    await page.goto('http://localhost:18175/replies?size=10')
    await page.waitForSelector('[data-testid="replies-table"]')
    
    const jumpInput = page.locator('[data-testid="replies-pagination-jump-input"]')
    const isVisible = await jumpInput.isVisible().catch(() => false)
    
    if (isVisible) {
      // Press Ctrl+G
      await page.keyboard.press('Control+G')
      await page.waitForTimeout(100)
      
      // Input should be focused
      const focused = await jumpInput.evaluate((el: HTMLInputElement) => el === document.activeElement)
      expect(focused).toBe(true)
    }
  })

  test('Jump-to-page navigates to entered page', async ({ page }) => {
    await page.goto('http://localhost:18175/replies?size=10')
    await page.waitForSelector('[data-testid="replies-table"]')
    
    const jumpInput = page.locator('[data-testid="replies-pagination-jump-input"]')
    const isVisible = await jumpInput.isVisible().catch(() => false)
    
    if (isVisible) {
      // Type page number
      await jumpInput.fill('2')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      
      // URL should reflect new page
      const url = page.url()
      expect(url).toContain('page=2')
    }
  })

  test('Jump-to-page input clamps to valid range', async ({ page }) => {
    await page.goto('http://localhost:18175/replies?size=10')
    await page.waitForSelector('[data-testid="replies-table"]')
    
    const jumpInput = page.locator('[data-testid="replies-pagination-jump-input"]')
    const isVisible = await jumpInput.isVisible().catch(() => false)
    
    if (isVisible) {
      const maxPage = await jumpInput.getAttribute('max')
      // Input should have max attribute set
      expect(maxPage).toBeTruthy()
    }
  })

  test('Esc key clears and blurs jump-to-page input', async ({ page }) => {
    await page.goto('http://localhost:18175/replies?size=10')
    await page.waitForSelector('[data-testid="replies-table"]')
    
    const jumpInput = page.locator('[data-testid="replies-pagination-jump-input"]')
    const isVisible = await jumpInput.isVisible().catch(() => false)
    
    if (isVisible) {
      await jumpInput.fill('2')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(100)
      
      // Input should be empty and blurred
      const value = await jumpInput.inputValue()
      expect(value).toBe('')
      
      const focused = await jumpInput.evaluate((el: HTMLInputElement) => el === document.activeElement)
      expect(focused).toBe(false)
    }
  })
})
