// Visual regression — screenshot each top route × {desktop, mobile}.
// Mask volatile data (counts, timestamps). Baselines live in
// e2e/visual.spec.ts-snapshots/. Failures upload diff artifacts in CI.
//
// Update baselines: pnpm exec playwright test visual --update-snapshots

import { test, expect, Page } from '@playwright/test'

const ROUTES = [
  { path: '/', name: 'home' },
  { path: '/companies', name: 'companies' },
  { path: '/campaigns', name: 'campaigns' },
  { path: '/mailboxes', name: 'mailboxes' },
  { path: '/templates', name: 'templates' },
  { path: '/replies', name: 'replies' },
  { path: '/segments', name: 'segments' },
  { path: '/analytics', name: 'analytics' },
  { path: '/healing', name: 'healing' },
]

const VIEWPORTS = [
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'mobile',  w: 390,  h: 844 },
]

// Selectors whose text content changes between runs — mask to ignore.
const VOLATILE_SELECTORS = [
  '[data-testid="ts"]',
  '[data-testid="count"]',
  'time',
  '.tabular-nums',  // aggregate stats
]

// Per-route diff budget. mailboxes/healing have live counters with text rerender —
// wider budget. Others tight. Catches structural drift everywhere.
const DIFF_BUDGET = {
  home:       10_000,
  companies:  10_000,
  campaigns:  10_000,
  mailboxes:  60_000,  // live counters, last_send_at, warmup day
  templates:  10_000,
  replies:    15_000,
  segments:   10_000,
  analytics:  20_000,  // live charts
  healing:    20_000,
}

async function prepare(page: Page) {
  // Disable animations for stable pixels
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }
  `})
  await page.waitForLoadState('networkidle').catch(() => {})
}

for (const vp of VIEWPORTS) {
  test.describe(`visual @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h } })

    for (const r of ROUTES) {
      test(`${r.name} ${vp.name}`, async ({ page }) => {
        await page.goto(r.path)
        await prepare(page)
        const masks = VOLATILE_SELECTORS.map(s => page.locator(s))
        await expect(page).toHaveScreenshot(`${r.name}-${vp.name}.png`, {
          fullPage: true,
          mask: masks,
          maxDiffPixels: DIFF_BUDGET[r.name] ?? 10_000,
          animations: 'disabled',
        })
      })
    }
  })
}
