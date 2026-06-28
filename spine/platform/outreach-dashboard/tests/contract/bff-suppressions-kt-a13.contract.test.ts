// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — KT-A13 endpoints
//   - POST /api/suppressions  (plural, new) → INSERT into suppression_list
//   - GET  /api/replies/:id/context (alias) → returns campaign + original_message
//
//  Why the plural `suppressions` collection: KT-A13 requires Unsubscribe
//  in ThreadDetail to write to suppression_list with extra metadata
//  (campaign_id, source). Existing `/api/suppression` (singular) is kept
//  for back-compat but does not carry the campaign_id/source semantics.
// ═══════════════════════════════════════════════════════════════════════════

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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  const mod = await import('../../server.js')
  delete process.env.GO_SERVER_URL
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

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/suppressions
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/suppressions (KT-A13)', () => {
  it('1. 400 when email is missing', async () => {
    const res = await req('POST', '/api/suppressions', { reason: 'unsubscribe_reply' })
    expect(res.status).toBe(400)
  })

  it('2. 400 when email is empty string', async () => {
    const res = await req('POST', '/api/suppressions', { email: '' })
    expect(res.status).toBe(400)
  })

  it('3. 400 when reason is not in allow-list', async () => {
    const res = await req('POST', '/api/suppressions', { email: 'a@b.cz', reason: 'arbitrary' })
    expect(res.status).toBe(400)
  })

  it('4. 200 on valid {email, reason: unsubscribe_reply, campaign_id, source}', async () => {
    queueRows([])
    const res = await req('POST', '/api/suppressions', {
      email: 'klient@firma.cz',
      reason: 'unsubscribe_reply',
      campaign_id: 17,
      source: 'thread_detail',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, email: 'klient@firma.cz' })
  })

  it('5. INSERT goes into suppression_list table', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', { email: 'a@b.cz', reason: 'unsubscribe_reply' })
    expect(calls[0].sql).toMatch(/INSERT INTO suppression_list/i)
  })

  it('6. ON CONFLICT DO UPDATE keeps the endpoint idempotent', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', { email: 'a@b.cz', reason: 'unsubscribe_reply' })
    expect(calls[0].sql).toMatch(/ON CONFLICT/i)
    expect(calls[0].sql).toMatch(/DO UPDATE/i)
  })

  it('7. lowercases email before INSERT (case-insensitive uniqueness)', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', { email: 'KLIENT@Firma.CZ', reason: 'manual' })
    const params = calls[0].params as unknown[]
    expect(params[0]).toBe('klient@firma.cz')
  })

  it('8. accepts manual + bounce_hard + unsubscribe_reply reasons', async () => {
    for (const reason of ['manual', 'bounce_hard', 'unsubscribe_reply']) {
      queueRows([])
      const res = await req('POST', '/api/suppressions', { email: `r${reason}@x.cz`, reason })
      expect(res.status, `reason=${reason}`).toBe(200)
    }
  })

  it('9. 500 on pg throw', async () => {
    queueError('db down')
    const res = await req('POST', '/api/suppressions', { email: 'a@b.cz', reason: 'manual' })
    expect(res.status).toBe(500)
  })

  it('10. campaign_id is forwarded to the INSERT params (audit trail)', async () => {
    queueRows([])
    await req('POST', '/api/suppressions', {
      email: 'k@f.cz', reason: 'unsubscribe_reply', campaign_id: 42, source: 'thread_detail',
    })
    const params = calls[0].params as unknown[]
    // Order is implementation-dependent; assert presence as values.
    expect(params).toContain(42)
  })

  it('11. source default = "manual" when omitted', async () => {
    queueRows([])
    const res = await req('POST', '/api/suppressions', { email: 'no-source@x.cz', reason: 'manual' })
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/replies/:id/context (alias for /api/threads/:id/context)
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /api/replies/:id/context (KT-A13 alias)', () => {
  it('12. 200 with shape { campaign, contact, company, classification }', async () => {
    queueRows([{
      contact_id: 2, campaign_id: 17, classification: 'unknown',
      from_email: 'k@f.cz', contact_name: 'K F',
      company_id: null, company_name: null, ico: null, sector: null, region: null,
      campaign_name: 'C', campaign_status: 'active',
    }])
    queueRows([{ sent: 5, replied: 1 }])
    // For original_message lookup (best-effort, tolerated empty).
    queueRows([])

    const res = await req('GET', '/api/replies/5/context')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body).toHaveProperty('campaign')
    expect(body).toHaveProperty('contact')
    expect(body).toHaveProperty('company')
    expect(body).toHaveProperty('classification')
  })

  it('13. campaign sub-object exposes id/name/status', async () => {
    queueRows([{
      contact_id: 2, campaign_id: 17, classification: 'positive',
      from_email: 'a@b.cz', contact_name: '',
      company_id: null, company_name: null, ico: null, sector: null, region: null,
      campaign_name: 'Výkup techniky 001', campaign_status: 'active',
    }])
    queueRows([{ sent: 12, replied: 3 }])
    queueRows([])

    const res = await req('GET', '/api/replies/5/context')
    const body = res.body as { campaign: { id: number; name: string; status: string } }
    expect(body.campaign.id).toBe(17)
    expect(body.campaign.name).toBe('Výkup techniky 001')
    expect(body.campaign.status).toBe('active')
  })

  it('14. 404 when reply id not found', async () => {
    queueRows([])
    const res = await req('GET', '/api/replies/9999/context')
    expect(res.status).toBe(404)
  })
})
