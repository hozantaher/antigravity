import { test as setup, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { createLedger, installSafetyGuard } from './_guard/safety-guard'

// One real Firebase login, persisted for the positive suite to reuse. Keeps us
// to a SINGLE signInWithEmailAndPassword call (Firebase rate-limits attempts).
const AUTH_FILE = 'tests/e2e-prod/.auth/state.json'

setup('authenticate against prod (Firebase email+password)', async ({ page }) => {
  const email = process.env.PROD_E2E_USER
  const password = process.env.PROD_E2E_PASS
  if (!email || !password) {
    throw new Error('Set PROD_E2E_USER and PROD_E2E_PASS env vars before running prod E2E.')
  }

  // Defense in depth: the kill-switch is active even during login.
  const ledger = createLedger()
  await installSafetyGuard(page, ledger)

  await page.goto('/login')
  const submitBtn = page.getByRole('button', { name: /Přihlásit se/ })
  await expect(submitBtn).toBeVisible()

  await page.locator('input[type="email"]').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await submitBtn.click()

  // Success path: SDK signs in → app navigates to / → Home renders.
  await page.waitForURL(/\/(\/|$)/, { timeout: 20_000 })
  await expect(page.getByTestId('app-home')).toBeVisible({ timeout: 20_000 })

  // Firebase auth state lives in IndexedDB → must capture it too (PW ≥1.51).
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
  await page.context().storageState({ path: AUTH_FILE, indexedDB: true })

  // Login itself must not have triggered any dangerous request.
  expect(ledger.blocked(), `\n${ledger.summary()}`).toHaveLength(0)
})
