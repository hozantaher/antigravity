import { test } from '@playwright/test'
const ROUTES = [
  ['/', 'home'],
  ['/replies/triage', 'triage'],
  ['/pipeline', 'pipeline'],
  ['/leads/854', 'lead-detail'],
  ['/search', 'search'],
  ['/analytics?tab=mat', 'analytics-math'],
]
for (const [r, slug] of ROUTES) {
  test(`actual ${slug}`, async ({ page }) => {
    const errs: string[] = []
    page.on('console', m => { if (m.type() === 'error') errs.push(`${m.text().slice(0, 120)}`) })
    page.on('pageerror', e => errs.push(`pageerror: ${e.message}`))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`http://localhost:18175${r}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3500)
    await page.screenshot({ path: `/tmp/actual-${slug}.png`, fullPage: false })
    console.log(`[${slug}] console errors: ${errs.length}`)
    errs.slice(0, 5).forEach(e => console.log(`  ${e}`))
  })
}
