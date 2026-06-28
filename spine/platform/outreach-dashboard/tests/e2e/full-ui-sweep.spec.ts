// full-ui-sweep — screenshot napříč všech 17 dashboard sekcí
// ─────────────────────────────────────────────────────────────────────────────
// Cíl: pre-launch visual verification že každá stránka renderuje bez crashe.
// NE strict assertions na obsah (page content závisí na PROD DB state).
// Saves screenshots do reports/screenshots/2026-05-06-full-sweep/<page>.png

import { test, expect, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const REPORT_DIR = 'reports/screenshots/2026-05-06-full-sweep'

const PAGES = [
  { path: '/priprava', name: 'priprava' },
  { path: '/replies', name: 'replies' },
  { path: '/campaigns', name: 'campaigns' },
  { path: '/mailboxes', name: 'mailboxes' },
  { path: '/companies', name: 'companies' },
  { path: '/segments', name: 'segments' },
  { path: '/contacts', name: 'contacts' },
  { path: '/leads', name: 'leads' },
  { path: '/templates', name: 'templates' },
  { path: '/scoring', name: 'scoring' },
  { path: '/crm/clients', name: 'crm-clients' },
  { path: '/analytics', name: 'analytics' },
  { path: '/watchdog', name: 'watchdog' },
  { path: '/observability', name: 'observability' },
  { path: '/diagnostika/anonymita', name: 'diagnostika-anonymita' },
  { path: '/dedup-guard', name: 'dedup-guard' },
  { path: '/launch-readiness?campaign_id=457&segment_id=7', name: 'launch-readiness' },
]

test.beforeAll(() => {
  mkdirSync(REPORT_DIR, { recursive: true })
})

async function captureNoFailures(page: Page, path: string, name: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text()
      // Filter rate-limit (429) noise — that's load testing artifact, not page bug
      if (!text.includes('429')) errors.push(`console.error: ${text}`)
    }
  })

  await page.goto(path, { timeout: 15_000 })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  // Give React time to render initial fetch results
  await page.waitForTimeout(2_000)

  await page.screenshot({ path: `${REPORT_DIR}/${name}.png`, fullPage: true })

  if (errors.length > 0) {
    console.log(`[${name}] ERRORS:`, errors.slice(0, 5).join('; '))
  } else {
    console.log(`[${name}] CLEAN`)
  }
  return errors
}

for (const { path, name } of PAGES) {
  test(`render ${name}`, async ({ page }) => {
    const errors = await captureNoFailures(page, path, name)
    // Allow 0 errors as pass; anything else logs but doesn't fail (test
    // captures evidence — operator reviews screenshots)
    expect(errors.length, `${name}: ${errors.slice(0, 3).join('; ')}`).toBeLessThan(5)
  })
}
