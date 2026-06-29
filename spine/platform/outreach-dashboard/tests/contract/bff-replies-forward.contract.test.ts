// S1.1 — BFF /api/replies/:id/forward-to-garaaage stub contract tests.
// Marks reply handled + writes healing_log audit. Until Garaaage portal
// exposes ingestion API (S6), upload of photos+TP is manual; endpoint is
// the audit trail for "operator escalated this reply".

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
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
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

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

describe('POST /api/replies/:id/forward-to-garaaage', () => {
  it('returns 200 + flips reply.handled + writes healing_log', async () => {
    // SELECT reply
    q([{ id: 100, contact_id: 50, campaign_id: 455, from_email: 'seller@firma.cz' }])
    // UPDATE reply_inbox SET handled=TRUE
    q([], 1)
    // INSERT INTO healing_log
    q([])

    const { status, body } = await req(
      'POST',
      '/api/replies/100/forward-to-garaaage',
      { notes: 'Bagr Komatsu 2008, vidím dobrý stav z fotky' }
    )
    expect(status).toBe(200)
    expect((body as Record<string, unknown>).ok).toBe(true)
    expect((body as Record<string, unknown>).reply_id).toBe(100)

    const sqls = calls.map(c => c.sql)
    expect(sqls.some(s => /UPDATE reply_inbox SET handled=TRUE/.test(s))).toBe(true)
    expect(sqls.some(s => /INSERT INTO healing_log/.test(s) && /forward_to_garaaage/.test(s))).toBe(true)
  })

  it('accepts garaaage_url in body and includes in response', async () => {
    q([{ id: 200, contact_id: 51, campaign_id: 455, from_email: 'a@b.cz' }])
    q([], 1)
    q([])

    const { status, body } = await req(
      'POST',
      '/api/replies/200/forward-to-garaaage',
      { garaaage_url: 'https://garaaage.cz/aukce/xyz' }
    )
    expect(status).toBe(200)
    expect((body as Record<string, unknown>).garaaage_url).toBe('https://garaaage.cz/aukce/xyz')
  })

  it('404 when reply not found', async () => {
    q([])  // SELECT returns empty
    const { status } = await req('POST', '/api/replies/9999/forward-to-garaaage', {})
    expect(status).toBe(404)
  })

  it('healing_log row contains reply id and from_email as label', async () => {
    q([{ id: 300, contact_id: 52, campaign_id: 455, from_email: 'seller@example.cz' }])
    q([], 1)
    q([])

    await req('POST', '/api/replies/300/forward-to-garaaage', { notes: 'note text' })
    const healingCall = calls.find(c => /INSERT INTO healing_log/.test(c.sql))
    expect(healingCall).toBeTruthy()
    expect(healingCall!.params).toContain('300')
    expect(healingCall!.params).toContain('seller@example.cz')
    expect(healingCall!.params).toContain('note text')
  })

  it('uses garaaage_url as reason when notes empty', async () => {
    q([{ id: 400, contact_id: 53, campaign_id: 455, from_email: 'x@y.cz' }])
    q([], 1)
    q([])

    await req('POST', '/api/replies/400/forward-to-garaaage', { garaaage_url: 'https://g.cz/listing/1' })
    const healingCall = calls.find(c => /INSERT INTO healing_log/.test(c.sql))
    expect(healingCall!.params).toContain('https://g.cz/listing/1')
  })

  it('falls back to "manual handoff" reason when neither notes nor url provided', async () => {
    q([{ id: 500, contact_id: 54, campaign_id: 455, from_email: 'x@y.cz' }])
    q([], 1)
    q([])

    await req('POST', '/api/replies/500/forward-to-garaaage', {})
    const healingCall = calls.find(c => /INSERT INTO healing_log/.test(c.sql))
    expect(healingCall!.params).toContain('manual handoff to Garaaage')
  })

  it('handles empty body (no notes, no garaaage_url)', async () => {
    q([{ id: 600, contact_id: 55, campaign_id: 455, from_email: 'x@y.cz' }])
    q([], 1)
    q([])

    const { status, body } = await req('POST', '/api/replies/600/forward-to-garaaage')
    expect(status).toBe(200)
    expect((body as Record<string, unknown>).ok).toBe(true)
  })
})
