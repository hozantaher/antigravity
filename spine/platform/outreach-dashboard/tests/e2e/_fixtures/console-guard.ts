import { test as base, expect } from '@playwright/test'

type Errs = { console: string[]; pageerror: string[]; failedRequests: string[] }

// Use this fixture instead of @playwright/test's `test` to fail on console
// errors / unhandled exceptions / failed network requests on the page.
export const test = base.extend<{ errs: Errs }>({
  errs: async ({ page }, use) => {
    const errs: Errs = { console: [], pageerror: [], failedRequests: [] }
    page.on('console', m => {
      if (m.type() === 'error') errs.console.push(m.text())
    })
    page.on('pageerror', e => errs.pageerror.push(`${e.name}: ${e.message}`))
    page.on('requestfailed', r => {
      const url = r.url()
      if (url.includes('localhost')) errs.failedRequests.push(`${r.method()} ${url} → ${r.failure()?.errorText ?? ''}`)
    })
    await use(errs)
  },
})

export { expect }

// Helper: assert no console errors after the test body has run.
export function assertClean(errs: Errs) {
  // Filter out a few expected/benign noises (favicon, etc.).
  const noise = [/favicon/i, /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/]
  const filt = (xs: string[]) => xs.filter(x => !noise.some(re => re.test(x)))
  const c = filt(errs.console)
  const p = filt(errs.pageerror)
  const r = filt(errs.failedRequests)
  if (c.length || p.length || r.length) {
    throw new Error(
      `Console errors:\n  console: ${JSON.stringify(c)}\n  pageerror: ${JSON.stringify(p)}\n  failedReq: ${JSON.stringify(r)}`,
    )
  }
}
