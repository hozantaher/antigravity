import { test, expect } from '@playwright/test'
import fs from 'node:fs'

// chaos-monkey — seeded, reproducible random operator behaviour across the
// surface (#1586 / "monkey testing" directive). already has iter62-monkey;
// the generation had NO fuzz coverage, so the R2 "nonsensical surface" class
// (null/undefined renders, raw enums, crashes-on-empty) could regress unseen.
// This sweeps all 8 routes, clicking/typing/navigating, and fails on a crash.
//
// Crash = pageerror OR 5xx OR white-screen OR a non-filtered console error.
// NOT a crash: 429 (rate-limiter backpressure under superhuman click rate) and
// transient resource 4xx (the #1298 parallel-load 404 race) — those are logged
// WITH their URL into separate buckets so they're visible + debuggable, never
// hidden, but don't make this a flaky always-red test. Genuine JS errors stay
// strict. Deterministic via MONKEY_SEED (seeded LCG, no Math.random in app scope).

const MONKEY_SEED = Number(process.env.V2_MONKEY_SEED || 42)
const MONKEY_DURATION_MS = Number(process.env.V2_MONKEY_DURATION_MS || 90_000)
const MONKEY_CRASH_THRESHOLD = 0
const MIN_ACTIONS_SANITY = 30
const ACTION_GAP_MS = 200
const TYPE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 áéíóúčďěňřšťůžý@.,?'
const ROUTES = [
  '/', '/odpovedi', '/vozidla', '/firmy', '/kontakty',
  '/crm', '/kampane', '/kvalita', '/hledat',
  '/odpovedi',  // headline page (#1586) — fuzz it too
]
const CONSOLE_FILTER = [/React DevTools/i, /favicon/i, /sourcemap/i, /\.map\b/i, /Download the React/i, /preload/i]

function lcg(seed: number) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff }
}

test(`chaos monkey (seed ${MONKEY_SEED})`, async ({ page }) => {
  test.setTimeout(MONKEY_DURATION_MS + 60_000)
  const rand = lcg(MONKEY_SEED)
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)]
  const crashes: any[] = []
  const throttles: any[] = []  // 429 backpressure — expected, handled
  const soft4xx: any[] = []    // transient resource 4xx (#1298) — logged, not fatal

  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (CONSOLE_FILTER.some((re) => re.test(t))) return
    if (/\b429\b|Too Many Requests/i.test(t)) { throttles.push({ text: t.slice(0, 120) }); return }
    // The browser logs "Failed to load resource: 404" without a URL; the response
    // listener below captures the URL. Treat the bare console line as soft so we
    // don't double-count — the URL'd entry in soft4xx is the useful record.
    if (/Failed to load resource.*\b4\d\d\b/i.test(t)) { soft4xx.push({ kind: 'console', text: t.slice(0, 120) }); return }
    crashes.push({ kind: 'console', text: t.slice(0, 200) })
  })
  page.on('pageerror', (e) => crashes.push({ kind: 'pageerror', text: String(e?.message || e).slice(0, 200) }))
  page.on('response', (r) => {
    const s = r.status()
    if (s >= 500) crashes.push({ kind: 'http5xx', text: `${s} ${r.url().slice(0, 140)}` })
    else if (s >= 400 && s !== 429) soft4xx.push({ kind: 'http', text: `${s} ${r.url().slice(0, 140)}` })
  })

  await page.goto(ROUTES[0], { waitUntil: 'domcontentloaded' })
  const deadline = Date.now() + MONKEY_DURATION_MS
  let actions = 0
  while (Date.now() < deadline) {
    const action = pick(['click', 'type', 'key', 'nav', 'scroll'])
    try {
      if (action === 'nav') {
        await page.goto(pick(ROUTES), { waitUntil: 'domcontentloaded', timeout: 10_000 })
      } else if (action === 'click') {
        const els = await page.locator('button:visible, a:visible, [role=button]:visible, tr:visible, [data-testid=app-reply-row]:visible').all()
        if (els.length) await pick(els).click({ timeout: 1500, force: true }).catch(() => {})
      } else if (action === 'type') {
        const inputs = await page.locator('input:visible, textarea:visible').all()
        if (inputs.length) {
          const s = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => TYPE_ALPHABET[Math.floor(rand() * TYPE_ALPHABET.length)]).join('')
          await pick(inputs).fill(s, { timeout: 1500 }).catch(() => {})
        }
      } else if (action === 'key') {
        await page.keyboard.press(pick(['Escape', 'Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'j', 'k', 'r', 'e', '/'])).catch(() => {})
      } else {
        await page.mouse.wheel(0, (rand() - 0.5) * 2000).catch(() => {})
      }
      actions++
      const bodyLen = await page.locator('body').innerText().then((t) => t.length).catch(() => 1)
      if (bodyLen < 1) crashes.push({ kind: 'whitescreen', text: `at action ${actions} ${page.url()}` })
    } catch { /* individual action failure isn't a crash unless it surfaced above */ }
    await page.waitForTimeout(ACTION_GAP_MS)
  }

  const out = { seed: MONKEY_SEED, actions, crashCount: crashes.length, throttleCount: throttles.length, soft4xxCount: soft4xx.length, crashes: crashes.slice(0, 30), soft4xx: soft4xx.slice(0, 30) }
  fs.writeFileSync(`/tmp/app-monkey-${MONKEY_SEED}.json`, JSON.stringify(out, null, 2))
  console.log(`[app-monkey ${MONKEY_SEED}] actions=${actions} crashes=${crashes.length} throttles=${throttles.length} soft4xx=${soft4xx.length}`)
  if (crashes.length) console.log(JSON.stringify(crashes.slice(0, 8), null, 2))
  if (soft4xx.length) console.log(`soft4xx (investigate, not fatal):\n${JSON.stringify(soft4xx.slice(0, 8), null, 2)}`)

  expect(actions, 'walker should execute a meaningful number of actions').toBeGreaterThan(MIN_ACTIONS_SANITY)
  expect(crashes.length, `crashes: ${JSON.stringify(crashes.slice(0, 10))}`).toBeLessThanOrEqual(MONKEY_CRASH_THRESHOLD)
})
