// breadth-audit.mjs — Produkční raketa KROK 1 breadth sweep.
//
// Authenticated Playwright pass over every main operator surface, in dark
// AND light, waiting for REAL data (networkidle + content signal, never a
// fixed timeout — fixed waits fabricate phantom "0"). Captures console
// errors + 4xx/5xx network responses (operator-strict: only the documented
// React-DevTools / favicon / sourcemap / CSS-preload exceptions are ignored).
//
// Output: a JSON verdict to stdout + PNG screenshots under reports/breadth/.
// Not a test — a diagnostic the loop runs before claiming "nic actionable".
//
// Run: node scripts/breadth-audit.mjs   (needs Vite :18175 + BFF :18001 up)

import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = 'http://localhost:18175'
const OUT = 'reports/breadth'
mkdirSync(OUT, { recursive: true })

// 7 main surfaces from the playbook breadth list. mustSee = a stable text
// signal that proves real data rendered (not a skeleton / false-empty).
const SURFACES = [
  { key: 'odpovedi', path: '/replies', mustSee: 'Inbox' },
  { key: 'kampane', path: '/campaigns', mustSee: 'Kampaně' },
  { key: 'schranky', path: '/mailboxes', mustSee: 'Schránky' },
  { key: 'firmy', path: '/companies', mustSee: 'Firmy' },
  { key: 'vozidla', path: '/vehicles', mustSee: 'Vozidla' },
  { key: 'kontakty', path: '/contacts', mustSee: 'Kontakty' },
  { key: 'crm', path: '/crm/clients', mustSee: 'CRM' },
]

// Operator-strict ignore list (feedback_smoke_gate_operator_strict): ONLY
// these classes are noise. Everything else is a real finding.
const IGNORE = [
  /react devtools/i,
  /favicon/i,
  /\.map(\?|$)/i, // sourcemap
  /Download the React DevTools/i,
]
const isNoise = (s) => IGNORE.some((re) => re.test(s))

// Loading-skeleton signatures (shared <ListSkeleton> + the Replies table
// variant + any aria-busy spinner). Waiting for these to DETACH is how we
// wait for real DATA — NOT a fixed timeout, which fabricates phantom "0" on
// heavy lists (store loadAll is 3-6s). Per the playbook KROK 1 rule.
const SKELETON_SEL =
  '[data-testid="list-skeleton"], [data-testid="replies-table-skeleton"], [aria-busy="true"]'

async function settle(page, mustSee) {
  // Do NOT use 'networkidle' — SSE surfaces (/replies) never idle and would
  // burn the full 30s/page. Wait for 'load', the route's header signal, then
  // for every loading skeleton to disappear (= the list painted real data).
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {})
  if (mustSee) {
    await page.getByText(mustSee, { exact: false }).first()
      .waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {})
  }
  // Wait until no skeleton remains attached (bounded). If a surface has no
  // skeleton this resolves immediately; if data never loads it falls through
  // after the cap and the screenshot will honestly show the stuck state.
  await page.waitForFunction(
    (sel) => document.querySelectorAll(sel).length === 0,
    SKELETON_SEL,
    { timeout: 12_000 },
  ).catch(() => {})
  // Some tables (Vozidla) show a plain "Načítám…" text instead of a skeleton
  // testid — wait for that to clear too, else the screenshot captures a
  // mid-load phantom-empty. Bounded; honest about a genuine stuck state.
  await page.waitForFunction(
    () => !/Načítám/.test(document.body.innerText || ''),
    { timeout: 12_000 },
  ).catch(() => {})
}

const results = []

const browser = await chromium.launch()
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({
    baseURL: BASE,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    viewport: { width: 1440, height: 900 },
  })
  await ctx.addCookies([
    { name: 'operator_id', value: 'operator', domain: 'localhost', path: '/', sameSite: 'Lax' },
  ])
  // also force the app's own theme toggle via localStorage if it uses one
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('theme', t) } catch {}
  }, theme)

  for (const s of SURFACES) {
    const page = await ctx.newPage()
    const consoleErrors = []
    const httpErrors = []
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error' && !isNoise(m.text())) consoleErrors.push(m.text())
    })
    page.on('response', (r) => {
      const st = r.status()
      if (st >= 400 && !isNoise(r.url())) httpErrors.push(`${st} ${r.url()}`)
    })

    let sawSignal = false
    try {
      await page.goto(s.path, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await settle(page, s.mustSee)
      sawSignal = await page
        .getByText(s.mustSee, { exact: false })
        .first()
        .isVisible({ timeout: 8_000 })
        .catch(() => false)
    } catch (e) {
      consoleErrors.push(`nav-error: ${e.message}`)
    }
    const shot = `${OUT}/${s.key}-${theme}.png`
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {})
    results.push({
      surface: s.key,
      theme,
      path: s.path,
      sawSignal,
      httpErrors: [...new Set(httpErrors)],
      consoleErrors: [...new Set(consoleErrors)],
      shot,
    })
    await page.close()
  }
  await ctx.close()
}
await browser.close()

// Verdict
const bad = results.filter(
  (r) => !r.sawSignal || r.httpErrors.length || r.consoleErrors.length,
)
console.log(JSON.stringify({ ok: bad.length === 0, total: results.length, problems: bad, all: results }, null, 2))
process.exit(bad.length ? 1 : 0)
