import { test, expect } from '@playwright/test'

// F2c + F3 — sidebar primary quad. "Přehled" was removed; `/` redirects to
// /replies?handled=false. The 4 primary nav entries are the operator's
// daily landing surfaces. "Šablony" and "Kontakty" live in the Setup
// section, which is always expanded.
const NAV_ITEMS = [
  { label: 'Odpovědi', href: '/replies',   topbarTitle: 'Odpovědi'   },
  { label: 'Kampaně',  href: '/campaigns', topbarTitle: 'Kampaně'    },
  { label: 'Schránky', href: '/mailboxes', topbarTitle: 'Schránky'   },
  { label: 'Firmy',    href: '/companies', topbarTitle: 'Firmy'      },
  { label: 'Šablony',  href: '/templates', topbarTitle: 'Šablony'    },
  { label: 'Kontakty', href: '/contacts',  topbarTitle: 'Kontakty'   },
] as const

test.describe('Navigace — sidebar nav', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.waitForTimeout(1500)
  })

  test('root / redirects to /replies?handled=false', async ({ page }) => {
    // F2c — Dashboard removed; index route navigates to the daily inbox.
    await expect(page).toHaveURL(/\/replies\?handled=false$/)
    await expect(page.locator('.topbar-title')).toHaveText('Odpovědi')
  })

  test('sidebar je viditelný a obsahuje primární nav položky', async ({ page }) => {
    const sidebar = page.locator('.sidebar')
    await expect(sidebar).toBeVisible()

    for (const item of NAV_ITEMS) {
      await expect(
        page.locator('.nav-item').filter({ hasText: item.label })
      ).toBeVisible()
    }
  })

  for (const item of NAV_ITEMS) {
    test(`kliknutí na "${item.label}" přejde na ${item.href}`, async ({ page }) => {
      await page.locator('.nav-item').filter({ hasText: item.label }).click()
      await page.waitForTimeout(1000)

      // Match the URL path; ignore search params (e.g. /replies?handled=false
      // is fine here — we only assert path).
      await expect(page).toHaveURL(new RegExp(`${item.href}(\\?|$)`))

      const topbarTitle = page.locator('.topbar-title')
      await expect(topbarTitle).toBeVisible()
      await expect(topbarTitle).toHaveText(item.topbarTitle)
    })
  }

  test('aktivní nav položka má třídu "active" po redirectu', async ({ page }) => {
    // Po redirectu z / na /replies?handled=false by "Odpovědi" měla být aktivní.
    const odpovediLink = page.locator('.nav-item').filter({ hasText: 'Odpovědi' })
    await expect(odpovediLink).toHaveClass(/active/)
  })

  test('navigace Firmy → Kampaně → zpět na Odpovědi', async ({ page }) => {
    await page.locator('.nav-item').filter({ hasText: 'Firmy' }).click()
    await page.waitForTimeout(800)
    await expect(page).toHaveURL(/\/companies/)
    await expect(page.locator('.topbar-title')).toHaveText('Firmy')

    await page.locator('.nav-item').filter({ hasText: 'Kampaně' }).click()
    await page.waitForTimeout(800)
    await expect(page).toHaveURL(/\/campaigns/)
    await expect(page.locator('.topbar-title')).toHaveText('Kampaně')

    await page.locator('.nav-item').filter({ hasText: 'Odpovědi' }).click()
    await page.waitForTimeout(800)
    await expect(page).toHaveURL(/\/replies/)
    await expect(page.locator('.topbar-title')).toHaveText('Odpovědi')
  })

  test('zpětná navigace prohlížeče funguje', async ({ page }) => {
    await page.locator('.nav-item').filter({ hasText: 'Firmy' }).click()
    await page.waitForTimeout(800)
    await expect(page).toHaveURL(/\/companies/)

    await page.locator('.nav-item').filter({ hasText: 'Kampaně' }).click()
    await page.waitForTimeout(800)
    await expect(page).toHaveURL(/\/campaigns/)

    await page.goBack()
    await page.waitForTimeout(800)
    await expect(page).toHaveURL(/\/companies/)
    await expect(page.locator('.topbar-title')).toHaveText('Firmy')
  })

  test('navigace na Schránky zobrazí stránku Schránky', async ({ page }) => {
    await page.locator('.nav-item').filter({ hasText: 'Schránky' }).click()
    await page.waitForTimeout(1500)

    await expect(page).toHaveURL(/\/mailboxes/)
    await expect(page.locator('.topbar-title')).toHaveText('Schránky')

    const hasTable = await page.locator('table').count() > 0
    const hasEmptyState = await page.locator('text=Žádné schránky').count() > 0
    expect(hasTable || hasEmptyState).toBe(true)
  })

  test('navigace na Kampaně zobrazí stránku Kampaně', async ({ page }) => {
    await page.locator('.nav-item').filter({ hasText: 'Kampaně' }).click()
    await page.waitForTimeout(1500)

    await expect(page).toHaveURL(/\/campaigns/)
    await expect(page.locator('.topbar-title')).toHaveText('Kampaně')

    // F2b — page-head heading was replaced by stat-strip group landmark;
    // either a real campaign row, the empty placeholder, or the stat strip
    // confirms the page rendered.
    const hasStatStrip = await page.locator('.page-stat-strip').count() > 0
    // Y8 — empty-state copy revised to "Žádná kampaň. Klikni Vytvořit kampaň."
    const hasEmptyState = await page.locator('text=/Žádná kampaň|Zatím žádné kampaně/').count() > 0
    expect(hasStatStrip || hasEmptyState).toBe(true)
  })

  test('navigace na Šablony zobrazí stránku Šablony', async ({ page }) => {
    await page.locator('.nav-item').filter({ hasText: 'Šablony' }).click()
    await page.waitForTimeout(1500)

    await expect(page).toHaveURL(/\/templates/)
    await expect(page.locator('.topbar-title')).toHaveText('Šablony')

    // F6 — bare <h2>Šablony</h2> replaced by stat strip; empty state still fires
    // when there are no templates.
    const hasStatStrip = await page.locator('.page-stat-strip').count() > 0
    const hasEmptyState = await page.locator('text=Žádné šablony').count() > 0
    expect(hasStatStrip || hasEmptyState).toBe(true)
  })

  test('navigace na Firmy zobrazí stránku Firmy', async ({ page }) => {
    await page.locator('.nav-item').filter({ hasText: 'Firmy' }).click()
    await page.waitForTimeout(1500)

    await expect(page).toHaveURL(/\/companies/)
    await expect(page.locator('.topbar-title')).toHaveText('Firmy')
    await expect(page.locator('.page-stat-strip')).toBeVisible()
  })

  test('neznámá URL přesměruje na root, který následně přesměruje na /replies', async ({ page }) => {
    await page.goto('/neexistujici-stranka')
    await page.waitForTimeout(1000)
    // wildcard route → "/" → index navigate → /replies?handled=false
    await expect(page).toHaveURL(/\/replies/)
    await expect(page.locator('.topbar-title')).toHaveText('Odpovědi')
  })
})
