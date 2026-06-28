import { test, expect, assertHealthy } from './_guard/fixtures'

// ============================================================================
// NEGATIVE E2E — runs LOGGED OUT (anon project, no storageState) against LIVE
// prod (https://outreach.auction24.cz).
//
// Every scenario here is inherently side-effect-free: route-guard redirects,
// client-side form validation, and exactly ONE failed Firebase login against a
// NON-existent account (so the real operator account is never hit with a bad
// attempt → no auth/too-many-requests lockout). No mail is sent, no prod row
// is mutated. The _guard kill-switch is still active as defense in depth.
// ============================================================================

// Authenticated surfaces (+ a route) that must bounce a logged-out user.
const PROTECTED = ['/', '/odpovedi', '/kampane', '/kontakty', '/campaigns']

const LOGIN_URL = /\/login(\/|$|\?)/

test.describe('negative — logged-out auth & validation (LIVE prod)', () => {
  for (const path of PROTECTED) {
    test(`protected ${path} redirects to /login when unauthenticated`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(LOGIN_URL, { timeout: 15_000 })
      await expect(page.getByRole('button', { name: /Přihlásit se/ })).toBeVisible()
    })
  }

  test('unknown route falls through the catch-all to /login (logged out)', async ({ page }) => {
    await page.goto('/totalne-neexistujici-cesta-e2e')
    await expect(page).toHaveURL(LOGIN_URL, { timeout: 15_000 })
  })

  test('login page renders the email + password form', async ({ page, cap }) => {
    await page.goto('/login')
    await expect(page.locator('input[type="email"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await expect(page.getByRole('button', { name: /Přihlásit se/ })).toBeVisible()
    assertHealthy(cap)
  })

  test('empty submit is blocked by client validation (no auth call)', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /Přihlásit se/ }).click()
    // Native `required` validation prevents submit → still on /login.
    await expect(page).toHaveURL(LOGIN_URL)
    const emailMissing = await page
      .locator('input[type="email"]')
      .evaluate((el: HTMLInputElement) => el.validity.valueMissing)
    expect(emailMissing).toBe(true)
    // Firebase was never called → no auth-error alert rendered.
    await expect(page.locator('p[role="alert"]')).toHaveCount(0)
  })

  test('malformed email is rejected by client validation', async ({ page }) => {
    await page.goto('/login')
    await page.locator('input[type="email"]').fill('nottanemail')
    await page.locator('input[type="password"]').fill('whatever123')
    await page.getByRole('button', { name: /Přihlásit se/ }).click()
    await expect(page).toHaveURL(LOGIN_URL)
    const invalid = await page
      .locator('input[type="email"]')
      .evaluate((el: HTMLInputElement) => el.validity.typeMismatch || !el.validity.valid)
    expect(invalid).toBe(true)
  })

  test('wrong credentials show the Czech auth error (single attempt, fake account)', async ({ page }) => {
    await page.goto('/login')
    // Deliberately a NON-real account: the real operator login is never hit
    // with a failed attempt.
    await page.locator('input[type="email"]').fill('e2e-negative-noexist@example.com')
    await page.locator('input[type="password"]').fill('ZcelaUrciteSpatneHeslo000!')
    await page.getByRole('button', { name: /Přihlásit se/ }).click()

    const alert = page.locator('p[role="alert"]')
    await expect(alert).toBeVisible({ timeout: 15_000 })
    await expect(alert).toHaveText(/Nesprávn|selhalo|neexist|Příliš mnoho/i)
    // Must NOT have entered the app.
    await expect(page).toHaveURL(LOGIN_URL)
  })
})
