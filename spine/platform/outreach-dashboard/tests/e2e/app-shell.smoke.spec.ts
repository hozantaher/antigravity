// app-shell.smoke.spec.ts
//
// Smoke pack for UX (Claude.ai aesthetic, mounted at /, parallel to
// v1). Per HARD RULE feedback_playwright_smoke_required: every new UI surface
// ships with a smoke in the same PR — goto + visible headline + no console
// error. lives under its own shell (.app-shell), so it gets a dedicated spec
// instead of a row in the v1-oriented today-shipped pack.
//
// Phase 1 surfaces: the shell, the landing (Home), the placeholder routes,
// and the light↔dark theme toggle. Real surfaces add their own assertions as
// each phase ships.

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
}

function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  return errs
}

test('landing renders the Claude-style shell + hero', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/')
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-home')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Klid pro denní triáž.' })).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('sidebar nav opens a real surface (all 6 nav items shipped)', async ({ page }) => {
  // Every nav item is a real surface now (Phases 1–6); no placeholders remain.
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/')
  await page.getByTestId('app-nav-Kampaně').click()
  await expect(page).toHaveURL(/\/kampane$/)
  await expect(page.getByTestId('app-kampane')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

// Regression: a Mac in system dark mode used to bleed dark scrollbars/canvas
// through the light page (the reported 'zabugovaný light/dark' bug). The fix
// pins color-scheme to the explicit theme — assert it holds under emulated
// system dark, both themes.
test('color-scheme is pinned to the explicit theme under system dark', async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: 'dark' })
  await ctx.addCookies([{ name: 'operator_id', value: 'operator', domain: 'localhost', path: '/', httpOnly: false, sameSite: 'Lax' }])
  const page = await ctx.newPage()
  await page.goto('/vozidla')
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 })
  const cs = () => page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!).colorScheme)
  expect(await cs()).toBe('light')                 // light theme stays light despite system dark
  await page.getByTestId('app-theme-toggle').click()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-theme', 'dark')
  expect(await cs()).toBe('dark')                  // dark theme → dark scrollbars (matching)
  await ctx.close()
})

test('theme toggle flips light↔dark and persists', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)
  await page.goto('/')
  const shell = page.getByTestId('app-shell')
  await expect(shell).toHaveAttribute('data-theme', 'light')
  await page.getByTestId('app-theme-toggle').click()
  await expect(shell).toHaveAttribute('data-theme', 'dark')
  // Persisted across reload via localStorage.
  await page.reload()
  await expect(page.getByTestId('app-shell')).toHaveAttribute('data-theme', 'dark')
  expect(errs, errs.join('\n')).toHaveLength(0)
})
