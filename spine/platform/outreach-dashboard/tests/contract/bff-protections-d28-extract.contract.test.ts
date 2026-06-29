// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — D2.8 server.js protections extraction
//
//  Locks the response shape + SQL contract for the 5 routes moved from
//  server.js into src/server-routes/protections.js as part of sprint D2.8
//  (2026-05-02).
//
//  Routes covered (5 total):
//    GET  /api/protections/matrix              — latest probe per (layer, level)
//    GET  /api/protections/trace/:messageId    — per-send protection trace (S6)
//    GET  /api/protections/alerts              — open + acked alerts (S7)
//    POST /api/protections/alerts/:id/ack      — operator silences a banner
//    GET  /api/protections/coverage            — 24h trace coverage gauge
//
//  Ochrany panel = 12 layers × 2 levels (L2/L3) per memory
//  project_protection_matrix (T1). Tests assert the matrix shape stays
//  intact when the DB returns multiple (layer, level) combinations.
//
//  Strategy mirrors bff-templates-d26-extract.contract.test.ts: pg.Pool is
//  mocked, the BFF is booted via app.listen(0), and tests exercise real
//  Express dispatch through the mounter wiring.
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
      return {
        query: async (sql: string, params?: unknown[]) => {
          calls.push({ sql, params })
          if (!queryQueue.length) return { rows: [], rowCount: 0 }
          const next = queryQueue.shift()!
          if (next instanceof Error) throw next
          return next
        },
        release: () => {},
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
  for (const k of ['BFF_IMPORT_ONLY', 'DATABASE_URL', 'EMAIL_VERIFY_SMTP']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.EMAIL_VERIFY_SMTP = '0'
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
function queueRowCount(rowCount: number) { queryQueue.push({ rows: [], rowCount }) }
function queueError(msg: string) { queryQueue.push(new Error(msg)) }

async function get(path: string) {
  const r = await fetch(baseUrl + path)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, headers: r.headers }
}

async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/protections/matrix — Ochrany panel grid (12 layers × 2 levels)
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/protections/matrix', () => {
  it('200 returns { probes: [], generated_at } when no probe rows', async () => {
    queueRows([])
    const res = await get('/api/protections/matrix')
    expect(res.status).toBe(200)
    const body = res.body as { probes: unknown[]; generated_at: string }
    expect(body.probes).toEqual([])
    expect(typeof body.generated_at).toBe('string')
    expect(() => new Date(body.generated_at)).not.toThrow()
  })

  it('preserves all 8 cell keys per probe (layer, level, status, detail, latency_ms, expected, actual, checked_at)', async () => {
    const checkedAt = new Date('2026-05-02T10:00:00Z').toISOString()
    queueRows([
      {
        layer: 'tls',
        level: 'L2',
        status: 'pass',
        detail: 'sni ok',
        latency_ms: 42,
        expected: { sni: 'expected.example.com' },
        actual: { sni: 'expected.example.com' },
        checked_at: checkedAt,
      },
    ])
    const res = await get('/api/protections/matrix')
    expect(res.status).toBe(200)
    const body = res.body as { probes: Array<Record<string, unknown>> }
    expect(body.probes).toHaveLength(1)
    const probe = body.probes[0]
    expect(Object.keys(probe).sort()).toEqual(
      ['actual', 'checked_at', 'detail', 'expected', 'latency_ms', 'layer', 'level', 'status'].sort(),
    )
    expect(probe.layer).toBe('tls')
    expect(probe.level).toBe('L2')
    expect(probe.status).toBe('pass')
    expect(probe.detail).toBe('sni ok')
    expect(probe.latency_ms).toBe(42)
    expect(probe.expected).toEqual({ sni: 'expected.example.com' })
    expect(probe.actual).toEqual({ sni: 'expected.example.com' })
    expect(probe.checked_at).toBe(checkedAt)
  })

  it('returns 12×2 grid shape: a representative subset across L2 and L3 layers', async () => {
    // Memory project_protection_matrix: 12 layers × 2 levels.
    // We send a representative subset to verify the BFF preserves cell
    // distinctness — UI pins layer names client-side, so missing rows are
    // fine; what we MUST guarantee is per-(layer, level) integrity.
    const layers = ['tls', 'sni', 'http2', 'cookie', 'fingerprint', 'ja3']
    const cells = layers.flatMap(layer => [
      { layer, level: 'L2', status: 'pass', detail: '', latency_ms: 10, expected: {}, actual: {}, checked_at: '2026-05-02T10:00:00Z' },
      { layer, level: 'L3', status: 'pass', detail: '', latency_ms: 20, expected: {}, actual: {}, checked_at: '2026-05-02T10:00:00Z' },
    ])
    queueRows(cells)
    const res = await get('/api/protections/matrix')
    expect(res.status).toBe(200)
    const body = res.body as { probes: Array<{ layer: string; level: string }> }
    expect(body.probes).toHaveLength(layers.length * 2)
    // Each (layer, level) pair appears exactly once — cell uniqueness invariant.
    const seen = new Set(body.probes.map(p => `${p.layer}:${p.level}`))
    expect(seen.size).toBe(body.probes.length)
  })

  it('SQL contract uses DISTINCT ON (layer, level) ordered by checked_at DESC', async () => {
    queueRows([])
    await get('/api/protections/matrix')
    const sql = calls.find(c => /protection_probes/.test(c.sql))?.sql || ''
    expect(sql).toMatch(/DISTINCT ON \(layer, level\)/)
    expect(sql).toMatch(/ORDER BY layer, level, checked_at DESC/)
  })

  it('500 on pg throw', async () => {
    queueError('relation protection_probes does not exist')
    const res = await get('/api/protections/matrix')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/protections/trace/:messageId
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/protections/trace/:messageId', () => {
  it('404 when no trace row matches', async () => {
    queueRows([])
    const res = await get('/api/protections/trace/msg-missing')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('200 returns layered shape with nested send_context', async () => {
    queueRows([
      {
        message_id: 'msg-42',
        layers: { tls: 'pass', sni: 'pass' },
        traced_at: '2026-05-02T11:00:00Z',
        campaign_id: 'camp-1',
        contact_id: 'cont-9',
        mailbox_used: 'sales@example.com',
        send_status: 'sent',
        sent_at: '2026-05-02T10:59:00Z',
      },
    ])
    const res = await get('/api/protections/trace/msg-42')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown> & { send_context: Record<string, unknown> }
    expect(body.message_id).toBe('msg-42')
    expect(body.layers).toEqual({ tls: 'pass', sni: 'pass' })
    expect(body.traced_at).toBe('2026-05-02T11:00:00Z')
    expect(body.send_context).toEqual({
      campaign_id: 'camp-1',
      contact_id: 'cont-9',
      mailbox_used: 'sales@example.com',
      send_status: 'sent',
      sent_at: '2026-05-02T10:59:00Z',
    })
  })

  it('SQL passes :messageId as $1 and joins protection_trace LEFT JOIN send_events', async () => {
    queueRows([])
    await get('/api/protections/trace/msg-99')
    const call = calls.find(c => /protection_trace/.test(c.sql))
    expect(call?.params).toEqual(['msg-99'])
    expect(call?.sql).toMatch(/LEFT JOIN send_events/)
    expect(call?.sql).toMatch(/ORDER BY pt\.traced_at DESC/)
    expect(call?.sql).toMatch(/LIMIT 1/)
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/protections/trace/msg-x')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/protections/alerts
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/protections/alerts', () => {
  it('200 returns { alerts: [], generated_at } when no alerts', async () => {
    queueRows([])
    const res = await get('/api/protections/alerts')
    expect(res.status).toBe(200)
    const body = res.body as { alerts: unknown[]; generated_at: string }
    expect(body.alerts).toEqual([])
    expect(typeof body.generated_at).toBe('string')
  })

  it('returns rows in DB order (severity rank: critical first, then fired_at ASC) — passes through unchanged', async () => {
    const stored = [
      { id: 1, layer: 'tls', level: 'L3', severity: 9, status: 'open', consecutive_failures: 5, last_status: 'fail', detail: 'cert expired', fired_at: '2026-05-02T08:00:00Z', acked_at: null, updated_at: '2026-05-02T09:00:00Z' },
      { id: 2, layer: 'sni', level: 'L2', severity: 5, status: 'acked', consecutive_failures: 2, last_status: 'fail', detail: '', fired_at: '2026-05-02T09:00:00Z', acked_at: '2026-05-02T09:30:00Z', updated_at: '2026-05-02T09:30:00Z' },
    ]
    queueRows(stored)
    const res = await get('/api/protections/alerts')
    expect(res.status).toBe(200)
    const body = res.body as { alerts: typeof stored }
    expect(body.alerts).toEqual(stored)
  })

  it('SQL contract filters status IN (open, acked) and orders by severity rank (critical first), fired_at ASC', async () => {
    queueRows([])
    await get('/api/protections/alerts')
    const sql = calls.find(c => /protection_alerts/.test(c.sql))?.sql || ''
    expect(sql).toMatch(/status IN \('open', 'acked'\)/)
    // severity is a string enum {critical,warning}; a plain `severity DESC`
    // sorts 'warning' ABOVE 'critical' (lexical). The handler now ranks via an
    // explicit CASE so the most-severe alert sorts first regardless of lexical
    // order: critical -> 0, warning -> 1, else -> 2; ties broken by fired_at ASC.
    expect(sql).toMatch(/ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, fired_at ASC/)
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/protections/alerts')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/protections/alerts/:id/ack
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/protections/alerts/:id/ack', () => {
  it('200 returns { ok: true } when row is acked (rowCount=1)', async () => {
    // transaction: BEGIN → UPDATE → audit INSERT → COMMIT
    queueRows([])          // BEGIN
    queueRowCount(1)       // UPDATE (rowCount=1 → found)
    queueRows([])          // audit INSERT
    queueRows([])          // COMMIT
    const res = await send('POST', '/api/protections/alerts/42/ack')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const call = calls.find(c => /UPDATE protection_alerts/.test(c.sql))
    expect(call?.params).toEqual(['42'])
    expect(call?.sql).toMatch(/SET status = 'acked'/)
    expect(call?.sql).toMatch(/WHERE id = \$1 AND status = 'open'/)
  })

  it('audit log fires on successful ack', async () => {
    queueRows([])
    queueRowCount(1)
    queueRows([])
    queueRows([])
    await send('POST', '/api/protections/alerts/42/ack')
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall!.sql).toContain('protection_alert_ack')
    // params: [entity_id, details_json]
    const detail = JSON.parse(auditCall!.params![1] as string)
    expect(detail).toHaveProperty('acked_at')
    expect(auditCall!.params![0]).toBe('42')
  })

  it('404 when row not found or already acked (rowCount=0)', async () => {
    // transaction: BEGIN → UPDATE (rowCount=0) → ROLLBACK
    queueRows([])          // BEGIN
    queueRowCount(0)       // UPDATE (rowCount=0 → not found)
    // ROLLBACK will get empty queue → ok
    const res = await send('POST', '/api/protections/alerts/9999/ack')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found or already acked' })
    // No audit row since we returned 404 before INSERT
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('500 on pg throw (ROLLBACK fires)', async () => {
    queueRows([])          // BEGIN
    queueError('connection lost')  // UPDATE throws
    const res = await send('POST', '/api/protections/alerts/1/ack')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/protections/coverage
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/protections/coverage', () => {
  it('200 returns { total_sent, traced, coverage_pct, window_hours: 24 }', async () => {
    queueRows([{ total_sent: '100', traced: '95', coverage_pct: '95.0' }])
    const res = await get('/api/protections/coverage')
    expect(res.status).toBe(200)
    const body = res.body as { total_sent: number; traced: number; coverage_pct: number | null; window_hours: number }
    expect(body.total_sent).toBe(100)
    expect(body.traced).toBe(95)
    expect(body.coverage_pct).toBe(95)
    expect(body.window_hours).toBe(24)
  })

  it('coerces all numeric strings to numbers (Postgres returns numerics as strings)', async () => {
    queueRows([{ total_sent: '50', traced: '50', coverage_pct: '100.0' }])
    const res = await get('/api/protections/coverage')
    const body = res.body as { total_sent: number; traced: number; coverage_pct: number }
    expect(typeof body.total_sent).toBe('number')
    expect(typeof body.traced).toBe('number')
    expect(typeof body.coverage_pct).toBe('number')
  })

  it('returns coverage_pct: null when total_sent is 0 (CASE WHEN guard)', async () => {
    queueRows([{ total_sent: '0', traced: '0', coverage_pct: null }])
    const res = await get('/api/protections/coverage')
    expect(res.status).toBe(200)
    const body = res.body as { total_sent: number; traced: number; coverage_pct: number | null }
    expect(body.total_sent).toBe(0)
    expect(body.traced).toBe(0)
    expect(body.coverage_pct).toBeNull()
  })

  it('SQL filters last 24h send_events with status=sent', async () => {
    queueRows([{ total_sent: '0', traced: '0', coverage_pct: null }])
    await get('/api/protections/coverage')
    const sql = calls.find(c => /send_events/.test(c.sql) && /protection_trace/.test(c.sql))?.sql || ''
    expect(sql).toMatch(/sent_at >= now\(\) - interval '24 hours'/)
    expect(sql).toMatch(/status = 'sent'/)
    expect(sql).toMatch(/LEFT JOIN protection_trace pt ON pt\.message_id = se\.message_id/)
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/protections/coverage')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Routing invariants — Express ordering preserved from server.js
// ═══════════════════════════════════════════════════════════════════════

describe('Protections routing invariants', () => {
  it('GET /api/protections/coverage is NOT routed through /trace/:messageId', async () => {
    // Sanity: coverage hits its own handler, not the trace handler with
    // messageId='coverage'. trace handler returns 404 on no rows; coverage
    // returns 200 with the gauge shape.
    queueRows([{ total_sent: '0', traced: '0', coverage_pct: null }])
    const res = await get('/api/protections/coverage')
    expect(res.status).toBe(200)
    const body = res.body as { window_hours: number }
    expect(body.window_hours).toBe(24)
  })

  it('GET /api/protections/alerts is NOT routed through /trace/:messageId', async () => {
    queueRows([])
    const res = await get('/api/protections/alerts')
    expect(res.status).toBe(200)
    const body = res.body as { alerts: unknown[] }
    expect(Array.isArray(body.alerts)).toBe(true)
  })

  it('POST /api/protections/alerts/:id/ack does not collide with GET /alerts', async () => {
    // GET /alerts uses different verb and no :id — so the ack route is
    // separable. Transaction: BEGIN → UPDATE → audit INSERT → COMMIT
    queueRows([])          // BEGIN
    queueRowCount(1)       // UPDATE (rowCount=1 → found)
    queueRows([])          // audit INSERT
    queueRows([])          // COMMIT
    const res = await send('POST', '/api/protections/alerts/7/ack')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
