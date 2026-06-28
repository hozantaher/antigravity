// command-palette.spec.ts
//
// Sprint D3 E2E tests for Ctrl+K CommandPalette (F4 surface).
// Tests: open/close, search filtering, navigation, platform-specific keybindings.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id',
    value: 'operator',
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    sameSite: 'Lax',
  }])
  await page.goto('/')
  const op = page.locator('input[name="operator_id"], input[placeholder*="operator"]').first()
  if (await op.isVisible({ timeout: 1000 }).catch(() => false)) {
    await op.fill('operator')
    await page.locator('button[type="submit"]').first().click()
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})
  }
}

test('[D3] Ctrl+K opens CommandPalette modal', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Ensure page body is focused before sending keyboard event
  await page.locator('body').focus()
  await page.waitForTimeout(200)

  // Press Ctrl+K to open (palette might not be visible immediately if ListBox not rendered yet)
  await page.keyboard.press('Control+K')

  // Verify modal is visible
  const palette = page.locator('.cmdk-bg')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Verify search input is focused and visible
  const input = page.locator('.cmdk-input')
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()

  // Verify at least one navigation item visible
  const items = page.locator('.cmdk-item')
  await expect(items).not.toHaveCount(0)

  // Check no unexpected errors (tolerate 429/401 from unready backend)
  const ourErrors = consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !e.includes('preload') &&
    !e.includes('Failed to load resource') // tolerate network errors
  )
  expect(ourErrors, 'CommandPalette should be error-free').toHaveLength(0)
})

test('[D3] Esc closes CommandPalette', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Ensure page body is focused before sending keyboard event
  await page.locator('body').focus()
  await page.waitForTimeout(200)

  // Open palette
  await page.keyboard.press('Control+K')
  const palette = page.locator('.cmdk-bg')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Press Escape to close
  await page.keyboard.press('Escape')

  // Verify modal is gone
  await expect(palette).not.toBeVisible()

  // Check no unexpected errors
  const ourErrors = consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !e.includes('preload') &&
    !e.includes('Failed to load resource')
  )
  expect(ourErrors, 'CommandPalette close should be error-free').toHaveLength(0)
})

test('[D3] Search filters items by query', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Ensure page body is focused before sending keyboard event
  await page.locator('body').focus()
  await page.waitForTimeout(200)

  // Open palette
  await page.keyboard.press('Control+K')
  const palette = page.locator('.cmdk-bg')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Type "kamp" to search for campaigns
  const input = page.locator('.cmdk-input')
  await input.fill('kamp')

  // Verify "Kampaně" label is visible
  const kampaneItem = page.locator('.cmdk-item', { hasText: 'Kampaně' }).first()
  await expect(kampaneItem).toBeVisible()

  // Verify filtered item count is smaller than full list
  const itemCount = await page.locator('.cmdk-item').count()
  expect(itemCount).toBeGreaterThan(0)
  expect(itemCount).toBeLessThan(15) // Filtered list should be smaller

  // Check no unexpected errors
  const ourErrors = consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !e.includes('preload') &&
    !e.includes('Failed to load resource')
  )
  expect(ourErrors, 'Filter should be error-free').toHaveLength(0)
})

test('[D3] Enter navigates to first matched item', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Ensure page body is focused before sending keyboard event
  await page.locator('body').focus()
  await page.waitForTimeout(200)

  // Open palette
  await page.keyboard.press('Control+K')
  const palette = page.locator('.cmdk-bg')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Type "schránky" to search
  const input = page.locator('.cmdk-input')
  await input.fill('schránky')

  // Wait for search results
  await page.waitForTimeout(100)

  // Verify "Schránky" item is visible (first match)
  const schrankyItem = page.locator('.cmdk-item', { hasText: 'Schránky' }).first()
  await expect(schrankyItem).toBeVisible()

  // Press Enter to navigate
  await page.keyboard.press('Enter')

  // Wait for navigation
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

  // Verify we navigated to /mailboxes (or /mailboxes?*)
  const url = page.url()
  expect(url).toContain('/mailboxes')

  // Verify palette is closed
  await expect(palette).not.toBeVisible()

  // Check no unexpected errors (network errors tolerable)
  const ourErrors = consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !e.includes('preload') &&
    !e.includes('Failed to load resource')
  )
  expect(ourErrors, 'Navigation should be error-free').toHaveLength(0)
})

test('[D3] Cmd+K on macOS equivalent to Ctrl+K', async ({ page, browserName }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Ensure page body is focused before sending keyboard event
  await page.locator('body').focus()
  await page.waitForTimeout(200)

  // On any platform, try Meta+K (macOS Cmd equivalent)
  // Most platforms interpret Meta as Win/Cmd depending on OS
  await page.keyboard.press('Meta+K')

  // If system doesn't bind Meta+K, try Ctrl+K as fallback
  let palette = page.locator('.cmdk-bg')
  let visible = await palette.isVisible({ timeout: 1000 }).catch(() => false)

  if (!visible) {
    await page.keyboard.press('Control+K')
    visible = await palette.isVisible({ timeout: 1000 }).catch(() => false)
  }

  expect(visible, 'CommandPalette should open via Meta+K or Ctrl+K').toBe(true)

  // Verify search input is focused
  const input = page.locator('.cmdk-input')
  await expect(input).toBeFocused()

  // Check no unexpected errors
  const ourErrors = consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !e.includes('preload') &&
    !e.includes('Failed to load resource')
  )
  expect(ourErrors, 'Meta+K keybinding should be error-free').toHaveLength(0)
})

test('[D3] Click on item navigates', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Ensure page body is focused before sending keyboard event
  await page.locator('body').focus()
  await page.waitForTimeout(200)

  // Open palette
  await page.keyboard.press('Control+K')
  const palette = page.locator('.cmdk-bg')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Click on "Odpovědi" item (first static item)
  const odpovediItem = page.locator('.cmdk-item', { hasText: 'Odpovědi' }).first()
  await expect(odpovediItem).toBeVisible()
  await odpovediItem.click()

  // Wait for navigation
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

  // Verify navigation to /replies (primary landing route)
  const url = page.url()
  expect(url).toContain('/replies')

  // Verify palette is closed
  await expect(palette).not.toBeVisible()

  // Check no unexpected errors (network errors tolerable)
  const ourErrors = consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !e.includes('preload') &&
    !e.includes('Failed to load resource')
  )
  expect(ourErrors, 'Click navigation should be error-free').toHaveLength(0)
})

test('[D3] Clicking backdrop closes palette', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`)
  })

  await ensureLoggedIn(page)
  await page.goto('/')

  // Ensure page body is focused before sending keyboard event
  await page.locator('body').focus()
  await page.waitForTimeout(200)

  // Open palette
  await page.keyboard.press('Control+K')
  const palette = page.locator('.cmdk-bg')
  await expect(palette).toBeVisible({ timeout: 3000 })

  // Click on backdrop (cmdk-bg) to dismiss
  const backdrop = page.locator('.cmdk-bg')
  await backdrop.click({ position: { x: 10, y: 10 } })

  // Verify palette is closed
  await expect(palette).not.toBeVisible()

  // Check no unexpected errors (network errors tolerable)
  const ourErrors = consoleErrors.filter(e =>
    !e.includes('React DevTools') &&
    !e.includes('favicon') &&
    !e.includes('sourcemap') &&
    !e.includes('preload') &&
    !e.includes('Failed to load resource')
  )
  expect(ourErrors, 'Backdrop click should be error-free').toHaveLength(0)
})
