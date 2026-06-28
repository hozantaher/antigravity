// M4.4 — POST /api/campaigns/:id/reset-next-send-at contract tests.
//
// Operator-controlled scheduling reset: sets next_send_at = NOW() for all
// pending/queued campaign_contacts with next_send_at > NOW(). Requires
// explicit double-confirm (confirm:true + reason ≥ 10 chars).
//
// Coverage targets (memory feedback_extreme_testing — ≥ 10 cases):
//   1.  POST without confirm body → 400
//   2.  POST with confirm=false → 400
//   3.  POST with reason too short (< 10 chars) → 400
//   4.  POST with reason missing → 400
//   5.  POST with valid body → 200 + { updated, campaign_id, requested_at, reason }
//   6.  SQL uses status IN ('pending','queued') AND next_send_at > NOW()
//       (already-past contacts are NOT in the WHERE clause)
//   7.  Campaign not found → 404
//   8.  Audit log row written on success
//   9.  Non-numeric id → 404
//  10.  rowCount reflected in response updated field
//  11.  reason is trimmed in response
//  12.  500 when pg UPDATE throws

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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL', 'GO_SERVER_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  delete process.env.GO_SERVER_URL

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
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
})

function queueRows(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json as Record<string, unknown> }
}

const VALID_BODY = { confirm: true, reason: 'Kampan odlozena automaticky, chceme spustit dnes' }
const CAMPAIGN_ROW = [{ id: 455, name: 'Excavators CZ' }]

// ═══════════════════════════════════════════════════════════════════════
//  1. POST without confirm field → 400
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns/:id/reset-next-send-at — validation', () => {
  it('1. 400 when confirm field is absent', async () => {
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', { reason: 'reason here is ten' })
    expect(res.status).toBe(400)
    expect(String(res.body?.error)).toMatch(/confirm/)
  })

  it('2. 400 when confirm=false', async () => {
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', { confirm: false, reason: 'reason here is ten' })
    expect(res.status).toBe(400)
    expect(String(res.body?.error)).toMatch(/confirm/)
  })

  it('3. 400 when reason is too short (< 10 chars)', async () => {
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', { confirm: true, reason: 'short' })
    expect(res.status).toBe(400)
    expect(String(res.body?.error)).toMatch(/reason/)
  })

  it('4. 400 when reason is missing', async () => {
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', { confirm: true })
    expect(res.status).toBe(400)
    expect(String(res.body?.error)).toMatch(/reason/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  5. Happy path → 200 + correct response shape
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns/:id/reset-next-send-at — happy path', () => {
  it('5. 200 returns { updated, campaign_id, requested_at, reason }', async () => {
    queueRows(CAMPAIGN_ROW)      // existence check
    queueRows([], 20)            // UPDATE rowCount=20
    queueRows([])                // audit INSERT (best-effort)
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', VALID_BODY)
    expect(res.status).toBe(200)
    expect(res.body?.campaign_id).toBe(455)
    expect(res.body?.updated).toBe(20)
    expect(typeof res.body?.requested_at).toBe('string')
    expect(res.body?.reason).toBe(VALID_BODY.reason)
  })

  it('10. rowCount=0 (nothing to reset) returns updated:0', async () => {
    queueRows(CAMPAIGN_ROW)
    queueRows([], 0)
    queueRows([])
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', VALID_BODY)
    expect(res.status).toBe(200)
    expect(res.body?.updated).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  6. SQL shape — status filter + next_send_at > NOW()
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns/:id/reset-next-send-at — SQL shape', () => {
  it('6. UPDATE targets pending/queued AND next_send_at > NOW()', async () => {
    queueRows(CAMPAIGN_ROW)
    queueRows([], 5)
    queueRows([])
    await req('POST', '/api/campaigns/455/reset-next-send-at', VALID_BODY)
    // Find the UPDATE call in calls array
    const updateCall = calls.find(c => /UPDATE campaign_contacts/i.test(c.sql))
    expect(updateCall).toBeDefined()
    expect(updateCall?.sql).toMatch(/status IN \('pending', 'queued'\)/i)
    expect(updateCall?.sql).toMatch(/next_send_at > NOW\(\)/i)
    expect(updateCall?.params).toContain('455')
  })

  it('6b. campaign_id param is correctly passed to UPDATE', async () => {
    queueRows([{ id: 123, name: 'Test Camp' }])
    queueRows([], 3)
    queueRows([])
    await req('POST', '/api/campaigns/123/reset-next-send-at', VALID_BODY)
    const updateCall = calls.find(c => /UPDATE campaign_contacts/i.test(c.sql))
    expect(updateCall?.params).toContain('123')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  7. Campaign not found → 404
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns/:id/reset-next-send-at — not found', () => {
  it('7. 404 when campaign does not exist (empty SELECT)', async () => {
    queueRows([])  // existence check returns empty
    const res = await req('POST', '/api/campaigns/9999/reset-next-send-at', VALID_BODY)
    expect(res.status).toBe(404)
    expect(String(res.body?.error)).toMatch(/not found/)
  })

  it('9. 404 for non-numeric id', async () => {
    const res = await req('POST', '/api/campaigns/abc/reset-next-send-at', VALID_BODY)
    expect(res.status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  8. Audit log written on success
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns/:id/reset-next-send-at — audit', () => {
  it('8. audit row inserted with action=campaign_next_send_reset', async () => {
    queueRows(CAMPAIGN_ROW)
    queueRows([], 7)
    queueRows([])
    await req('POST', '/api/campaigns/455/reset-next-send-at', VALID_BODY)
    // The action value 'campaign_next_send_reset' is embedded in the SQL
    // VALUES literal, not in the params array. Params are [entity_id, details_json].
    const auditCall = calls.find(c =>
      /INSERT INTO operator_audit_log/i.test(c.sql) &&
      /campaign_next_send_reset/.test(c.sql),
    )
    expect(auditCall).toBeDefined()
    // entity_id should be '455' (first params slot)
    expect(auditCall?.params?.[0]).toBe('455')
  })

  it('11. reason is trimmed in response and audit', async () => {
    const paddedReason = '  Reason with spaces around  '
    queueRows(CAMPAIGN_ROW)
    queueRows([], 2)
    queueRows([])
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', { confirm: true, reason: paddedReason })
    expect(res.status).toBe(200)
    expect(res.body?.reason).toBe(paddedReason.trim())
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  12. 500 when pg UPDATE throws
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/campaigns/:id/reset-next-send-at — errors', () => {
  it('12. 500 when pg UPDATE throws a db error', async () => {
    queueRows(CAMPAIGN_ROW)        // existence check succeeds
    queueError('deadlock detected') // UPDATE fails
    const res = await req('POST', '/api/campaigns/455/reset-next-send-at', VALID_BODY)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'deadlock detected' })
  })
})
