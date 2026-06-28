// app-kvalita.smoke.spec.ts — system data-quality health surface.
import { test, expect, Page } from '@playwright/test'
test.describe.configure({ mode: 'parallel' })
async function login(page: Page) {
  await page.context().addCookies([{ name: 'operator_id', value: 'operator', domain: 'localhost', path: '/', httpOnly: false, sameSite: 'Lax' }])
}
function watch(page: Page): string[] { const e: string[] = []; page.on('pageerror', x => e.push(`pageerror: ${x.message}`)); page.on('console', m => { if (m.type() === 'error') e.push(`console.error: ${m.text()}`) }); return e }

test('Kvalita dat renders the health hero + checks', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/kvalita')
  await expect(page.getByTestId('app-kvalita')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByTestId('app-kvalita-hero')).toBeVisible({ timeout: 12_000 })
  // ≥5 checks render (errors + warnings + info)
  expect(await page.getByTestId('app-dq-check').count()).toBeGreaterThanOrEqual(5)
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('Kvalita reachable from sidebar nav', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/')
  await page.getByTestId('app-nav-Kvalita dat').click()
  await expect(page).toHaveURL(/\/\/kvalita$/)
  await expect(page.getByTestId('app-kvalita-hero')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})
