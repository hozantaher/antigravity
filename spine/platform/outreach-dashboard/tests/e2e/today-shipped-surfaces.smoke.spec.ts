// today-shipped-surfaces.smoke.spec.ts
//
// Cumulative surface smoke — post dashboard-unification (2026-06-24). The
// operator dashboard is now a single shell (AppShell); every surface is a
// / route. This pack is the route-registration + boot guard across ALL
// surfaces:
//   - Route registration regressions (a / path 404s / falls to catch-all)
//   - Shell boot / error-boundary firing (app-shell never mounts)
//   - Uncaught JS on a surface (pageerror)
// Per-surface DEPTH (controls, data, interactions) lives in the dedicated
// app-*.smoke.spec.ts files. Network 4xx/5xx is the backend's domain (covered by
// synthetic monitoring + the per-surface specs); the prod DB intermittently
// 500s heavy scans, so resource-load console noise is not gated here. Every
// OTHER console.error + any pageerror still fails the surface.

import { test, expect, Page } from '@playwright/test'

test.describe.configure({ mode: 'parallel' })

// One row per operator-facing surface (mirrors AppShell nav + the campaign
// editor + segment builder). The shell renders <div data-testid="app-shell"> for
// every route under /, so its visibility is the universal "surface mounted".
const ROUTES = [
  '/',                  // Přehled
  '/odpovedi',         // Odpovědi (reply triage)
  '/vozidla',          // Vozidla
  '/kampane',          // Kampaně
  '/kampane/nova',     // Nová kampaň (create)
  '/firmy',            // Firmy
  '/kontakty',         // Kontakty
  '/crm',              // CRM
  '/cile',             // Top cíle
  '/segmenty',         // Segmenty
  '/segmenty/novy',    // Nový segment (builder)
  '/sablony',          // Šablony
  '/analytika',        // Analytika
  '/schranky',         // Schránky (mailboxes)
  '/kvalita',          // Kvalita dat
  '/upozorneni',       // Upozornění
  '/dedup',            // Duplicity
  '/anonymita',        // Anonymita
  '/nastaveni',        // Nastavení
  '/hledat',           // Hledat
]

async function ensureLoggedIn(page: Page) {
  // operator_id cookie satisfies the BFF auth middleware AND the dev-only
  // Firebase auth seam in authStore.js (import.meta.env.DEV + operator_id cookie).
  await page.context().addCookies([{
    name: 'operator_id', value: 'operator', domain: 'localhost',
    path: '/', httpOnly: false, sameSite: 'Lax',
  }])
}

for (const path of ROUTES) {
  test(`surface mounts: ${path}`, async ({ page }) => {
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      // Network resource failures are the backend's domain (degraded prod DB
      // intermittently 500s heavy scans) — not a surface-mount regression.
      if (/Failed to load resource/i.test(t)) return
      errs.push(`console.error: ${t}`)
    })
    await ensureLoggedIn(page)
    await page.goto(path)
    // shell mounted = route registered + no boot-time error boundary fired.
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 })
    expect(errs, errs.join('\n')).toHaveLength(0)
  })
}
