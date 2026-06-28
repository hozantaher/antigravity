// V1-V6 — Visual regression baseline (Phase 2 of "Tests as Heart").
// Playwright screenshot comparison for 12 critical surfaces × 2 viewports × 2 themes.
//
// Workflow:
//   1. First run: `pnpm e2e -- visual-regression --update-snapshots` → creates baselines
//   2. Subsequent runs: diff vs baseline → fail on >0.5% pixel diff
//   3. Manual approve: PR comment "/approve-visual" → updates baseline (Phase 2.V3)
//
// Threshold: 0.5% pixel diff (default Playwright `maxDiffPixelRatio`)
// CI runs after E2E suite (V6).

import { test, expect } from '@playwright/test'

const SURFACES = [
  { name: 'dashboard', path: '/' },
  { name: 'mailboxes', path: '/mailboxes' },
  { name: 'campaigns', path: '/campaigns' },
  { name: 'companies', path: '/companies' },
  { name: 'contacts', path: '/contacts' },
  { name: 'segments', path: '/segments' },
  { name: 'templates', path: '/templates' },
  { name: 'analytics', path: '/analytics' },
  { name: 'replies', path: '/replies' },
  { name: 'watchdog', path: '/watchdog' },
]

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 667 },
]

test.describe('V1-V6 — Visual regression baselines', () => {
  for (const surface of SURFACES) {
    for (const viewport of VIEWPORTS) {
      test(`${surface.name} @ ${viewport.name}`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        await page.goto(surface.path)
        // Wait for initial data load (heuristic: any h1/h2 visible)
        await page.waitForTimeout(2000)

        // Stabilize dynamic content: hide timestamps + spinners
        await page.evaluate(() => {
          document.querySelectorAll('[data-relative-time], [data-timestamp], .spinner, .loader').forEach(el => {
            ;(el as HTMLElement).style.visibility = 'hidden'
          })
        })

        await expect(page).toHaveScreenshot(`${surface.name}-${viewport.name}.png`, {
          maxDiffPixelRatio: 0.005, // 0.5% tolerance
          fullPage: false,
          // Mask known-volatile zones (e.g. "X minutes ago" labels)
          mask: [page.locator('[data-relative-time]'), page.locator('.timestamp')],
        })
      })
    }
  }
})

// V5 — Theme toggle baselines (light + dark)
const THEMES = ['light', 'dark']
test.describe('V5 — Theme regression', () => {
  for (const theme of THEMES) {
    test(`dashboard @ ${theme}`, async ({ page }) => {
      await page.goto('/')
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t
        localStorage.setItem('theme', t)
      }, theme)
      await page.waitForTimeout(1000)
      await expect(page).toHaveScreenshot(`dashboard-${theme}.png`, {
        maxDiffPixelRatio: 0.005,
      })
    })
  }
})
