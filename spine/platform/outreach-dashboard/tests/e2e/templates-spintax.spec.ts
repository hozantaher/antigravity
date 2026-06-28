// E1 — Templates page spintax E2E (Playwright).
// Verifies the spintax UI surfaces (variant badges, reseed, "Všechny varianty"
// expand) work end-to-end against the running dev server.

import { test, expect } from '@playwright/test'

test.describe('E1 — Templates spintax UI E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/templates')
    await page.waitForTimeout(1500)
  })

  test('načte stránku s tlačítkem "Nová šablona"', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Nová šablona/ }).first()).toBeVisible()
  })

  test('modál ukáže "bez spintax" badge pro plain body', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    const body = page.locator('textarea').first()
    await body.fill('Plain body, no spin')

    const badge = page.getByTestId('body-spintax')
    await expect(badge).toContainText(/bez spintax/i)
    await expect(badge).toHaveAttribute('data-tone', 'muted')
  })

  test('modál spočítá variants pro spintax body', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    const body = page.locator('textarea').first()
    await body.fill('{Ahoj|Dobrý den|Zdravím}, {pane|paní}')

    const badge = page.getByTestId('body-spintax')
    await expect(badge).toContainText(/6/)
    await expect(badge).toHaveAttribute('data-tone', 'ok')
  })

  test('nezavřená závorka vyhodí err badge a disable Vytvořit', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    await page.locator('input[placeholder*="Název"]').first().fill('Test')
    await page.locator('input[placeholder*="Předmět"]').first().fill('Subject')
    await page.locator('textarea').first().fill('broken {unclosed')

    const badge = page.getByTestId('body-spintax')
    await expect(badge).toHaveAttribute('data-tone', 'err')

    const errDetail = page.getByTestId('spintax-error-detail')
    await expect(errDetail).toContainText(/unclosed/i)

    const create = page.getByRole('button', { name: /Vytvořit/ })
    await expect(create).toBeDisabled()
  })

  test('Náhled zobrazí rozšířené varianty bez závorek', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    await page.locator('textarea').first().fill('{Ahoj|Zdravím} {{jmeno}}')
    await page.getByRole('button', { name: /Náhled/ }).click()

    const preview = page.getByTestId('preview-body')
    await expect(preview).not.toContainText('{')
    await expect(preview).not.toContainText('|')
    // Sample contact substituted
    await expect(preview).toContainText(/Novák/)
  })

  test('Reseed mění zobrazenou variantu', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    await page.locator('textarea').first().fill('{A|B|C|D|E|F|G|H|I|J}')
    await page.getByRole('button', { name: /Náhled/ }).click()

    const preview = page.getByTestId('preview-body')
    const before = await preview.textContent()

    let differentSeen = false
    for (let i = 0; i < 20; i++) {
      await page.getByTestId('reseed-preview').click()
      const after = await preview.textContent()
      if (after !== before) {
        differentSeen = true
        break
      }
    }
    expect(differentSeen).toBe(true)
  })

  test('"Všechny varianty" toggle zobrazí list', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    await page.locator('textarea').first().fill('{a|b|c}')
    await page.getByRole('button', { name: /Náhled/ }).click()
    await page.getByTestId('toggle-all-variants').click()

    const list = page.getByTestId('all-variants-list')
    await expect(list).toBeVisible()
    await expect(list).toContainText('a')
    await expect(list).toContainText('b')
    await expect(list).toContainText('c')
  })

  test('"Všechny varianty" disabled pro plain text', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    await page.locator('textarea').first().fill('plain text only')
    await page.getByRole('button', { name: /Náhled/ }).click()

    await expect(page.getByTestId('toggle-all-variants')).toBeDisabled()
  })

  test('Save button enabled s validním spintax', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    await page.locator('input[placeholder*="Název"]').first().fill('Test E2E')
    await page.locator('input[placeholder*="Předmět"]').first().fill('Subj')
    await page.locator('textarea').first().fill('{Ahoj|Zdravím}, {{jmeno}}')

    await expect(page.getByRole('button', { name: /Vytvořit/ })).not.toBeDisabled()
  })

  test('hint zobrazí spintax syntax example', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)
    await expect(page.locator('text=Spintax')).toBeVisible()
  })
})
