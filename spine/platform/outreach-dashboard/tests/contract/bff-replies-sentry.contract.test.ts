// Contract: replies.js routes capture errors in Sentry via capture500
// All 9 catch blocks in createRepliesRouter must call captureException on Error.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

const capturedErrors: Error[] = []

vi.mock('@sentry/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/node')>()
  return {
    ...actual,
    init: vi.fn(),
    captureException: vi.fn((err: unknown) => {
      if (err instanceof Error) capturedErrors.push(err)
      return 'fake-id'
    }),
    setupExpressErrorHandler: vi.fn(),
    expressIntegration: vi.fn(() => ({ name: 'Express' })),
  }
})

vi.mock('pg', () => {
  class Pool {
    async query() { throw new Error('db-error-replies') }
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
  capturedErrors.length = 0
})

const { captureException } = await import('@sentry/node')

describe('replies.js routes — Sentry capture on DB error', () => {
  // Routes that produce 500 + captureException reliably on DB error path.
  // PATCH /api/leads/:id requires body — without it, handler short-circuits
  // to 400/422 BEFORE reaching the DB layer, so Sentry capture path doesn't
  // fire. That route is exercised separately below with body present.
  const routes = [
    ['GET', '/api/replies'],
    ['GET', '/api/replies/stats'],
    ['GET', '/api/replies/1'],
    ['PATCH', '/api/replies/1/handled'],
    ['PATCH', '/api/replies/1'],
    ['GET', '/api/threads/1/context'],
    ['GET', '/api/threads/1/messages'],
    ['GET', '/api/leads'],
  ]

  for (const [method, path] of routes) {
    it(`${method} ${path} → 500 + captureException called`, async () => {
      ;(captureException as ReturnType<typeof vi.fn>).mockClear()
      capturedErrors.length = 0
      const res = await fetch(`${baseUrl}${path}`, { method })
      expect(res.status).toBe(500)
      expect(captureException).toHaveBeenCalled()
    })
  }

  it('PATCH /api/leads/1 (with body) → 500 + captureException called', async () => {
    ;(captureException as ReturnType<typeof vi.fn>).mockClear()
    capturedErrors.length = 0
    const res = await fetch(`${baseUrl}/api/leads/1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'qualified' }),
    })
    expect(res.status).toBe(500)
    expect(captureException).toHaveBeenCalled()
  })
})
