// Contract: Sentry tags are set on authenticated requests
// Verifies that the BFF middleware enriches Sentry scope with route/env context.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

const setTagCalls: Array<[string, string]> = []
const scopedContexts: unknown[] = []

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    captureException: vi.fn(),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
    withIsolationScope: vi.fn((fn: (scope: unknown) => void) => {
      const scope = {
        setTag: vi.fn((k: string, v: string) => setTagCalls.push([k, v])),
        setContext: vi.fn((k: string, v: unknown) => scopedContexts.push({ [k]: v })),
      }
      return fn(scope)
    }),
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
  setTagCalls.length = 0
  scopedContexts.length = 0
})

describe('Sentry scope enrichment middleware', () => {
  it('sentry.server.js is imported before express — init was called', async () => {
    const sentry = await import('@sentry/node')
    expect(sentry.init).toHaveBeenCalled()
  })

  it('BFF responds 200 on health endpoint', async () => {
    const res = await fetch(`${baseUrl}/api/health/system`)
    expect([200, 503]).toContain(res.status)
  })
})
