// F2+F3 — BFF contract: /api/campaigns/:id/email-quality + /capacity
// Stubs pg; tests happy-path shapes, 404, and 500 paths.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []

vi.mock('pg', () => {
  class Pool {
    async query(_sql: string, _params?: unknown[]) {
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
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
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
beforeEach(() => { queryQueue.length = 0 })

function q(rows: unknown[], rowCount = rows.length) { queryQueue.push({ rows, rowCount }) }
function qErr(msg: string) { queryQueue.push(new Error(msg)) }
async function req(method: string, path: string) {
  const r = await fetch(baseUrl + path, { method })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ── GET /api/campaigns/:id/email-quality ──────────────────────────────────────

describe('GET /api/campaigns/:id/email-quality', () => {
  it('returns quality breakdown', async () => {
    q([{ category_paths: [] }])  // campaign query
    // 4 parallel queries: statusRows, total, with_email, stale
    q([{ status: 'valid', cnt: 80 }, { status: 'unverified', cnt: 10 }])
    q([{ total: 100 }])
    q([{ with_email: 90 }])
    q([{ stale: 5 }])
    const { status, body } = await req('GET', '/api/campaigns/1/email-quality')
    expect(status).toBe(200)
    const b = body as Record<string, number>
    expect(b.total).toBe(100)
    expect(b.with_email).toBe(90)
    expect(b.without_email).toBe(10)
    expect(b.valid).toBe(80)
    expect(b.unverified).toBe(10)
  })

  it('404 when campaign not found', async () => {
    q([])
    const { status } = await req('GET', '/api/campaigns/999/email-quality')
    expect(status).toBe(404)
  })

  it('500 on db error', async () => {
    qErr('db down')
    const { status } = await req('GET', '/api/campaigns/1/email-quality')
    expect(status).toBe(500)
  })
})

// ── GET /api/campaigns/:id/capacity ──────────────────────────────────────────

describe('GET /api/campaigns/:id/capacity', () => {
  it('returns capacity with days_to_complete', async () => {
    q([{ category_paths: [], category_match: 'prefix' }])  // campaign
    q([{ daily_capacity: 200, active_mailboxes: 3 }])       // mailboxes sum
    q([{ estimate: 600 }])                                   // company count
    const { status, body } = await req('GET', '/api/campaigns/1/capacity')
    expect(status).toBe(200)
    const b = body as Record<string, number | null>
    expect(b.daily_capacity).toBe(200)
    expect(b.active_mailboxes).toBe(3)
    expect(b.estimate).toBe(600)
    expect(b.days_to_complete).toBe(3) // ceil(600/200)
  })

  it('days_to_complete null when no active mailboxes', async () => {
    q([{ category_paths: [], category_match: 'prefix' }])
    q([{ daily_capacity: 0, active_mailboxes: 0 }])
    q([{ estimate: 100 }])
    const { status, body } = await req('GET', '/api/campaigns/1/capacity')
    expect(status).toBe(200)
    expect((body as Record<string, null>).days_to_complete).toBeNull()
  })

  it('404 when campaign not found', async () => {
    q([])
    const { status } = await req('GET', '/api/campaigns/999/capacity')
    expect(status).toBe(404)
  })

  it('500 on db error', async () => {
    qErr('db down')
    const { status } = await req('GET', '/api/campaigns/1/capacity')
    expect(status).toBe(500)
  })
})
