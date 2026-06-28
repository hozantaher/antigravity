import { test, expect } from '@playwright/test'

test.describe('Templates — CRUD', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/templates')
    await page.waitForTimeout(1500)
  })

  test('stránka se načte s nadpisem Šablony', async ({ page }) => {
    await expect(page.locator('h2')).toContainText('Šablony')
  })

  test('tlačítko + Nová šablona je viditelné', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Nová šablona/ }).first()).toBeVisible()
  })

  test('otevření modálu zobrazí pole Název, Předmět a Tělo', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    // Název šablony
    await expect(
      page.locator('input[placeholder*="Název"]').first()
    ).toBeVisible({ timeout: 3000 })

    // Předmět e-mailu
    await expect(
      page.locator('input[placeholder*="Předmět"]').first()
    ).toBeVisible({ timeout: 3000 })

    // Tělo e-mailu
    await expect(
      page.locator('textarea[placeholder*="Tělo"], textarea[id*="body"], textarea[name*="body"], textarea').first()
    ).toBeVisible({ timeout: 3000 })
  })

  test('tlačítko Vytvořit je zakázáno když jsou pole prázdná', async ({ page }) => {
    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    // Ujisti se že všechna pole jsou prázdná
    const nameInput = page.locator('input[placeholder*="Název"]').first()
    const subjectInput = page.locator('input[placeholder*="Předmět"]').first()
    const bodyInput = page.locator('textarea').first()

    await nameInput.clear()
    await subjectInput.clear()
    await bodyInput.clear()

    const createBtn = page.getByRole('button', { name: 'Vytvořit', exact: true })
    await expect(createBtn).toBeDisabled({ timeout: 3000 })
  })

  test('vytvoření šablony: vyplnit všechna pole → kliknout Vytvořit → šablona se zobrazí v seznamu', async ({ page }) => {
    const ts = Date.now()
    const templateName = `E2E šablona ${ts}`
    const subject = `Testovací předmět ${ts}`
    const body = `Toto je tělo e-mailu pro testovací šablonu ${ts}.`

    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    const nameInput = page.locator('input[placeholder*="Název"]').first()
    await nameInput.fill(templateName)

    const subjectInput = page.locator('input[placeholder*="Předmět"]').first()
    await subjectInput.fill(subject)

    const bodyInput = page.locator('textarea').first()
    await bodyInput.fill(body)

    await page.waitForTimeout(200)

    const createBtn = page.getByRole('button', { name: 'Vytvořit', exact: true })
    await expect(createBtn).toBeEnabled({ timeout: 3000 })
    await createBtn.click()
    await page.waitForTimeout(1500)

    // Šablona se musí zobrazit — v tabulce nebo kartách
    await expect(page.locator('body')).toContainText(templateName, { timeout: 5000 })
  })

  test('editace šablony (pokud existuje): modal je předvyplněný → uložit', async ({ page }) => {
    // Zjisti jestli vůbec existuje nějaká šablona
    const rowCount = await page.locator('table tbody tr').count()
    const cardCount = await page.locator('[data-testid*="template"], .template-card').count()
    if (rowCount === 0 && cardCount === 0) return

    // Klikni na první editovací tlačítko
    const editBtn = page.locator('button[title*="Upravit"], button[aria-label*="edit"], button[aria-label*="upravit"]').first()
    const hasEdit = await editBtn.count() > 0
    if (!hasEdit) return

    await editBtn.click()
    await page.waitForTimeout(300)

    // Modal je otevřený — název pole musí být vyplněné (ne prázdné)
    const nameInput = page.locator('input[placeholder*="Název"]').first()
    await expect(nameInput).toBeVisible({ timeout: 3000 })
    const currentName = await nameInput.inputValue()
    expect(currentName.length).toBeGreaterThan(0)

    // Uprav název
    await nameInput.fill(currentName + ' (upraveno)')
    await page.waitForTimeout(200)

    // Ulož
    const saveBtn = page.getByRole('button', { name: /Uložit|Vytvořit|Upravit/i }).last()
    await expect(saveBtn).toBeEnabled({ timeout: 3000 })
    await saveBtn.click()
    await page.waitForTimeout(1500)
    // test prošel = OK
  })

  test('smazání šablony s potvrzovacím dialogem (pokud existuje)', async ({ page }) => {
    const rowCount = await page.locator('table tbody tr').count()
    const cardCount = await page.locator('[data-testid*="template"], .template-card').count()
    const totalItems = rowCount + cardCount
    if (totalItems === 0) return

    // Klikni na první tlačítko Smazat / Trash
    const deleteBtn = page.locator('button[title*="Smazat"], button[aria-label*="delete"], button[aria-label*="smazat"]').first()
    const hasDelete = await deleteBtn.count() > 0
    if (!hasDelete) return

    await deleteBtn.click()
    await page.waitForTimeout(300)

    // Potvrď dialog
    const confirmBtn = page.getByRole('button', { name: /Smazat|Potvrdit|Ano/i }).last()
    if (await confirmBtn.isVisible({ timeout: 2000 })) {
      await confirmBtn.click()
      await page.waitForTimeout(1000)

      const rowCountAfter = await page.locator('table tbody tr').count()
      const cardCountAfter = await page.locator('[data-testid*="template"], .template-card').count()
      expect(rowCountAfter + cardCountAfter).toBeLessThan(totalItems)
    }
  })

  test('tlačítko Zrušit zavře modál bez vytvoření šablony', async ({ page }) => {
    const rowCountBefore = await page.locator('table tbody tr').count()
    const cardCountBefore = await page.locator('[data-testid*="template"], .template-card').count()

    await page.getByRole('button', { name: /Nová šablona/ }).first().click()
    await page.waitForTimeout(300)

    const nameInput = page.locator('input[placeholder*="Název"]').first()
    await nameInput.fill('Šablona která nevznikne')

    const cancelBtn = page.getByRole('button', { name: 'Zrušit', exact: true })
    await expect(cancelBtn).toBeVisible({ timeout: 3000 })
    await cancelBtn.click()
    await page.waitForTimeout(500)

    // Modal by měl být zavřený
    await expect(page.getByRole('button', { name: 'Vytvořit', exact: true })).not.toBeVisible()

    const rowCountAfter = await page.locator('table tbody tr').count()
    const cardCountAfter = await page.locator('[data-testid*="template"], .template-card').count()
    expect(rowCountAfter + cardCountAfter).toBe(rowCountBefore + cardCountBefore)
  })
})
