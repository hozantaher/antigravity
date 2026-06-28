// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — D2.6 server.js templates extraction
//
//  Locks the response shape + SQL contract for the 6 routes moved from
//  server.js into src/server-routes/templates.js as part of sprint D2.6
//  (2026-05-02).
//
//  Routes covered:
//    GET    /api/templates             — list email_templates
//    GET    /api/templates/ranking     — per-template reply/open rate (with
//                                         degraded fallback)
//    POST   /api/templates             — insert (requires name)
//    PUT    /api/templates/:id         — update name/subject/body
//    POST   /api/templates/preview     — pure render preview (renderTemplatePreview)
//    DELETE /api/templates/:id         — drop row
//
//  Strategy mirrors bff-scoring-d25-extract.contract.test.ts: pg.Pool is
//  mocked, the BFF is booted via app.listen(0), and tests exercise real
//  Express dispatch through the mounter wiring. The renderTemplatePreview
//  helper passed as dep is NOT mocked — it lives in src/lib/template-preview.js
//  and runs as-is (pure function, deterministic on the test inputs).
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
//  GET /api/templates
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/templates', () => {
  it('200 returns array (empty when no rows)', async () => {
    queueRows([])
    const res = await get('/api/templates')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('200 returns rows in created_at DESC order (preserved from query)', async () => {
    const stored = [
      { id: 2, name: 'newer', subject: 'B', body: '', created_at: '2026-05-02T00:00:00Z' },
      { id: 1, name: 'older', subject: 'A', body: '', created_at: '2026-05-01T00:00:00Z' },
    ]
    queueRows(stored)
    const res = await get('/api/templates')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(stored)
    // SQL contract: ORDER BY created_at DESC
    const sqlCall = calls.find(c => /SELECT \* FROM email_templates/.test(c.sql))
    expect(sqlCall?.sql).toMatch(/ORDER BY created_at DESC/)
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await get('/api/templates')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  GET /api/templates/ranking
// ═══════════════════════════════════════════════════════════════════════

describe('GET /api/templates/ranking', () => {
  it('200 with { ranking: [] } when primary query returns empty', async () => {
    queueRows([])
    const res = await get('/api/templates/ranking')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ranking: [] })
  })

  it('coerces reply_rate/open_rate strings (numeric type) to numbers', async () => {
    queueRows([
      { template_id: 1, name: 't1', campaigns_used: 2, total_sent: 100, reply_rate: '15.0', open_rate: '40.5' },
    ])
    const res = await get('/api/templates/ranking')
    expect(res.status).toBe(200)
    const body = res.body as { ranking: Array<{ reply_rate: number; open_rate: number }> }
    expect(typeof body.ranking[0].reply_rate).toBe('number')
    expect(typeof body.ranking[0].open_rate).toBe('number')
    expect(body.ranking[0].reply_rate).toBe(15)
    expect(body.ranking[0].open_rate).toBe(40.5)
  })

  it('falls back to degraded query when primary query throws (degraded=true)', async () => {
    queueError('relation send_events does not exist')
    queueRows([
      { template_id: 1, name: 'fallback', campaigns_used: 0, total_sent: 0, reply_rate: 0, open_rate: 0 },
    ])
    const res = await get('/api/templates/ranking')
    expect(res.status).toBe(200)
    const body = res.body as { ranking: unknown[]; degraded?: boolean }
    expect(body.degraded).toBe(true)
    expect(Array.isArray(body.ranking)).toBe(true)
    expect(body.ranking.length).toBe(1)
  })

  it('500 when both primary and fallback queries throw', async () => {
    queueError('boom-1')
    queueError('boom-2')
    const res = await get('/api/templates/ranking')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/templates
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/templates', () => {
  it('400 when name missing', async () => {
    const res = await send('POST', '/api/templates', { subject: 'x', body: 'y' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toMatch(/name required/)
  })

  it('400 when name is empty string', async () => {
    const res = await send('POST', '/api/templates', { name: '' })
    expect(res.status).toBe(400)
  })

  it('400 when name is non-string', async () => {
    const res = await send('POST', '/api/templates', { name: 123 })
    expect(res.status).toBe(400)
  })

  it('400 when body is empty (no content-type / no JSON)', async () => {
    const r = await fetch(baseUrl + '/api/templates', { method: 'POST' })
    expect(r.status).toBe(400)
  })

  it('200 returns inserted row when name provided', async () => {
    const inserted = { id: 42, name: 'welcome', subject: 'Hello', body: 'world', created_at: '2026-05-02T00:00:00Z' }
    // POST is now transactional (templates.js:167-178): BEGIN → INSERT RETURNING
    // → audit INSERT → COMMIT. This file's mock shifts the queue for every query
    // (BEGIN/COMMIT included), so feed a slot per step.
    queueRows([])          // BEGIN
    queueRows([inserted])  // INSERT ... RETURNING
    queueRows([])          // INSERT operator_audit_log
    queueRows([])          // COMMIT
    const res = await send('POST', '/api/templates', { name: 'welcome', subject: 'Hello', body: 'world' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(inserted)
    // SQL contract: INSERT now carries body_html as the 4th param (templates.js:169-171)
    const insertCall = calls.find(c => /INSERT INTO email_templates/.test(c.sql))
    expect(insertCall?.params).toEqual(['welcome', 'Hello', 'world', ''])
  })

  it('500 on pg throw with valid body', async () => {
    queueError('unique violation')
    const res = await send('POST', '/api/templates', { name: 'dup' })
    expect(res.status).toBe(500)
  })

  // ── AR2 short-URL gate (Fix 3) ────────────────────────────────────────
  // Mirrors Go ErrShortURL guard in features/outreach/campaigns/content/template.go.
  // Surfaces error at save-time rather than first-send to give operator
  // earlier feedback.

  it('400 short_url_in_body when POST body contains bit.ly URL', async () => {
    const res = await send('POST', '/api/templates', { name: 'bitly', body: 'Klikněte: https://bit.ly/abc123' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('short_url_in_body')
  })

  it('400 short_url_in_body when POST body contains t.co URL', async () => {
    const res = await send('POST', '/api/templates', { name: 'tco', body: 'Sdílíme: https://t.co/xyz789' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('short_url_in_body')
  })

  it('400 short_url_in_body — case-insensitive (BIT.LY uppercase)', async () => {
    const res = await send('POST', '/api/templates', { name: 'upper', body: 'Link: HTTPS://BIT.LY/abc' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('short_url_in_body')
  })

  it('200 when POST body contains full URL (not a short-URL service)', async () => {
    const inserted = { id: 99, name: 'full', subject: '', body: 'Navštivte https://garaaage.cz pro detaily.' }
    queueRows([inserted])  // BEGIN
    queueRows([inserted])  // INSERT RETURNING
    queueRows([])           // audit INSERT
    queueRows([])           // COMMIT
    const res = await send('POST', '/api/templates', { name: 'full', body: 'Navštivte https://garaaage.cz pro detaily.' })
    expect(res.status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  PUT /api/templates/:id
// ═══════════════════════════════════════════════════════════════════════

describe('PUT /api/templates/:id', () => {
  it('200 returns updated row', async () => {
    const updated = { id: 7, name: 'renamed', subject: 's', body: 'b', created_at: '2026-05-01T00:00:00Z' }
    // PUT is now transactional (templates.js:218-238): BEGIN → UPDATE RETURNING
    // → audit INSERT → COMMIT. Mock shifts the queue per query.
    queueRows([])         // BEGIN
    queueRows([updated])  // UPDATE ... RETURNING
    queueRows([])         // INSERT operator_audit_log
    queueRows([])         // COMMIT
    const res = await send('PUT', '/api/templates/7', { name: 'renamed', subject: 's', body: 'b' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(updated)
    const updateCall = calls.find(c => /UPDATE email_templates SET/.test(c.sql))
    expect(updateCall?.params).toEqual(['renamed', 's', 'b', '7'])
  })

  it('handles missing subject/body (name required, defaults rest to empty strings)', async () => {
    // PUT now requires a non-empty string name (templates.js:196-198) — a body
    // with no name 400s. Provide name; subject/body still default to ''.
    const updated = { id: 7, name: 'x', subject: '', body: '' }
    queueRows([])         // BEGIN
    queueRows([updated])  // UPDATE ... RETURNING
    queueRows([])         // INSERT operator_audit_log
    queueRows([])         // COMMIT
    const res = await send('PUT', '/api/templates/7', { name: 'x' })
    expect(res.status).toBe(200)
    const updateCall = calls.find(c => /UPDATE email_templates SET/.test(c.sql))
    // name='x', subject='', body='', id='7'
    expect(updateCall?.params?.[0]).toBe('x')
    expect(updateCall?.params?.[1]).toBe('')
    expect(updateCall?.params?.[2]).toBe('')
    expect(updateCall?.params?.[3]).toBe('7')
  })

  it('500 on pg throw', async () => {
    queueError('boom')
    const res = await send('PUT', '/api/templates/99', { name: 'x' })
    expect(res.status).toBe(500)
  })

  it('400 short_url_in_body when PUT body contains tinyurl.com', async () => {
    const res = await send('PUT', '/api/templates/7', { name: 'tiny', body: 'Více info: https://tinyurl.com/12345abcd' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('short_url_in_body')
  })

  it('400 short_url_in_body when PUT body contains multiple short URLs', async () => {
    const res = await send('PUT', '/api/templates/7', { name: 'multi', body: 'Link1: https://bit.ly/a, Link2: https://t.co/b' })
    expect(res.status).toBe(400)
    expect((res.body as { error: string }).error).toBe('short_url_in_body')
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  POST /api/templates/preview
// ═══════════════════════════════════════════════════════════════════════

describe('POST /api/templates/preview', () => {
  it('200 returns preview render result for valid subject+body', async () => {
    const res = await send('POST', '/api/templates/preview', {
      subject: 'Hello {{Firma}}',
      body: 'Dear {{Jmeno}}',
      sample: { Firma: 'Acme', Jmeno: 'Jan' },
    })
    expect(res.status).toBe(200)
    // renderTemplatePreview returns an object; locking minimal shape
    expect(res.body).toBeTypeOf('object')
    expect(res.body).not.toBeNull()
  })

  it('200 with empty body uses defaults (subject="", body="", sample={})', async () => {
    const res = await send('POST', '/api/templates/preview', {})
    expect(res.status).toBe(200)
    expect(res.body).toBeTypeOf('object')
  })

  it('does NOT touch the database (preview is pure)', async () => {
    const before = calls.length
    await send('POST', '/api/templates/preview', { subject: 's', body: 'b', sample: {} })
    // Preview should not issue any pool.query calls
    expect(calls.length).toBe(before)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  DELETE /api/templates/:id
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /api/templates/:id', () => {
  it('200 returns { ok: true } on success', async () => {
    // DELETE is now transactional (templates.js:264-292): BEGIN → pre-SELECT
    // existence/audit fetch → DELETE → audit INSERT → COMMIT. Feed the pre-SELECT
    // a row so the 404 branch is skipped; mock shifts the queue per query.
    queueRows([])                                   // BEGIN
    queueRows([{ id: 5, name: 'x', subject: 'y' }]) // pre-SELECT existence
    queueRows([])                                   // DELETE
    queueRows([])                                   // INSERT operator_audit_log
    queueRows([])                                   // COMMIT
    const res = await send('DELETE', '/api/templates/5')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const deleteCall = calls.find(c => /DELETE FROM email_templates WHERE id=\$1/.test(c.sql))
    expect(deleteCall?.params).toEqual(['5'])
  })

  it('500 on pg throw', async () => {
    queueError('foreign key violation')
    const res = await send('DELETE', '/api/templates/5')
    expect(res.status).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════
//  Routing invariants — Express ordering preserved from server.js
// ═══════════════════════════════════════════════════════════════════════

describe('Templates routing invariants', () => {
  it('GET /api/templates/ranking is NOT routed through PUT /:id pattern', async () => {
    // Sanity: ranking route should hit the ranking handler, not 404 / not :id
    queueRows([])
    const res = await get('/api/templates/ranking')
    expect(res.status).toBe(200)
    // Body is `{ ranking: [] }` not the row from email_templates
    expect(res.body).toEqual({ ranking: [] })
  })

  it('POST /api/templates/preview is NOT routed through POST /api/templates', async () => {
    // POST /api/templates would 400 on missing name; preview returns 200
    const res = await send('POST', '/api/templates/preview', {})
    expect(res.status).toBe(200)
  })
})
