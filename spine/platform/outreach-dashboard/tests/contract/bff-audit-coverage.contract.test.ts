// ═══════════════════════════════════════════════════════════════════════════
//  Sprint Z1 — BFF audit coverage contract tests
//
//  Two concerns:
//  1. Source-level ratchet: every src/server-routes/*.js file that has a
//     mutation (UPDATE / INSERT INTO / DELETE FROM) MUST also reference
//     operator_audit_log. Files without mutations are exempt.
//
//  2. Behavioural contract: endpoints fixed in Z1 (bulkPassword, protections
//     alert ack, scoring config, segments create) produce the correct audit
//     log rows with correct action/entity_type/details and WITHOUT PII.
//
//  No credentials/passwords appear in any fixture (per feedback_no_pii_in_commands).
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AddressInfo } from 'net'

// ─── Source-level ratchet ──────────────────────────────────────────────────

const SERVER_ROUTES_DIR = path.resolve(
  __dirname,
  '../../src/server-routes'
)

// Files known to be read-only or intentionally not audited (diagnostics,
// read-only probes, etc.). Update this list only when adding a new route
// whose mutations are provably non-critical (e.g., ephemeral internal state).
const AUDIT_EXEMPT: string[] = [
  'health.js',          // mostly reads; boot-time write to internal state, not DB
]

const MUTATION_PATTERN = /\b(UPDATE |INSERT INTO |DELETE FROM )/i
const AUDIT_PATTERN = /operator_audit_log/i

describe('source-level ratchet — every mutating route must reference operator_audit_log', () => {
  let routeFiles: string[]

  beforeAll(() => {
    routeFiles = fs.readdirSync(SERVER_ROUTES_DIR)
      .filter(f => f.endsWith('.js'))
      .sort()
  })

  it('server-routes directory exists and has at least 10 route files', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(10)
  })

  it('known gap files are fixed: bulkPassword.js has operator_audit_log', () => {
    const src = fs.readFileSync(path.join(SERVER_ROUTES_DIR, 'bulkPassword.js'), 'utf-8')
    expect(AUDIT_PATTERN.test(src)).toBe(true)
  })

  it('known gap files are fixed: protections.js has operator_audit_log', () => {
    const src = fs.readFileSync(path.join(SERVER_ROUTES_DIR, 'protections.js'), 'utf-8')
    expect(AUDIT_PATTERN.test(src)).toBe(true)
  })

  it('known gap files are fixed: scoring.js has operator_audit_log', () => {
    const src = fs.readFileSync(path.join(SERVER_ROUTES_DIR, 'scoring.js'), 'utf-8')
    expect(AUDIT_PATTERN.test(src)).toBe(true)
  })

  it('known gap files are fixed: segments.js has operator_audit_log', () => {
    const src = fs.readFileSync(path.join(SERVER_ROUTES_DIR, 'segments.js'), 'utf-8')
    expect(AUDIT_PATTERN.test(src)).toBe(true)
  })

  // Dynamic per-file ratchet
  for (const file of [
    'bulkPassword.js',
    'campaigns.js',
    'companies.js',
    'contacts.js',
    'crm.js',
    'dsr.js',
    'mailboxes.js',
    'protections.js',
    'scoring.js',
    'segments.js',
    'suppression.js',
    'templates.js',
    'unsubscribe.js',
  ]) {
    it(`${file}: if mutations exist → operator_audit_log must exist`, () => {
      const src = fs.readFileSync(path.join(SERVER_ROUTES_DIR, file), 'utf-8')
      const hasMutation = MUTATION_PATTERN.test(src)
      const hasAudit = AUDIT_PATTERN.test(src)
      if (hasMutation) {
        expect(hasAudit).toBe(
          true,
          `${file} has mutations (UPDATE/INSERT/DELETE) but no operator_audit_log INSERT`
        )
      }
    })
  }
})

// ─── Behavioural contract (mock pool + BFF boot) ──────────────────────────

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

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
  for (const k of ['BFF_AUTH_DISABLED', 'BFF_IMPORT_ONLY', 'DATABASE_URL', 'EMAIL_VERIFY_SMTP']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.DATABASE_URL = 'postgres://stub/stub'
  process.env.EMAIL_VERIFY_SMTP = '0'
  vi.resetModules()
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

function q(...outcomes: QueryOutcome[]) { queryQueue.push(...outcomes) }

async function api(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(`${baseUrl}${path}`, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json, text }
}

// ── bulkPassword endpoint ──────────────────────────────────────────────────

describe('POST /api/mailboxes/bulk-set-password — audit invariants', () => {
  it('Z1-1: successful UPDATE emits audit log row', async () => {
    q({ rows: [] }, { rows: [{ id: 10, email: 'mb10@redacted' }] }, { rows: [] }, { rows: [] })
    await api('POST', '/api/mailboxes/bulk-set-password', { rows: [{ id: 10, password: 'Validp@ss11' }] })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall!.sql).toContain('mailbox_bulk_password_update')
    expect(auditCall!.sql).toContain('outreach_mailbox')
  })

  it('Z1-2: audit details NEVER contain password value (PII guard)', async () => {
    q({ rows: [] }, { rows: [{ id: 10, email: 'mb10@redacted' }] }, { rows: [] }, { rows: [] })
    await api('POST', '/api/mailboxes/bulk-set-password', { rows: [{ id: 10, password: 'PiiSens!tive99' }] })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    const detailStr = JSON.stringify(auditCall!.params)
    expect(detailStr).not.toContain('PiiSens!tive99')
    expect(detailStr).toContain('rotated_at')
    expect(detailStr).toContain('field')
  })

  it('Z1-3: audit entity_id is the mailbox id (string)', async () => {
    q({ rows: [] }, { rows: [{ id: 42, email: 'mb42@redacted' }] }, { rows: [] }, { rows: [] })
    await api('POST', '/api/mailboxes/bulk-set-password', { rows: [{ id: 42, password: 'Validp@ss22' }] })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    // SQL: VALUES ('mailbox_bulk_password_update', 'dashboard', 'outreach_mailbox', $1, $2)
    // params: [entity_id, details_json]
    expect(auditCall!.params![0]).toBe('42')
  })

  it('Z1-4: not-found row → ROLLBACK → no audit row emitted', async () => {
    q({ rows: [] }, { rows: [] })  // BEGIN + UPDATE returns empty
    const { body } = await api('POST', '/api/mailboxes/bulk-set-password', {
      rows: [{ id: 9999, password: 'Validp@ss33' }]
    })
    expect((body as { errors: unknown[] }).errors.length).toBe(1)
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })

  it('Z1-5: DB error mid-UPDATE → ROLLBACK → no audit row, row error returned', async () => {
    q({ rows: [] }, new Error('db timeout'))  // BEGIN + UPDATE throws
    const { body } = await api('POST', '/api/mailboxes/bulk-set-password', {
      rows: [{ id: 1, password: 'Validp@ss44' }]
    })
    expect((body as { updated: number }).updated).toBe(0)
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ── protections alert ack ──────────────────────────────────────────────────

describe('POST /api/protections/alerts/:id/ack — audit invariants', () => {
  it('Z1-6: successful ack emits audit log with correct action', async () => {
    q({ rows: [] }, { rows: [], rowCount: 1 }, { rows: [] }, { rows: [] })
    await api('POST', '/api/protections/alerts/77/ack')
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall!.sql).toContain('protection_alert_ack')
    expect(auditCall!.sql).toContain('protection_alert')
  })

  it('Z1-7: ack audit entity_id matches the alert id', async () => {
    q({ rows: [] }, { rows: [], rowCount: 1 }, { rows: [] }, { rows: [] })
    await api('POST', '/api/protections/alerts/99/ack')
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    // SQL: VALUES ('protection_alert_ack', 'dashboard', 'protection_alert', $1, $2)
    // params: [entity_id, details_json]
    expect(auditCall!.params![0]).toBe('99')
  })

  it('Z1-8: not-found ack → ROLLBACK → no audit row, 404 returned', async () => {
    q({ rows: [] }, { rows: [], rowCount: 0 })  // BEGIN + UPDATE finds nothing
    const { status } = await api('POST', '/api/protections/alerts/9999/ack')
    expect(status).toBe(404)
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})

// ── scoring config update ──────────────────────────────────────────────────

describe('PUT /api/scoring/config — audit invariants', () => {
  it('Z1-9: config update emits audit log with scoring_config_update', async () => {
    // BEGIN → UPDATE → audit INSERT → COMMIT → SELECT (return current)
    q({ rows: [] }, { rows: [], rowCount: 1 }, { rows: [] }, { rows: [] },
      { rows: [{ weights: { icp_weight: 50 }, version: 2, updated_at: new Date().toISOString() }] })
    await api('PUT', '/api/scoring/config', { weights: { icp_weight: 50 } })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall!.sql).toContain('scoring_config_update')
    expect(auditCall!.sql).toContain('scoring_config')
  })

  it('Z1-10: audit details include keys_updated list', async () => {
    q({ rows: [] }, { rows: [], rowCount: 1 }, { rows: [] }, { rows: [] },
      { rows: [{ weights: {}, version: 3, updated_at: new Date().toISOString() }] })
    await api('PUT', '/api/scoring/config', { weights: { icp_weight: 30, recency_weight: 20 } })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    const detail = JSON.parse(auditCall!.params![0] as string)
    expect(Array.isArray(detail.keys_updated)).toBe(true)
    expect(detail.keys_updated.length).toBeGreaterThan(0)
  })
})

// ── segments create ────────────────────────────────────────────────────────

describe('POST /api/segments — audit invariants', () => {
  it('Z1-11: segment create emits audit log with segment_create', async () => {
    q({ rows: [] }, { rows: [{ id: 5, name: 'Test', description: null, query: {}, company_count: 0, created_at: '' }] },
      { rows: [] }, { rows: [] })
    await api('POST', '/api/segments', { name: 'Test', description: null, query: {} })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    expect(auditCall!.sql).toContain('segment_create')
    expect(auditCall!.sql).toContain("'segment'")
  })

  it('Z1-12: segment audit entity_id matches the new segment id', async () => {
    q({ rows: [] }, { rows: [{ id: 77, name: 'Segment77', description: null, query: {}, company_count: 0, created_at: '' }] },
      { rows: [] }, { rows: [] })
    await api('POST', '/api/segments', { name: 'Segment77', description: null, query: {} })
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    // SQL: VALUES ('segment_create', 'dashboard', 'segment', $1, $2)
    // params: [entity_id, details_json]
    expect(auditCall!.params![0]).toBe('77')
  })

  it('Z1-13: segment create DB error → ROLLBACK → no audit row, 500 returned', async () => {
    q({ rows: [] }, new Error('constraint violation'))  // BEGIN + INSERT throws
    const { status } = await api('POST', '/api/segments', { name: 'Bad' })
    expect(status).toBe(500)
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeUndefined()
  })
})
