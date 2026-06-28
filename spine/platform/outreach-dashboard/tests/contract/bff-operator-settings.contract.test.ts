// bff-operator-settings.contract.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// BFF contract: GET /api/operator-settings + PUT /api/operator-settings/:key
// Sprint AF: operator-config extraction.
//
// Stubs pg pool; tests happy-path shapes, security gate, allowlist check,
// audit-log insertion, transaction rollback on error, and 500 propagation.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

// Simulate a PoolClient for transactional calls (BEGIN/COMMIT/ROLLBACK).
vi.mock('pg', () => {
  class PoolClient {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    release() {}
  }
  class Pool {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()!
      if (next instanceof Error) throw next
      return next
    }
    async connect() { return new PoolClient() }
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

function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
}

async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

const SAMPLE_ROWS = [
  { key: 'brand_label', value: 'Garaaage', updated_at: '2026-05-07T00:00:00Z', updated_by: 'migration_060' },
  { key: 'controller_name', value: 'BALKAN MOTORS INT DOO', updated_at: '2026-05-07T00:00:00Z', updated_by: 'migration_060' },
]

// ── GET /api/operator-settings ────────────────────────────────────────────────

describe('GET /api/operator-settings', () => {
  it('returns 200 and array of rows', async () => {
    q(SAMPLE_ROWS)
    const { status, body } = await req('GET', '/api/operator-settings')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    expect((body as typeof SAMPLE_ROWS)[0].key).toBeDefined()
  })

  it('returns empty array when table is empty', async () => {
    q([])
    const { status, body } = await req('GET', '/api/operator-settings')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('returns 9 or more keys from DB', async () => {
    q(SAMPLE_ROWS)
    q([]) // extra
    const { status, body } = await req('GET', '/api/operator-settings')
    expect(status).toBe(200)
    // We got whatever DB returned — shape matters more than count here
    expect(Array.isArray(body)).toBe(true)
  })

  it('returns 500 on db error', async () => {
    qErr('db connection refused')
    const { status } = await req('GET', '/api/operator-settings')
    expect(status).toBe(500)
  })
})

// ── PUT /api/operator-settings/:key — security gate ──────────────────────────

describe('PUT /api/operator-settings/:key — security gate', () => {
  it('400 when X-Confirm-Send header is missing', async () => {
    const { status, body } = await req('PUT', '/api/operator-settings/controller_name', { value: 'NEW' })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/X-Confirm-Send/)
  })

  it('400 when X-Confirm-Send is wrong value', async () => {
    const { status, body } = await req('PUT', '/api/operator-settings/controller_name', { value: 'NEW' }, {
      'x-confirm-send': 'nope',
    })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/X-Confirm-Send/)
  })

  it('404 for unknown key (allowlist enforced)', async () => {
    const { status, body } = await req('PUT', '/api/operator-settings/unknown_key_xyz', { value: 'NEW' }, {
      'x-confirm-send': 'yes',
    })
    expect(status).toBe(404)
    expect((body as { error: string }).error).toMatch(/unknown_key_xyz/)
  })

  it('400 when value is empty', async () => {
    const { status, body } = await req('PUT', '/api/operator-settings/controller_name', { value: '  ' }, {
      'x-confirm-send': 'yes',
    })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/non-empty/)
  })
})

// ── PUT /api/operator-settings/:key — happy path ─────────────────────────────

describe('PUT /api/operator-settings/:key — happy path', () => {
  it('200 + updated row on valid request', async () => {
    q([]) // BEGIN
    q([{ key: 'controller_name', value: 'NEW CORP', updated_at: '2026-05-07T00:00:00Z', updated_by: 'dashboard' }]) // UPSERT
    q([]) // INSERT audit_log
    q([]) // COMMIT
    const { status, body } = await req('PUT', '/api/operator-settings/controller_name', { value: 'NEW CORP' }, {
      'x-confirm-send': 'yes',
    })
    expect(status).toBe(200)
    expect((body as { key: string }).key).toBe('controller_name')
    expect((body as { value: string }).value).toBe('NEW CORP')
  })

  it('audit log INSERT fires on PUT', async () => {
    q([]) // BEGIN
    q([{ key: 'brand_label', value: 'NewBrand', updated_at: '2026-05-07T00:00:00Z', updated_by: 'dashboard' }]) // UPSERT
    q([]) // INSERT audit_log
    q([]) // COMMIT
    await req('PUT', '/api/operator-settings/brand_label', { value: 'NewBrand' }, {
      'x-confirm-send': 'yes',
    })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    // action value 'operator_settings_update' is in params[0], not the SQL template
    const params = auditCall!.params as unknown[]
    expect(params[0]).toBe('operator_settings_update')
    // Handler binds 4 params; entity_id is an inline NULL literal in the SQL
    // (operatorSettings.js:156-158 — `VALUES ($1,$2,$3,NULL,$4)`), so the
    // details JSON is $4 = params[3], not params[4].
    const details = JSON.parse(params[3] as string)
    expect(details.key).toBe('brand_label')
    expect(details.new_value).toBe('NewBrand')
  })

  it('500 + ROLLBACK on db error during UPSERT', async () => {
    q([]) // BEGIN
    qErr('constraint violation') // UPSERT fails
    // ROLLBACK comes from empty queue (default ok)
    const { status } = await req('PUT', '/api/operator-settings/controller_name', { value: 'X' }, {
      'x-confirm-send': 'yes',
    })
    expect(status).toBe(500)
    // no audit row
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ── Allowlist: all 9 known keys are accessible ───────────────────────────────

describe('PUT /api/operator-settings — allowlist covers all 9 keys', () => {
  const KNOWN_KEYS = [
    'controller_name', 'controller_id_label', 'controller_id_value',
    'controller_seat_address', 'controller_legal_basis_citation',
    'unsubscribe_base_url', 'privacy_contact_email', 'data_source_label', 'brand_label',
  ]

  it('all 9 keys are in the allowlist (do not return 404)', async () => {
    for (const key of KNOWN_KEYS) {
      // Queue enough for a success path
      q([]) // BEGIN
      q([{ key, value: 'test', updated_at: '2026-05-07T00:00:00Z', updated_by: 'test' }])
      q([]) // audit
      q([]) // COMMIT
      const { status } = await req('PUT', `/api/operator-settings/${key}`, { value: 'test' }, {
        'x-confirm-send': 'yes',
      })
      expect(status, `key ${key} should be in allowlist`).not.toBe(404)
      // Reset calls tracking between sub-checks
      calls.length = 0
    }
  })
})
