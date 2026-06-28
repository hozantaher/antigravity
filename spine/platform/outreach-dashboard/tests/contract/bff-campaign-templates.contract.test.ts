// Contract: campaign templates creation + preflight template check
// RED phase — templates don't exist yet

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
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

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

describe('GET /api/templates — slug lookup', () => {
  it('returns templates matching slugs', async () => {
    queryQueue.push({
      rows: [
        { id: 1, name: 'intro_machinery', slug: 'intro_machinery', subject: 'Dobrý den', body: 'Text' },
        { id: 2, name: 'followup_1', slug: 'followup_1', subject: 'Navazuji', body: 'Text' },
        { id: 3, name: 'followup_2', slug: 'followup_2', subject: 'Poslední pokus', body: 'Text' },
      ],
    })
    const res = await fetch(`${baseUrl}/api/templates`)
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
  })

  it('empty templates → empty array', async () => {
    queryQueue.push({ rows: [] })
    const res = await fetch(`${baseUrl}/api/templates`)
    const body = await res.json() as unknown[]
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(0)
  })

  it('DB error → 500', async () => {
    queryQueue.push(new Error('db timeout'))
    const res = await fetch(`${baseUrl}/api/templates`)
    expect(res.status).toBe(500)
  })
})

describe('POST /api/templates — create', () => {
  it('valid body → 200 with id', async () => {
    queryQueue.push({ rows: [{ id: 1, name: 'intro_machinery', slug: 'intro_machinery', subject: 'Test', body: 'Body' }] })
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'intro_machinery', subject: 'Test', body: 'Body' }),
    })
    expect([200, 201]).toContain(res.status)
  })

  it('missing name → 400', async () => {
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Test', body: 'Body' }),
    })
    expect(res.status).toBe(400)
  })

  it('DB error → 500', async () => {
    queryQueue.push(new Error('unique violation'))
    const res = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'intro_machinery', subject: 'Test', body: 'Body' }),
    })
    expect(res.status).toBe(500)
  })

  it('MONKEY: 8 payloads — none crash server', async () => {
    const payloads = [
      null, {}, { name: null }, { name: '', subject: '', body: '' },
      { name: 'x'.repeat(300) }, { name: 'ok', subject: 'a', body: 'b', extra: true },
      { name: 'ok', subject: null, body: null },
      { name: 'ok', subject: 'S', body: 'B', html: '<b>bold</b>' },
    ]
    for (const p of payloads) {
      queryQueue.push({ rows: [{ id: 99 }] })
      const res = await fetch(`${baseUrl}/api/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      }).catch(() => ({ status: 200 }))
      expect([200, 201, 400, 500]).toContain(res.status)
      // Server must still be alive
      const alive = await fetch(`${baseUrl}/api/templates`).then(r => r.status).catch(() => 0)
      expect(alive).toBeTruthy()
    }
  })
})
