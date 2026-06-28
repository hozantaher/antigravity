import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import * as fs from 'fs'
import * as path from 'path'

// Dashboard unification (2026-06-24): the operator dashboard is the single
// shell. a11y now gates the surfaces (was the Layout routes, which now
// redirect to these).
const ROUTES = [
  '/', '/schranky', '/kampane', '/kontakty', '/segmenty',
  '/sablony', '/odpovedi', '/analytika', '/firmy', '/upozorneni',
]

// Ratcheted gate (chore/a11y-gate-ratchet, 2026-04-30): blocks on any
// `critical` axe-core violation. ONE-WAY ratchet — never lower without
// fixing all serious violations first, then advance to include 'serious'.
// Violations are still recorded to reports/a11y/summary.json for trend
// tracking. Current backlog: ~10 serious (mostly color-contrast on muted
// text); fix those, then the next ratchet step is to add 'serious'.
const BLOCKING_IMPACTS = new Set<string>(['critical'])

const REPORT_DIR = path.join(process.cwd(), 'reports', 'a11y')
fs.mkdirSync(REPORT_DIR, { recursive: true })
const SUMMARY_PATH = path.join(REPORT_DIR, 'summary.json')

type RouteResult = {
  path: string
  critical: number
  serious: number
  moderate: number
  minor: number
  topViolations: { id: string; impact: string | null; nodes: number; help: string }[]
}
const summary: RouteResult[] = []

test.beforeEach(async ({ context }) => {
  // routes sit behind RequireAuth (Firebase). The operator_id cookie is the
  // dev/e2e auth seam (authStore.js) — without it every / route redirects to
  // /login and the shell never mounts.
  await context.addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
})

test.afterAll(() => {
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2))
})

for (const path_ of ROUTES) {
  test(`axe: ${path_}`, async ({ page }) => {
    await page.goto(path_)
    await expect(page.locator('[data-testid="app-shell"]')).toBeVisible({ timeout: 10_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze()

    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
    for (const v of results.violations) {
      if (v.impact && counts.hasOwnProperty(v.impact)) counts[v.impact as keyof typeof counts]++
    }

    const top = results.violations
      .slice()
      .sort((a, b) => (b.nodes.length - a.nodes.length))
      .slice(0, 5)
      .map(v => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length, help: v.help }))

    summary.push({ path: path_, ...counts, topViolations: top })

    const blocking = results.violations.filter(v => v.impact && BLOCKING_IMPACTS.has(v.impact))
    expect(blocking, `Critical a11y violations on ${path_}`).toEqual([])
  })
}
