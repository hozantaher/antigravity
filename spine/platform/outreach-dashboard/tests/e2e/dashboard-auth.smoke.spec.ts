// dashboard-auth.smoke.spec.ts — AW-F1 (2026-05-20)
//
// Playwright smoke for the dashboard Basic Auth gate (HARD rule
// feedback_playwright_smoke_required T0). The dashboard normally runs
// with DASHBOARD_AUTH_ENABLED=false (default), so this spec is gated
// on the env actually being enabled. When the operator hasn't enabled
// auth, the spec skips with a clear message rather than failing — the
// gate behavior is verified in detail by the unit + contract tests.
//
// When auth IS enabled in the running dev server, the spec verifies:
//   1. Navigating without credentials → 401 (Basic challenge).
//   2. Navigating with wrong credentials → 401.
//   3. Navigating with the correct credentials → page renders, no
//      console errors (per feedback_smoke_gate_operator_strict T0).
//
// The credentials used here are the operator's local DASHBOARD_USER +
// DASHBOARD_PASS env (NOT _HASH — Playwright needs plaintext to drive
// the browser). Operators wanting to run this spec set DASHBOARD_PASS
// in a local-only env file (never committed).

import { test, expect } from '@playwright/test'

const ENABLED = process.env.DASHBOARD_AUTH_ENABLED === 'true'
const USER = process.env.DASHBOARD_USER || ''
const PASS = process.env.DASHBOARD_PASS || ''

test.describe('AW-F1 Dashboard Basic Auth (smoke)', () => {
  test.skip(!ENABLED, 'Dashboard auth disabled — skipping. Set DASHBOARD_AUTH_ENABLED=true + DASHBOARD_USER + DASHBOARD_PASS to run.')
  test.skip(ENABLED && (!USER || !PASS), 'DASHBOARD_USER or DASHBOARD_PASS not in env for the test runner — skipping.')

  test('navigates without credentials → Basic Auth challenge / blocks page render', async ({ browser }) => {
    // Fresh context — no stored credentials.
    const ctx = await browser.newContext({})
    const page = await ctx.newPage()

    // Use page.request so we can observe the raw HTTP status without
    // the browser's built-in Basic Auth dialog interfering.
    const resp = await page.request.get('/', { failOnStatusCode: false })
    expect(resp.status(), 'expected 401 on unauthenticated GET /').toBe(401)
    const wwwAuth = resp.headers()['www-authenticate'] || ''
    expect(wwwAuth.toLowerCase()).toContain('basic')

    await ctx.close()
  })

  test('navigates with WRONG credentials → 401', async ({ browser }) => {
    const ctx = await browser.newContext({
      httpCredentials: { username: USER, password: 'definitely-not-the-password' },
    })
    const page = await ctx.newPage()
    const resp = await page.request.get('/', { failOnStatusCode: false })
    expect(resp.status()).toBe(401)
    await ctx.close()
  })

  test('navigates with CORRECT credentials → page renders, no console errors', async ({ browser }) => {
    const ctx = await browser.newContext({
      httpCredentials: { username: USER, password: PASS },
    })
    const page = await ctx.newPage()

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') {
        const txt = m.text()
        // Filter exceptions per feedback_smoke_gate_operator_strict T0:
        // React DevTools / favicon / sourcemap / CSS-preload-no-status
        if (/React DevTools|favicon|sourcemap|preload.*no-status/i.test(txt)) return
        errors.push(`console.error: ${txt}`)
      }
    })

    await page.goto('/')
    // Visible headline / heading — any h1 on the landing page proves
    // the SPA bootstrapped past the auth gate.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 })

    expect(errors, `Unexpected console errors after auth:\n${errors.join('\n')}`).toEqual([])
    await ctx.close()
  })
})
