// responsivity-density.smoke.spec.ts — the S0 measuring kill-gate.
//
// The operator runs out of room for data on a laptop (~1366×768 / 1440×900).
// This spec proves the density system reclaims space and is data-INDEPENDENT
// (measures chrome/padding, not rows) so it runs with just Vite — no BFF/DB.
//
// Per HARD RULE feedback_playwright_smoke_required + the initiative
// docs/initiatives/2026-06-24-laptop-responsivity-density.md. The padding /
// width assertions FAIL if the compact token block or collapse is reverted.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

const LAPTOP = { width: 1366, height: 768 }
const DESKTOP = { width: 1920, height: 1080 }

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost', path: '/',
    httpOnly: false, sameSite: 'Lax',
  }])
}

function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  return errs
}

const padOf = (page: Page) =>
  page.getByTestId('app-content').evaluate((el) => {
    const s = getComputedStyle(el)
    return { top: parseFloat(s.paddingTop), left: parseFloat(s.paddingLeft) }
  })

const sidebarWidth = (page: Page) =>
  page.getByTestId('app-sidebar').evaluate((el) => el.getBoundingClientRect().width)

// Auto-compact derives from the viewport when no explicit preference is stored.
test('density auto-compacts on a laptop viewport, comfortable on desktop', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.setViewportSize(LAPTOP)
  await page.goto('/')
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-density', 'compact', { timeout: 15_000 })

  await page.setViewportSize(DESKTOP)
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-density', 'comfortable')
  expect(errs, errs.join('\n')).toHaveLength(0)
})

// Manual override beats auto and survives reload (mirrors the theme-toggle test).
test('density toggle flips compact↔comfortable and persists', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.setViewportSize(LAPTOP)
  await page.goto('/')

  const shell = page.getByTestId('app-shell')
  await expect(shell).toHaveAttribute('data-density', 'compact')  // auto on laptop
  await page.getByTestId('app-density-toggle').click()
  await expect(shell).toHaveAttribute('data-density', 'comfortable')  // explicit override wins
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-density', 'comfortable')  // persisted
  expect(errs, errs.join('\n')).toHaveLength(0)
})

// THE KILL-GATE: compact must measurably reclaim the page gutter vs comfortable.
test('compact reclaims page padding vs comfortable', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.setViewportSize(LAPTOP)
  await page.goto('/')

  await page.evaluate(() => localStorage.setItem('uiDensity', 'comfortable'))
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-density', 'comfortable')
  const comfy = await padOf(page)

  await page.evaluate(() => localStorage.setItem('uiDensity', 'compact'))
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-density', 'compact')
  const compact = await padOf(page)

  expect(compact.top, `compact top ${compact.top} < comfy top ${comfy.top}`).toBeLessThan(comfy.top)
  expect(compact.left).toBeLessThan(comfy.left)
  expect(comfy.top).toBeGreaterThanOrEqual(28)   // comfortable ≈ 32
  expect(compact.top).toBeLessThanOrEqual(20)     // compact ≈ 14
})

// Sidebar icon-collapse narrows the rail (~128px back) and persists.
test('sidebar collapse narrows the rail and persists', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.setViewportSize(LAPTOP)
  await page.goto('/')

  const expanded = await sidebarWidth(page)
  expect(expanded).toBeGreaterThan(150)  // ≈ 186

  await page.getByTestId('app-sidebar-toggle').click()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar', 'collapsed')
  const collapsed = await sidebarWidth(page)
  expect(collapsed).toBeLessThan(80)     // ≈ 56
  expect(collapsed).toBeLessThan(expanded)

  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-sidebar', 'collapsed')  // persisted
  expect(errs, errs.join('\n')).toHaveLength(0)
})
