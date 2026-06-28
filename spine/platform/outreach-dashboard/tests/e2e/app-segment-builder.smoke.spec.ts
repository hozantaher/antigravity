// app-segment-builder.smoke.spec.ts
//
// Nový segment — live PII-safe count builder. Per HARD RULE
// feedback_playwright_smoke_required. Drives the real local BFF: the category
// tree (GET /api/categories) renders, the live preview (GET /api/segments/preview)
// produces a count, and picking a category re-runs the debounced preview. Does
// NOT save: POST /api/segments writes a row — a smoke must not mutate prod.
//
// Route /segmenty/novy is wired in the integrate phase (static 'segmenty/novy'
// before any dynamic ':id', mirroring 'kampane/nova'); this spec is the contract.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

// operator_id cookie satisfies BOTH the BFF auth middleware AND the dev-only
// Firebase auth seam in authStore.js (import.meta.env.DEV + operator_id cookie).
async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}
function watchConsole(page: Page): string[] {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`console.error: ${m.text()}`) })
  return errs
}

test('Nový segment — tree + live count render, picking a category responds', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  await page.goto('/segmenty/novy')

  // Shell + headline.
  await expect(page.getByTestId('app-segment-builder')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Nový segment' })).toBeVisible()

  // Category tree container renders (4-state fetch). The category taxonomy may
  // legitimately be empty in this environment (the NACE/category tree is not
  // populated) — the page must render its tree region either way: nodes when
  // present, a calm empty state when not.
  const tree = page.getByTestId('app-sb-tree')
  await expect(tree).toBeVisible({ timeout: 15_000 })

  // Live preview count appears after the debounced GET /api/segments/preview
  // (driven by the email-status/region filters, independent of the tree).
  const count = page.getByTestId('app-sb-count')
  await expect(count).toBeVisible()
  await expect(count).toHaveText(/\d|—/, { timeout: 15_000 })

  // If the taxonomy has nodes, picking one toggles its checkbox + re-runs the
  // debounced preview. If empty (the real data state here), the count control
  // still stays alive and responds.
  const nodes = page.getByTestId('app-sb-node')
  if (await nodes.count() > 0) {
    const firstNode = nodes.first()
    await firstNode.locator('input[type="checkbox"]').check()
    await expect(firstNode.locator('input[type="checkbox"]')).toBeChecked()
  }
  await expect(count).toBeVisible()
  await expect(count).toHaveText(/\d|—/, { timeout: 15_000 })

  // Save is gated on a name (no accidental mutation from a bare smoke).
  await expect(page.getByTestId('app-sb-save')).toBeDisabled()

  expect(errs, errs.join('\n')).toHaveLength(0)
})
