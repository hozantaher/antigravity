// app-kampan-a11y.spec.ts
//
// Accessibility gate for the campaign editor surfaces (detail + create).
// Mirrors tests/e2e/a11y.spec.ts: blocks on any `critical` axe-core violation
// (WCAG 2 A + AA). The shared a11y.spec targets routes with a selector +
// no auth; the shell needs the operator_id cookie (dev auth seam) instead.

import { test, expect, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

async function ensureLoggedIn(page: Page) {
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

async function axeCritical(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  return results.violations.filter((v) => v.impact === 'critical')
}

test('axe: campaign detail editor — 0 critical', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.goto('/kampane')
  const firstLink = page.getByTestId('app-campaign-link').first()
  await expect(firstLink).toBeVisible({ timeout: 15_000 })
  await firstLink.click()
  await expect(page.getByTestId('app-kampan-detail')).toBeVisible({ timeout: 15_000 })
  const critical = await axeCritical(page)
  expect(critical, JSON.stringify(critical.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})

test('axe: nová kampaň wizard — 0 critical', async ({ page }) => {
  await ensureLoggedIn(page)
  await page.goto('/kampane/nova')
  await expect(page.getByTestId('app-kampan-create')).toBeVisible({ timeout: 15_000 })
  const critical = await axeCritical(page)
  expect(critical, JSON.stringify(critical.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([])
})
