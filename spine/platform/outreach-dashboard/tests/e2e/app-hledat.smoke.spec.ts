// app-hledat.smoke.spec.ts — cross-entity global search (data-mining entry point).
// Operator story: type a term in the topbar → grouped results across entities →
// click a hit → land on that entity's surface.
import { test, expect, Page } from '@playwright/test'
test.describe.configure({ mode: 'parallel' })
async function login(page: Page) {
  await page.context().addCookies([{ name: 'operator_id', value: 'operator', domain: 'localhost', path: '/', httpOnly: false, sameSite: 'Lax' }])
}
function watch(page: Page): string[] { const e: string[] = []; page.on('pageerror', x => e.push(`pageerror: ${x.message}`)); page.on('console', m => { if (m.type() === 'error') e.push(`console.error: ${m.text()}`) }); return e }

test('global search returns grouped cross-entity hits', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/hledat?q=trans')
  await expect(page.getByTestId('app-hledat')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByTestId('app-hledat-hit').first()).toBeVisible({ timeout: 12_000 })
  // at least 2 entity groups for a common term
  const groups = await page.locator('[data-testid^="app-hledat-group-"]').count()
  expect(groups).toBeGreaterThanOrEqual(2)
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('topbar search navigates to the global search surface', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/vozidla')
  await page.getByTestId('app-topbar-search').fill('trans')
  await page.getByTestId('app-topbar-search').press('Enter')
  await expect(page).toHaveURL(/\/\/hledat\?q=trans/)
  await expect(page.getByTestId('app-hledat')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('clicking a search hit lands on the entity surface', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/hledat?q=trans')
  await page.getByTestId('app-hledat-hit').first().waitFor({ timeout: 12_000 })
  await page.getByTestId('app-hledat-hit').first().click()
  await expect(page).toHaveURL(/\/\/(odpovedi|vozidla|kontakty|firmy|crm)/)
  expect(errs, errs.join('\n')).toHaveLength(0)
})
