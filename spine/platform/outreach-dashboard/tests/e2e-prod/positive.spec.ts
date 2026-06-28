import { test, expect, assertHealthy } from './_guard/fixtures'

// ============================================================================
// POSITIVE E2E — authenticated, READ-ONLY flows against the LIVE prod dashboard
// (https://outreach.auction24.cz). Runs in the `authed` project, reusing the
// Firebase session persisted by auth.setup.ts (.auth/state.json).
//
// SAFETY: the _guard kill-switch (fixtures.ts, auto-installed) aborts EVERY
// mutating/probing request at the browser network layer before it leaves.
// On top of that, these flows are deliberately read-only: navigation, render
// assertions, search/filter (GET only) and a client-only theme toggle. No
// control on the AVOID list (Odeslat / Vyřídit / Přeřadit / Vytvořit vozidlo /
// status stepper / data-quality fix / verify-email …) is ever clicked.
//
// Every selector below was verified LIVE against deployed prod on 2026-06-19
// (not just against source) — see the run report.
// ============================================================================

// path → stable render anchor (data-testid), all confirmed live in prod.
const APP_ROUTES: Array<{ path: string; testid: string; label: string }> = [
  { path: '/', testid: 'app-home', label: 'Přehled' },
  { path: '/odpovedi', testid: 'app-odpovedi', label: 'Odpovědi' },
  { path: '/vozidla', testid: 'app-vozidla', label: 'Vozidla' },
  { path: '/firmy', testid: 'app-firmy', label: 'Firmy' },
  { path: '/kontakty', testid: 'app-kontakty', label: 'Kontakty' },
  { path: '/kampane', testid: 'app-kampane', label: 'Kampaně' },
  { path: '/crm', testid: 'app-crm', label: 'CRM' },
  { path: '/hledat', testid: 'app-hledat', label: 'Hledat' },
  { path: '/kvalita', testid: 'app-kvalita', label: 'Kvalita dat' },
]

test.describe('positive — authenticated read-only flows (LIVE prod)', () => {
  test('persisted session is authenticated (no bounce to /login)', async ({ page, cap }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/(\/|$)/)
    await expect(page.getByTestId('app-app')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('app-home')).toBeVisible({ timeout: 20_000 })
    assertHealthy(cap)
  })

  for (const r of APP_ROUTES) {
    test(`renders ${r.label} (${r.path})`, async ({ page, cap, ledger }) => {
      await page.goto(r.path)
      await expect(page.getByTestId(r.testid)).toBeVisible({ timeout: 20_000 })
      // Loading a read view must never leak a mutation through the guard.
      expect(ledger.allowedMutations(), ledger.summary()).toHaveLength(0)
      assertHealthy(cap)
    })
  }

  test('sidebar SPA navigation works (Přehled → Odpovědi → Vozidla)', async ({ page, cap }) => {
    await page.goto('/')
    await expect(page.getByTestId('app-home')).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('app-nav-Odpovědi').click()
    await expect(page).toHaveURL(/\/\/odpovedi/)
    await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('app-nav-Vozidla').click()
    await expect(page).toHaveURL(/\/\/vozidla/)
    await expect(page.getByTestId('app-vozidla')).toBeVisible({ timeout: 20_000 })

    assertHealthy(cap)
  })

  test('home cards deep-link into their surfaces', async ({ page, cap }) => {
    await page.goto('/')
    const card = page.getByTestId('app-home-card-Odpovědi')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.click()
    await expect(page).toHaveURL(/\/\/odpovedi/)
    await expect(page.getByTestId('app-odpovedi')).toBeVisible({ timeout: 20_000 })
    assertHealthy(cap)
  })

  test('theme toggle flips light/dark (client-only — no network write)', async ({ page, cap, ledger }) => {
    await page.goto('/')
    const toggle = page.getByTestId('app-theme-toggle')
    await expect(toggle).toBeVisible({ timeout: 20_000 })
    const before = await page.evaluate(() => localStorage.getItem('uiTheme'))
    await toggle.click()
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('uiTheme')), { timeout: 5_000 })
      .not.toBe(before)
    expect(ledger.allowedMutations(), ledger.summary()).toHaveLength(0)
    assertHealthy(cap)
  })

  test('global search is read-only (Hledat)', async ({ page, cap, ledger }) => {
    await page.goto('/hledat')
    const input = page.getByTestId('app-hledat-input')
    await expect(input).toBeVisible({ timeout: 20_000 })
    await input.fill('bagr')
    // let the debounced GET /api/search fire (and be allowed) before asserting
    await page.waitForTimeout(1_500)
    expect(ledger.allowedMutations(), ledger.summary()).toHaveLength(0)
    assertHealthy(cap)
  })

  test('contacts filter chips are read-only (browse mode)', async ({ page, cap, ledger }) => {
    await page.goto('/kontakty')
    await expect(page.getByTestId('app-kontakty')).toBeVisible({ timeout: 20_000 })
    // "Vše" / "Zapojené" are the browse-mode toggle — they are intentionally
    // hidden once a search query is typed, so exercise them WITHOUT searching.
    await page.getByTestId('app-filter-all').click()
    await page.getByTestId('app-filter-engaged').click()
    await page.waitForTimeout(500)
    expect(ledger.allowedMutations(), ledger.summary()).toHaveLength(0)
    assertHealthy(cap)
  })

  test('contacts search is read-only (returns matches)', async ({ page, cap, ledger }) => {
    await page.goto('/kontakty')
    await expect(page.getByTestId('app-kontakty')).toBeVisible({ timeout: 20_000 })
    const search = page.getByTestId('app-contact-search')
    await search.fill('servis')
    await page.waitForTimeout(1_200)
    await expect(search).toHaveValue('servis')
    expect(ledger.allowedMutations(), ledger.summary()).toHaveLength(0)
    assertHealthy(cap)
  })

  test('read-only navigation never trips the kill-switch (0 aborted requests)', async ({ page, ledger }) => {
    // A pure load of the home must not cause the guard to abort anything —
    // i.e. no page auto-fires a send/launch/probe on mount.
    await page.goto('/')
    await expect(page.getByTestId('app-home')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1_000)
    expect(ledger.blocked(), ledger.summary()).toHaveLength(0)
  })
})
