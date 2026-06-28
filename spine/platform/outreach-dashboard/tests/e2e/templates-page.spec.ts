// ═══════════════════════════════════════════════════════════════════════════
//  /templates page — supplementary E2E smoke spec
//
//  Focuses on: page load without crash, template list rendering, empty state,
//  "Nová šablona" button visibility, no JS errors.
//
//  All store-bootstrap endpoints + /api/templates stubbed deterministically.
//  Does NOT depend on a running backend.
// ═══════════════════════════════════════════════════════════════════════════

import { test, expect, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TWO_TEMPLATES = [
  {
    id: 1,
    name: 'Úvodní šablona',
    subject: 'Naše nabídka pro {{firma}}',
    body: 'Dobrý den {{jmeno}},\n\npíšu Vám ohledně…',
    created_at: '2026-04-20T10:00:00Z',
  },
  {
    id: 2,
    name: 'Druhý e-mail',
    subject: 'Follow-up: {{firma}}',
    body: 'Zdravím,\n\nsleduji náš předchozí e-mail…',
    created_at: '2026-04-18T10:00:00Z',
  },
]

const EMPTY_TEMPLATES: unknown[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function stubTemplatesPage(page: Page, templates: unknown) {
  // Primary endpoint
  await page.route('**/api/templates', (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(templates),
    })
  })
  // Ranking endpoint (used by Templates.jsx via useResource)
  await page.route('**/api/templates/ranking', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ranking":[]}',
    })
  )
  // Store bootstrap endpoints
  for (const ep of [
    '**/api/mailboxes',
    '**/api/campaigns',
    '**/api/segments',
  ]) {
    await page.route(ep, (route) => {
      if (route.request().method() !== 'GET') return route.fallback()
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '[]',
      })
    })
  }
  await page.route('**/api/companies/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"total":0}',
    })
  )
  await page.route('**/api/replies/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"unhandled":0,"positive":0,"negative":0,"auto_reply":0}',
    })
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe('/templates-page — smoke', () => {
  test('templates page loads without crash', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await expect(page.locator('h2')).toContainText('Šablony')
  })

  test('template list renders with template names', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await expect(page.locator('text=/Úvodní šablona/')).toBeVisible()
    await expect(page.locator('text=/Druhý e-mail/')).toBeVisible()
  })

  test('template subject displayed below name', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await expect(page.locator('text=/Naše nabídka pro/')).toBeVisible()
  })

  test('"Nová šablona" button is visible', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await expect(page.getByRole('button', { name: /Nová šablona/ }).first()).toBeVisible()
  })

  test('empty state shows "Žádné šablony" placeholder', async ({ page }) => {
    await stubTemplatesPage(page, EMPTY_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await expect(page.locator('text=/Žádné šablony/')).toBeVisible()
  })

  test('empty state also shows "Nová šablona" CTA', async ({ page }) => {
    await stubTemplatesPage(page, EMPTY_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await expect(page.getByRole('button', { name: /Nová šablona/ }).first()).toBeVisible()
  })

  test('no JS errors on page load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    expect(errors.length).toBe(0)
  })

  test('"Nová šablona" click opens modal with Název field', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await expect(
      page.locator('input[placeholder*="Název"]').first()
    ).toBeVisible({ timeout: 5_000 })
  })

  test('modal Vytvořit button disabled when fields empty', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    // Ensure fields are empty
    const nameInput = page.locator('input[placeholder*="Název"]').first()
    await expect(nameInput).toBeVisible({ timeout: 5_000 })
    await nameInput.clear()
    await page.locator('input[placeholder*="Předmět"]').first().clear()
    await page.locator('textarea').first().clear()
    const createBtn = page.getByRole('button', { name: 'Vytvořit', exact: true })
    await expect(createBtn).toBeDisabled({ timeout: 3_000 })
  })

  test('modal Zrušit closes modal without adding template', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await expect(
      page.locator('input[placeholder*="Název"]').first()
    ).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: 'Zrušit', exact: true }).click()
    // Modal must be gone
    await expect(page.getByRole('button', { name: 'Vytvořit', exact: true })).not.toBeVisible()
    // Still 2 templates visible
    await expect(page.locator('text=/Úvodní šablona/')).toBeVisible()
  })

  test('two templates render two card items', async ({ page }) => {
    await stubTemplatesPage(page, TWO_TEMPLATES)
    await page.goto('/templates')
    await page.waitForSelector('h2', { timeout: 10_000 })
    // Each template is rendered as a .card — count should be at least 2
    const cards = page.locator('.card')
    const count = await cards.count()
    expect(count).toBeGreaterThanOrEqual(2)
  })
})
