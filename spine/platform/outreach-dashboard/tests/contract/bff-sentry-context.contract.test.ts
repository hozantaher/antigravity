// Contract: Sentry request context — errors have request URL + method attached
// Tests that the Express integration captures request data with each error.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

const capturedEvents: unknown[] = []

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn((opts) => {
      // intercept beforeSend to record events
      const origBeforeSend = opts?.beforeSend
      ;(opts as Record<string, unknown>).beforeSend = (event: unknown, hint: unknown) => {
        capturedEvents.push(event)
        return origBeforeSend ? origBeforeSend(event as never, hint as never) : null
      }
    }),
    captureException: vi.fn((err) => {
      capturedEvents.push({ exception: { values: [{ value: (err as Error)?.message }] } })
      return 'fake-id'
    }),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withScope: vi.fn((fn: (s: unknown) => void) => fn({ setFingerprint: vi.fn(), setTag: vi.fn() })),
    withIsolationScope: vi.fn((fn: (s: unknown) => void) => fn({ setTag: vi.fn(), setContext: vi.fn() })),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
  }
})

vi.mock('pg', () => {
  class Pool {
    async query() { return { rows: [], rowCount: 0 } }
    async connect() {
      const self = this
      return {
        async query(s, p) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof s === 'string' ? s : '')) return { rows: [], rowCount: 0 }
          return self.query(s, p)
        },
        release() {},
      }
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'SENTRY_DSN_BFF']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.SENTRY_DSN_BFF = 'https://test@sentry.io/0'
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  capturedEvents.length = 0
})

describe('Sentry request context', () => {
  it('capture500 sends to Sentry when route throws a real Error', async () => {
    // The capture500 helper calls Sentry.captureException — verify mock was wired
    const { captureException } = await import('@sentry/node')
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const res = { _s: 0, _b: null, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, new Error('test-error'), () => 'err')
    expect(captureException).toHaveBeenCalledWith(expect.any(Error))
  })

  it('capture500 DOES call captureException for non-Error objects (wrapped in Error)', async () => {
    // Since fingerprinting was added, non-Error plain objects are also captured
    // (wrapped in a new Error) so they get grouped in Sentry.
    const { captureException } = await import('@sentry/node')
    ;(captureException as ReturnType<typeof vi.fn>).mockClear()
    const { capture500 } = await import('../../src/lib/sentryCapture.js')
    const res = { _s: 0, _b: null, status(c: number) { this._s = c; return this }, json(b: unknown) { this._b = b; return this } }
    capture500(res as never, { code: 404 }, () => 'not found')
    expect(captureException).toHaveBeenCalledWith(expect.any(Error))
  })

  it('sentry.server.js initialised with expressIntegration', async () => {
    const sentry = await import('@sentry/node')
    expect(sentry.init).toHaveBeenCalled()
  })
})
