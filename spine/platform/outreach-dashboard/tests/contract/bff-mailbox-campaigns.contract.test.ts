// ═══════════════════════════════════════════════════════════════════════════
//  Contract — GET /api/mailboxes/:id/campaigns
//
//  Added by initiative 2026-04-28-mailboxes-ui-declutter (Mailbox-drawer
//  "Použití" section). The endpoint joins send_events.mailbox_used →
//  outreach_mailboxes.from_address, groups by campaign_id, and returns
//  { total, campaigns:[{id,name,status,sent_count,last_sent_at}] }.
//
//  Locks in:
//    - 200 + shape on happy-path
//    - 200 with empty `campaigns` when the mailbox has never been used
//    - 404 when the mailbox id is unknown
//    - 500 when pg throws
//    - SQL pattern: ORDER BY MAX(sent_at) DESC, LIMIT 50
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

let baseUrl = ''
let server: import('http').Server
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  // Save env so afterAll can restore — prevents cross-test-file env leak
  // (docs/audits/2026-04-30-blind-spot-audit.md § A).
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

function queueRows(rows: unknown[]) { queryQueue.push({ rows }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

describe('GET /api/mailboxes/:id/campaigns', () => {
  it('200 returns { total, campaigns[] } when mailbox has campaigns', async () => {
    queueRows([{ from_address: 'a.mazher@email.cz' }])
    queueRows([
      { id: 11, name: 'První', status: 'active', sent_count: 50, last_sent_at: new Date('2026-04-25T10:00:00Z') },
      { id: 22, name: 'Druhá', status: 'paused', sent_count: 30, last_sent_at: new Date('2026-04-20T10:00:00Z') },
    ])
    const res = await get('/api/mailboxes/3/campaigns')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      total: 2,
      campaigns: [
        expect.objectContaining({ id: 11, name: 'První' }),
        expect.objectContaining({ id: 22, name: 'Druhá' }),
      ],
    })
  })

  it('200 returns { total: 0, campaigns: [] } when mailbox never used', async () => {
    queueRows([{ from_address: 'unused@example.com' }])
    queueRows([])
    const res = await get('/api/mailboxes/99/campaigns')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total: 0, campaigns: [] })
  })

  it('404 + {error} when mailbox id is unknown', async () => {
    queueRows([])
    const res = await get('/api/mailboxes/999/campaigns')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('500 when first pg query throws', async () => {
    queueError('connection lost')
    const res = await get('/api/mailboxes/3/campaigns')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'connection lost' })
  })

  it('500 when join query throws', async () => {
    queueRows([{ from_address: 'a.mazher@email.cz' }])
    queueError('relation campaigns does not exist')
    const res = await get('/api/mailboxes/3/campaigns')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'relation campaigns does not exist' })
  })

  it('issues an ORDER BY MAX(sent_at) DESC + LIMIT 50 query', async () => {
    queueRows([{ from_address: 'a.mazher@email.cz' }])
    queueRows([])
    await get('/api/mailboxes/3/campaigns')
    expect(calls.length).toBe(2)
    expect(calls[1].sql).toMatch(/ORDER BY[\s\S]+sent_at[\s\S]+DESC/i)
    expect(calls[1].sql).toMatch(/LIMIT\s+50/i)
  })

  it('joins send_events on mailbox_used = from_address', async () => {
    queueRows([{ from_address: 'a.mazher@email.cz' }])
    queueRows([])
    await get('/api/mailboxes/3/campaigns')
    expect(calls[1].sql).toMatch(/mailbox_used\s*=\s*\$1/i)
    expect(calls[1].params).toEqual(['a.mazher@email.cz'])
  })
})
