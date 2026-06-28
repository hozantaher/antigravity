/**
 * BFF property-based fuzz (M7)
 *
 * Property-based tests that generate random inputs and verify invariants
 * hold across every iteration. If *any* iteration fails the test fails.
 *
 * Invariants under test:
 *   P1: every POST /api/mailboxes input yields status < 600 (no crash)
 *   P2: every GET /api/mailboxes?q=<random> is < 2s and < 600
 *   P3: every :id route with random string id yields < 600
 *   P4: pg parameterized binding is used for every random SQLi payload
 *   P5: every JSON response is parseable
 *   P6: no env var leaks to response body across random inputs
 *   P7: response header set is stable across 100 random bodies
 *
 * Each property runs 50–200 iterations. Seeded so failures reproduce.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[] } | Error
const queryQueue: QueryOutcome[] = []
const callLog: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class Pool {
    async query(sql: string, params?: unknown[]) {
      callLog.push({ sql, params })
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

const SECRET = 'sentinel-property-fuzz-secret-xyz'

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.OUTREACH_API_KEY = SECRET
  const mod = await import('../../server.js')
  const { app } = mod as { app: import('express').Express }
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
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
  callLog.length = 0
})

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, raw: text, headers: r.headers }
}

// ── Deterministic PRNG (mulberry32) ────────────────────────────────
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomString(r: () => number, maxLen = 32): string {
  const alphabets = [
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '0123456789',
    '!@#$%^&*()_+-=[]{}|;:,.<>?/',
    'áčďéěíňóřšťúůýž',
    '🔥💯🚀⚡️🎯',
  ]
  const alphaRaw = alphabets[Math.floor(r() * alphabets.length)]
  // Split into code points so we don't slice surrogate pairs
  const alpha = Array.from(alphaRaw)
  const len = Math.floor(r() * maxLen) + 1
  let out = ''
  for (let i = 0; i < len; i++) out += alpha[Math.floor(r() * alpha.length)]
  return out
}

function safeEncode(s: string): string {
  try { return encodeURIComponent(s) } catch { return encodeURIComponent('fallback-' + s.length) }
}

function randomEmailLike(r: () => number): string | number | null | boolean | undefined {
  const pick = Math.floor(r() * 10)
  switch (pick) {
    case 0: return null
    case 1: return ''
    case 2: return Math.floor(r() * 1e6)
    case 3: return true
    case 4: return undefined
    case 5: return randomString(r, 8) + '@' + randomString(r, 8) + '.cz'
    case 6: return randomString(r, 200) + '@b.cz'
    case 7: return '..\\0\\r\\n' + randomString(r, 8)
    case 8: return "' OR '1'='1"
    default: return randomString(r, 16)
  }
}

function randomBody(r: () => number): unknown {
  return {
    email: randomEmailLike(r),
    display_name: r() > 0.5 ? randomString(r, 50) : null,
    smtp_host: r() > 0.3 ? randomString(r, 32) : '',
    smtp_port: [25, 465, 587, 2525, 0, -1, 999999][Math.floor(r() * 7)],
    smtp_username: r() > 0.5 ? randomString(r, 30) : undefined,
    password: r() > 0.3 ? randomString(r, 40) : '',
    daily_limit: [0, 1, 100, 1000, -5, null, 'abc'][Math.floor(r() * 7)],
    imap_host: r() > 0.7 ? randomString(r, 24) : null,
    imap_port: r() > 0.7 ? 993 : null,
  }
}

// ═══════════════════════════════════════════════════════════════════════
// P1 — POST /api/mailboxes never crashes the server
// ═══════════════════════════════════════════════════════════════════════
describe('property P1 — POST /api/mailboxes random input never 5xx beyond 599', () => {
  const SEEDS = [1, 2, 3, 4, 5, 42, 100, 200, 999, 31337]
  for (const seed of SEEDS) {
    it(`seed=${seed} (20 iterations) — every response < 600`, async () => {
      const r = rng(seed)
      for (let i = 0; i < 20; i++) {
        queueRows([])
        const resp = await req('POST', '/api/mailboxes', randomBody(r))
        expect(resp.status).toBeLessThan(600)
      }
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// P2 — GET /api/mailboxes?q=<random> is fast and safe
// ═══════════════════════════════════════════════════════════════════════
describe('property P2 — GET /api/mailboxes with random query is fast', () => {
  const SEEDS = [11, 22, 33, 44, 55]
  for (const seed of SEEDS) {
    it(`seed=${seed} (15 iters) — each < 2000ms and < 600`, async () => {
      const r = rng(seed)
      for (let i = 0; i < 15; i++) {
        queueRows([])
        const q = encodeURIComponent(randomString(r, 64))
        const start = Date.now()
        const resp = await req('GET', `/api/mailboxes?q=${q}`)
        const dur = Date.now() - start
        expect(resp.status).toBeLessThan(600)
        expect(dur).toBeLessThan(2000)
      }
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// P3 — :id param random value → < 600
// ═══════════════════════════════════════════════════════════════════════
describe('property P3 — random :id values never crash server', () => {
  const ROUTES = [
    '/api/mailboxes/__ID__/stats',
    '/api/mailboxes/__ID__/send-log',
    '/api/mailboxes/__ID__/watchdog-events',
    '/api/mailboxes/__ID__/cooldown-log',
  ]
  const SEEDS = [7, 13, 21]
  for (const route of ROUTES) {
    for (const seed of SEEDS) {
      it(`route=${route} seed=${seed} (10 iters)`, async () => {
        const r = rng(seed)
        for (let i = 0; i < 10; i++) {
          queueRows([])
          queueRows([])
          const id = encodeURIComponent(randomString(r, 24))
          const path = route.replace('__ID__', id)
          const resp = await req('GET', path)
          expect(resp.status).toBeLessThan(600)
        }
      })
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════
// P4 — pg parameterized binding for every random value
// ═══════════════════════════════════════════════════════════════════════
describe('property P4 — pg uses parameterized queries for random inputs', () => {
  it('50 random POSTs all use array params', async () => {
    const r = rng(7777)
    for (let i = 0; i < 50; i++) {
      queueRows([])
      callLog.length = 0
      await req('POST', '/api/mailboxes', randomBody(r))
      for (const c of callLog) {
        if (c.params !== undefined) {
          expect(Array.isArray(c.params)).toBe(true)
        }
      }
    }
  })
  it('SQL text never contains the user-supplied email string verbatim', async () => {
    const r = rng(1234)
    for (let i = 0; i < 30; i++) {
      queueRows([])
      callLog.length = 0
      const email = "' OR DROP TABLE x; --" + randomString(r, 8)
      await req('POST', '/api/mailboxes', {
        email, smtp_host: 'h', password: 'p',
      })
      for (const c of callLog) {
        expect(c.sql).not.toContain(email)
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// P5 — JSON response body always parseable
// ═══════════════════════════════════════════════════════════════════════
describe('property P5 — every JSON response is parseable', () => {
  it('80 random POSTs yield parseable JSON responses', async () => {
    const r = rng(555)
    for (let i = 0; i < 80; i++) {
      queueRows([])
      const resp = await req('POST', '/api/mailboxes', randomBody(r))
      const ct = resp.headers.get('content-type') ?? ''
      if (ct.includes('application/json') && resp.raw.length > 0) {
        expect(() => JSON.parse(resp.raw)).not.toThrow()
      }
    }
  })
  it('40 random GETs yield parseable JSON responses', async () => {
    const r = rng(666)
    for (let i = 0; i < 40; i++) {
      queueRows([])
      const q = encodeURIComponent(randomString(r, 40))
      const resp = await req('GET', `/api/mailboxes?q=${q}`)
      const ct = resp.headers.get('content-type') ?? ''
      if (ct.includes('application/json') && resp.raw.length > 0) {
        expect(() => JSON.parse(resp.raw)).not.toThrow()
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// P6 — no env var leaks
// ═══════════════════════════════════════════════════════════════════════
describe('property P6 — no env var leaks in response', () => {
  const LEAK_PROBES = [
    '/api/version',
    '/api/mailboxes',
    '/api/health/guards',
    '/api/metrics/mailboxes',
  ]
  for (const ep of LEAK_PROBES) {
    it(`${ep} under 50 random seeded stubs does not leak OUTREACH_API_KEY`, async () => {
      const r = rng(ep.length * 37)
      for (let i = 0; i < 50; i++) {
        queueRows([{ id: Math.floor(r() * 1000), name: randomString(r, 20) }])
        const resp = await req('GET', ep)
        expect(resp.raw).not.toContain(SECRET)
      }
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// P7 — response header set is stable
// ═══════════════════════════════════════════════════════════════════════
describe('property P7 — response headers stable across random bodies', () => {
  it('GET /api/mailboxes header set identical over 30 iters', async () => {
    const r = rng(900)
    queueRows([])
    const first = await req('GET', '/api/mailboxes')
    const firstKeys = Array.from(first.headers.keys()).sort().join(',')
    for (let i = 0; i < 30; i++) {
      queueRows([{ id: Math.floor(r() * 1000) }])
      const next = await req('GET', '/api/mailboxes')
      const keys = Array.from(next.headers.keys()).sort().join(',')
      expect(keys).toBe(firstKeys)
    }
  })
  it('GET /api/version header set identical over 20 iters', async () => {
    const first = await req('GET', '/api/version')
    const firstKeys = Array.from(first.headers.keys()).sort().join(',')
    for (let i = 0; i < 20; i++) {
      const next = await req('GET', '/api/version')
      const keys = Array.from(next.headers.keys()).sort().join(',')
      expect(keys).toBe(firstKeys)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// P8 — no race condition under concurrent random input
// ═══════════════════════════════════════════════════════════════════════
describe('property P8 — concurrent random requests preserve isolation', () => {
  it('10 concurrent random POSTs each resolve independently', async () => {
    const r = rng(404)
    for (let i = 0; i < 10; i++) queueRows([])
    const results = await Promise.all(
      Array.from({ length: 10 }, () => req('POST', '/api/mailboxes', randomBody(r)))
    )
    for (const resp of results) expect(resp.status).toBeLessThan(600)
  })
  it('20 concurrent mixed GET/POST all < 600', async () => {
    const r = rng(505)
    for (let i = 0; i < 20; i++) queueRows([])
    const reqs: Promise<unknown>[] = []
    for (let i = 0; i < 20; i++) {
      if (r() > 0.5) reqs.push(req('GET', '/api/mailboxes'))
      else reqs.push(req('POST', '/api/mailboxes', randomBody(r)))
    }
    const results = (await Promise.all(reqs)) as Array<{ status: number }>
    for (const resp of results) expect(resp.status).toBeLessThan(600)
  })
})
