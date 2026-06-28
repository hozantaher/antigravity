// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — PATCH /api/campaigns/:id  (config edit — campaign editor)
//
//  Covers the extended PATCH handler: partial update of name / description /
//  category_paths / category_match / staircase_max_per_step, with:
//   - shape validation (400 validation_failed)
//   - running-edit policy (412 campaign_running on structural fields)
//   - ?force=1 override
//   - operator_audit_log INSERT (campaign_config_update) with prev/next diff
//   - JSON-string binding for category_paths (TEXT) + ::jsonb staircase
//
//  Mock note: the handler runs inside a tx (pool.connect() → client). The Pool
//  mock therefore exposes connect() returning a Client that shares the same
//  queryQueue as pool.query (runPreflight uses pool.query). BEGIN/COMMIT/
//  ROLLBACK do NOT consume the row queue.
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

const isTxControl = (sql: string) => /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)
function runQuery(sql: string, params?: unknown[]) {
  calls.push({ sql, params })
  if (isTxControl(sql)) return { rows: [], rowCount: 0 }
  if (!queryQueue.length) return { rows: [], rowCount: 0 }
  const next = queryQueue.shift()!
  if (next instanceof Error) throw next
  return next
}

vi.mock('pg', () => {
  class Client {
    async query(sql: string, params?: unknown[]) { return runQuery(sql, params) }
    release() {}
  }
  class Pool {
    async query(sql: string, params?: unknown[]) { return runQuery(sql, params) }
    async connect() { return new Client() }
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
  const mod = await import('../../server.js')
  delete process.env.GO_SERVER_URL
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
  calls.length = 0
})

function queue(...outcomes: QueryOutcome[]) { queryQueue.push(...outcomes) }
function row(over: Record<string, unknown> = {}) {
  return {
    id: 5, name: 'Kampaň A', description: 'popis', status: 'paused',
    category_paths: '["machinery"]', category_match: 'prefix',
    staircase_max_per_step: [1, 5, 20, 100],
    created_at: '2026-06-01T00:00:00Z', updated_at: null,
    ...over,
  }
}
async function patch(id: string | number, body: unknown, query = '') {
  const r = await fetch(`${baseUrl}/api/campaigns/${id}${query}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json as Record<string, unknown> }
}
const findUpdate = () => calls.find(c => /UPDATE campaigns SET/i.test(c.sql))
// The audit action is embedded in the SQL VALUES('<action>', ...) literal,
// not in params (params hold entity_id + details JSON).
const findAudit = (action: string) =>
  calls.find(c => /INSERT INTO operator_audit_log/i.test(c.sql) && c.sql.includes(action))

// ─────────────────────────────────────────────────────────────────────────
//  Validation (400)
// ─────────────────────────────────────────────────────────────────────────
describe('PATCH /api/campaigns/:id — validation', () => {
  it('400 when name too short', async () => {
    const res = await patch(5, { name: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('validation_failed')
    expect(res.body.field).toBe('name')
  })
  it('400 when name too long (>120)', async () => {
    const res = await patch(5, { name: 'a'.repeat(121) })
    expect(res.status).toBe(400)
    expect(res.body.field).toBe('name')
  })
  it('400 when name not a string', async () => {
    const res = await patch(5, { name: 42 })
    expect(res.status).toBe(400)
  })
  it('400 when description not string/null', async () => {
    const res = await patch(5, { description: 99 })
    expect(res.status).toBe(400)
    expect(res.body.field).toBe('description')
  })
  it('400 when category_match invalid', async () => {
    const res = await patch(5, { category_match: 'fuzzy' })
    expect(res.status).toBe(400)
    expect(res.body.field).toBe('category_match')
  })
  it('400 when category_paths not an array', async () => {
    const res = await patch(5, { category_paths: 'machinery' })
    expect(res.status).toBe(400)
    expect(res.body.field).toBe('category_paths')
  })
  it('400 when a category path is not a string', async () => {
    const res = await patch(5, { category_paths: ['ok', 7] })
    expect(res.status).toBe(400)
  })
  it('400 when staircase not an array', async () => {
    const res = await patch(5, { staircase_max_per_step: 5 })
    expect(res.status).toBe(400)
    expect(res.body.field).toBe('staircase_max_per_step')
  })
  it('400 when staircase empty', async () => {
    const res = await patch(5, { staircase_max_per_step: [] })
    expect(res.status).toBe(400)
  })
  it('400 when staircase has a non-integer', async () => {
    const res = await patch(5, { staircase_max_per_step: [1, 5, 2.5] })
    expect(res.status).toBe(400)
  })
  it('400 when staircase has a negative value', async () => {
    const res = await patch(5, { staircase_max_per_step: [1, -5] })
    expect(res.status).toBe(400)
  })
  it('validation runs before any DB query', async () => {
    await patch(5, { name: 'x' })
    expect(calls.length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────
//  Success — partial update + binding + audit
// ─────────────────────────────────────────────────────────────────────────
describe('PATCH /api/campaigns/:id — config update success', () => {
  it('200 updating name only; does not clobber status', async () => {
    queue({ rows: [row()] }, { rows: [row({ name: 'Nový název' })] })
    const res = await patch(5, { name: 'Nový název' })
    expect(res.status).toBe(200)
    const upd = findUpdate()!
    expect(upd.sql).toMatch(/name=\$1/)
    expect(upd.sql).not.toMatch(/status=/)        // status untouched
    expect(upd.params).toEqual(['Nový název', '5'])
  })

  it('stores category_paths as a JSON string (TEXT column)', async () => {
    queue({ rows: [row()] }, { rows: [row()] })
    await patch(5, { category_paths: ['machinery', 'cranes', 'machinery'] })
    const upd = findUpdate()!
    // dedupe → ["machinery","cranes"]; bound as JSON string
    expect(upd.params![0]).toBe('["machinery","cranes"]')
  })

  it('binds staircase via ::jsonb with a JSON string', async () => {
    queue({ rows: [row()] }, { rows: [row()] })
    await patch(5, { staircase_max_per_step: [1, 5, 20] })
    const upd = findUpdate()!
    expect(upd.sql).toMatch(/staircase_max_per_step=\$1::jsonb/)
    expect(upd.params![0]).toBe('[1,5,20]')
  })

  it('writes campaign_config_update audit with prev/next diff', async () => {
    queue({ rows: [row({ name: 'Staré' })] }, { rows: [row({ name: 'Nové' })] })
    await patch(5, { name: 'Nové' })
    const audit = findAudit('campaign_config_update')
    expect(audit).toBeDefined()
    const details = JSON.parse((audit!.params as string[])[1])
    expect(details.prev.name).toBe('Staré')
    expect(details.next.name).toBe('Nové')
  })

  it('no-op (empty body) returns current row without an UPDATE', async () => {
    queue({ rows: [row({ id: 5, name: 'Beze změny' })] })
    const res = await patch(5, {})
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Beze změny')
    expect(findUpdate()).toBeUndefined()
  })

  it('404 when campaign missing', async () => {
    // SELECT campBefore returns empty
    const res = await patch(9999, { name: 'Cokoliv' })
    expect(res.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────
//  Running-edit policy
// ─────────────────────────────────────────────────────────────────────────
describe('PATCH /api/campaigns/:id — running-edit policy', () => {
  it('412 on structural edit (audience) while running', async () => {
    queue({ rows: [row({ status: 'running' })] })
    const res = await patch(5, { category_paths: ['machinery'] })
    expect(res.status).toBe(412)
    expect(res.body.error).toBe('campaign_running')
    expect(findUpdate()).toBeUndefined()
  })

  it('412 on staircase edit while active', async () => {
    queue({ rows: [row({ status: 'active' })] })
    const res = await patch(5, { staircase_max_per_step: [1, 5] })
    expect(res.status).toBe(412)
  })

  it('?force=1 overrides the running guard', async () => {
    queue({ rows: [row({ status: 'running' })] }, { rows: [row({ status: 'running' })] })
    const res = await patch(5, { category_paths: ['machinery'] }, '?force=1')
    expect(res.status).toBe(200)
    expect(findUpdate()).toBeDefined()
  })

  it('name/description (non-structural) allowed while running', async () => {
    queue({ rows: [row({ status: 'running' })] }, { rows: [row({ status: 'running' })] })
    const res = await patch(5, { name: 'Změna za běhu' })
    expect(res.status).toBe(200)
  })
})

// ─────────────────────────────────────────────────────────────────────────
//  Status path preserved (regression)
// ─────────────────────────────────────────────────────────────────────────
describe('PATCH /api/campaigns/:id — status path', () => {
  it('pausing a campaign still works (200) without preflight', async () => {
    queue({ rows: [row({ status: 'running' })] }, { rows: [row({ status: 'paused' })] })
    const res = await patch(5, { status: 'paused' })
    expect(res.status).toBe(200)
    const sql = calls.map(c => c.sql).join(' | ')
    expect(sql).not.toMatch(/FROM outreach_mailboxes/) // no preflight on pause
  })

  it('launch via ?force=1 skips preflight and writes campaign_activate audit', async () => {
    queue({ rows: [row({ status: 'paused' })] }, { rows: [row({ status: 'running' })] })
    const res = await patch(5, { status: 'running' }, '?force=1')
    expect(res.status).toBe(200)
    expect(findAudit('campaign_activate')).toBeDefined()
  })
})
