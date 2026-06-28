// ═══════════════════════════════════════════════════════════════════════════
//  SEND-S6.2 / BFF contract — has_valid_password flag on GET /api/mailboxes
//
// The BFF must:
//   1. NEVER include the `password` field in the JSON response
//   2. Derive a server-side `has_valid_password` boolean flag by mirroring
//      Go's mailbox.IsPlaceholderPassword logic (bad prefixes: 123p, xxxx,
//      password, admin, test; length < 8; repeated-trigram detection)
//
// This test locks in the invariant so a future refactor can't accidentally
// leak passwords or regress the placeholder detection. It stubs `pg` so no
// real DB is required.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [] }
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

const API_KEY = 'test-key-has-valid-password'
let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  // server.js reads .env on load and may clobber OUTREACH_API_KEY; set after
  // import so the middleware (evaluated per-request) sees our test key.
  process.env.OUTREACH_API_KEY = API_KEY
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

function queueRows(rows: unknown[]) {
  queryQueue.push({ rows })
}

async function getMailboxes() {
  const r = await fetch(baseUrl + '/api/mailboxes', {
    headers: { 'x-api-key': API_KEY },
  })
  const text = await r.text()
  const json = text ? JSON.parse(text) : null
  return { status: r.status, body: json, raw: text }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/mailboxes — has_valid_password flag
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/mailboxes — has_valid_password flag', () => {
  it('never exposes the password field in the JSON response', async () => {
    queueRows([
      { id: 1, email: 'a@seznam.cz', password: '123p123p123p123' },
      { id: 2, email: 'b@seznam.cz', password: 'S3cureP@ss2026!' },
    ])
    const res = await getMailboxes()
    expect(res.status).toBe(200)
    const arr = res.body as Array<Record<string, unknown>>
    for (const mb of arr) {
      expect(mb).not.toHaveProperty('password')
    }
    // Belt-and-suspenders: the raw response text must not contain either value
    expect(res.raw).not.toContain('123p123p123p123')
    expect(res.raw).not.toContain('S3cureP@ss2026!')
  })

  it('placeholder password (xxxx prefix) → has_valid_password=false', async () => {
    queueRows([{ id: 1, email: 'a@seznam.cz', password: 'xxxxxxxxxxxx' }])
    const res = await getMailboxes()
    expect(res.status).toBe(200)
    const arr = res.body as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0].has_valid_password).toBe(false)
  })

  it('real password → has_valid_password=true', async () => {
    queueRows([{ id: 2, email: 'b@seznam.cz', password: 'S3cureP@ss2026!' }])
    const res = await getMailboxes()
    expect(res.status).toBe(200)
    const arr = res.body as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0].has_valid_password).toBe(true)
  })

  it('mixed list — each row flagged correctly', async () => {
    queueRows([
      { id: 1, email: 'bad@x', password: 'password12345' },
      { id: 2, email: 'good@x', password: 'S3cureP@ss2026!' },
      { id: 3, email: 'empty@x', password: '' },
      { id: 4, email: 'null@x', password: null },
    ])
    const res = await getMailboxes()
    expect(res.status).toBe(200)
    const arr = res.body as Array<Record<string, unknown>>
    expect(arr).toHaveLength(4)
    expect(arr[0].has_valid_password).toBe(false) // "password" prefix → blocked
    expect(arr[1].has_valid_password).toBe(true)  // real
    expect(arr[2].has_valid_password).toBe(false) // empty
    expect(arr[3].has_valid_password).toBe(false) // null
    for (const mb of arr) {
      expect(mb).not.toHaveProperty('password')
    }
  })

  // Individual placeholder patterns — must all be detected as invalid.
  const PLACEHOLDER_PATTERNS: Array<[string, string]> = [
    ['empty string',       ''],
    ['null',               null as unknown as string],
    ['short (<8 chars)',   'short1'],
    ['xxxx prefix',        'xxxxxxxxxxx'],
    ['password prefix',    'password123'],
    ['admin prefix',       'admin12345'],
    ['test prefix',        'testpassword'],
    ['heslo prefix',       'heslo123456'],
    ['change-me prefix',   'change-me-now'],
  ]

  it.each(PLACEHOLDER_PATTERNS)('placeholder pattern: %s → has_valid_password=false', async (_label, pw) => {
    queueRows([{ id: 1, email: 'x@y', password: pw }])
    const res = await getMailboxes()
    const arr = res.body as Array<Record<string, unknown>>
    expect(arr[0].has_valid_password).toBe(false)
    expect(arr[0]).not.toHaveProperty('password')
  })

  const REAL_PASSWORDS: Array<[string, string]> = [
    ['strong mixed',          'Gj7!kP#9qLxV'],
    ['long alphanumeric',     'a1b2c3d4e5f6'],
    ['seznam-style app pw',   'ZeyVgXk4LpQmB'],
  ]

  it.each(REAL_PASSWORDS)('real password: %s → has_valid_password=true', async (_label, pw) => {
    queueRows([{ id: 1, email: 'x@y', password: pw }])
    const res = await getMailboxes()
    const arr = res.body as Array<Record<string, unknown>>
    expect(arr[0].has_valid_password).toBe(true)
    expect(arr[0]).not.toHaveProperty('password')
  })
})
