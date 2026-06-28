// app-kampan-create.smoke.spec.ts
//
// Nová kampaň — create flow. Per HARD RULE feedback_playwright_smoke_required.
// Asserts the wizard renders + validates (Create disabled until a valid name).
// Does NOT submit: campaign creation is Go-proxied (enrolls contacts) and is
// covered by contract tests + a live-DB SQL check — a smoke must not mutate prod.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

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

test('Nová kampaň — wizard renders + reachable from list', async ({ page }) => {
  const errs = watchConsole(page)
  await ensureLoggedIn(page)

  // Reachable from the list "Nová kampaň" button.
  await page.goto('/kampane')
  const newBtn = page.getByTestId('app-kampane-new')
  await expect(newBtn).toBeVisible({ timeout: 15_000 })
  await newBtn.click()

  await expect(page).toHaveURL(/\/\/kampane\/nova$/)
  await expect(page.getByTestId('app-kampan-create')).toBeVisible({ timeout: 15_000 })
  for (const id of ['kc-identity', 'kc-audience', 'kc-sequence', 'kc-create']) {
    await expect(page.getByTestId(id)).toBeVisible()
  }

  // Validation: Create disabled with an empty name, enabled after a valid name
  // (templates load from /api/templates, defaulting each step).
  await expect(page.getByTestId('kc-create')).toBeDisabled()
  await page.getByTestId('kc-name').fill('Smoke test kampaň')
  await expect(page.getByTestId('kc-create')).toBeEnabled({ timeout: 10_000 })

  expect(errs, errs.join('\n')).toHaveLength(0)
})
