import { test as base, expect } from '@playwright/test'
import { createLedger, installSafetyGuard, type SafetyLedger } from './safety-guard'

type Captured = {
  console: string[] // console.error messages
  pageerror: string[] // uncaught exceptions
  apiErrors: string[] // 4xx/5xx responses on the app's own /api/* GETs
}

type Fixtures = {
  ledger: SafetyLedger
  cap: Captured
  _guard: void
}

// Benign console noise on a live prod app we don't want to fail on.
const CONSOLE_NOISE = [
  /favicon/i,
  /sentry/i,
  /Download the React DevTools/i,
  /sourcemap|source map/i,
  /\[vite\]/i,
  // Errors caused by OUR OWN guard aborting a dangerous request:
  /net::ERR_FAILED/i,
  /Failed to fetch/i,
  /Failed to load resource/i,
]

function filterNoise(xs: string[]): string[] {
  return xs.filter((x) => !CONSOLE_NOISE.some((re) => re.test(x)))
}

export const test = base.extend<Fixtures>({
  ledger: async ({}, use, testInfo) => {
    const led = createLedger()
    await use(led)
    await testInfo.attach('safety-ledger', { body: led.summary(), contentType: 'text/plain' })
    // Hard invariant: NO mutation was ever allowed through to the BFF.
    const leaked = led.allowedMutations()
    if (leaked.length) {
      throw new Error(`SAFETY VIOLATION — mutation(s) reached the network:\n${leaked.map((e) => `${e.method} ${e.url}`).join('\n')}`)
    }
  },

  cap: async ({}, use, testInfo) => {
    const c: Captured = { console: [], pageerror: [], apiErrors: [] }
    await use(c)
    // Surface (without failing) console + 4xx noise for post-run inspection.
    const body = [
      `console.error (${c.console.length}): ${JSON.stringify(filterNoise(c.console), null, 2)}`,
      `pageerror (${c.pageerror.length}): ${JSON.stringify(c.pageerror, null, 2)}`,
      `api 4xx/5xx (${c.apiErrors.length}): ${JSON.stringify(c.apiErrors, null, 2)}`,
    ].join('\n')
    await testInfo.attach('page-diagnostics', { body, contentType: 'text/plain' })
  },

  _guard: [
    async ({ page, ledger, cap, baseURL }, use) => {
      await installSafetyGuard(page, ledger)
      page.on('console', (m) => {
        if (m.type() === 'error') cap.console.push(m.text())
      })
      page.on('pageerror', (e) => cap.pageerror.push(`${e.name}: ${e.message}`))
      page.on('response', (r) => {
        const s = r.status()
        const url = r.url()
        if (s >= 400 && /\/api\//.test(url) && (!baseURL || url.startsWith(baseURL))) {
          cap.apiErrors.push(`${s} ${r.request().method()} ${url.replace(baseURL || '', '')}`)
        }
      })
      await use()
    },
    { auto: true },
  ],
})

export { expect }

/**
 * Fail only on unambiguous breakage: uncaught JS exceptions or server 5xx on a
 * GET. 4xx + console noise are attached to the report (see `cap` teardown) but
 * don't fail — a live prod app has benign 4xx (missing optional resources) and
 * 3rd-party console chatter we don't control.
 */
export function assertHealthy(cap: Captured): void {
  const pe = filterNoise(cap.pageerror)
  const fivexx = cap.apiErrors.filter((e) => /^5\d\d /.test(e))
  const problems: string[] = []
  if (pe.length) problems.push(`Uncaught exceptions:\n  ${pe.join('\n  ')}`)
  if (fivexx.length) problems.push(`Server 5xx on GET:\n  ${fivexx.join('\n  ')}`)
  if (problems.length) throw new Error(problems.join('\n'))
}
