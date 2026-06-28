// app-crm.smoke.spec.ts — CRM klienti surface (operator story: browse the CRM
// book → search → open a client → jump to their linked kontakty/firmy).
import { test, expect, Page } from '@playwright/test'
test.describe.configure({ mode: 'parallel' })
async function login(page: Page) {
  await page.context().addCookies([{ name: 'operator_id', value: 'operator', domain: 'localhost', path: '/', httpOnly: false, sameSite: 'Lax' }])
}
function watch(page: Page): string[] { const e: string[] = []; page.on('pageerror', x => e.push(`pageerror: ${x.message}`)); page.on('console', m => { if (m.type() === 'error') e.push(`console.error: ${m.text()}`) }); return e }

test('CRM directory renders with rows + search', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/crm')
  await expect(page.getByTestId('app-crm')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-crm-search')).toBeVisible()
  await expect(page.getByTestId('app-crm-row').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('app-crm-empty')).toBeVisible()
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('CRM client detail + cross-link to kontakt (operator story)', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/crm?id=4')   // ABC PARKING — 2 linked contacts
  await expect(page.getByTestId('app-crm-detail')).toBeVisible({ timeout: 12_000 })
  await expect(page.getByTestId('app-crm-contacts')).toBeVisible()
  await page.getByTestId('app-crm-contact').first().click()
  await expect(page).toHaveURL(/\/\/kontakty\?id=\d+/)
  await expect(page.getByTestId('app-contact-detail')).toBeVisible({ timeout: 10_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})

test('CRM search filters the book', async ({ page }) => {
  const errs = watch(page); await login(page)
  await page.goto('/crm')
  await page.getByTestId('app-crm-search').fill('trans')
  await expect(page).toHaveURL(/[?&]q=trans/, { timeout: 5_000 })
  await expect(page.getByTestId('app-crm-row').first()).toBeVisible({ timeout: 15_000 })
  expect(errs, errs.join('\n')).toHaveLength(0)
})
