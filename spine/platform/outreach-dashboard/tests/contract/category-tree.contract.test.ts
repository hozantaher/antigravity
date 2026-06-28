// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — /api/category-tree + /api/campaigns/:id/segment/apply
//
// Sprint 2026-05-12: pins the contract for the hierarchical segment picker.
//
// Strategy mirrors bff-segments.contract.test.ts:
//   - pg.Pool is mocked (no live DB)
//   - BFF booted via app.listen(0)
//   - Tests cover: GET children, POST select cascade, POST segment/apply
//
// Memory rules:
//   feedback_extreme_testing (T0) — ≥10 cases per surface
//   feedback_no_speculation  (T0) — every assertion derived from route body
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

// ── Mock pg ──────────────────────────────────────────────────────────────────
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

// ── Boot BFF ─────────────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function q(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function qErr(msg: string) {
  queryQueue.push(new Error(msg))
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

// ── Sample fixtures ───────────────────────────────────────────────────────────
const L1_NODE = {
  path: 'Stavebnictvi',
  label: 'Stavebnictví',
  level: 1,
  contacts_direct: 12,
  contacts_subtree: 450,
  included: null,
  has_children: true,
}
const L2_NODE = {
  path: 'Stavebnictvi > Pozemni-stavby',
  label: 'Pozemní stavby',
  level: 2,
  contacts_direct: 80,
  contacts_subtree: 210,
  included: true,
  has_children: false,
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/category-tree — root nodes (no parent param)
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/category-tree — L1 roots', () => {
  it('returns array of root nodes', async () => {
    q([L1_NODE])
    const { status, body } = await req('GET', '/api/category-tree')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const arr = body as typeof L1_NODE[]
    expect(arr[0].path).toBe('Stavebnictvi')
    expect(arr[0].has_children).toBe(true)
  })

  it('returns empty array when no categories', async () => {
    q([])
    const { status, body } = await req('GET', '/api/category-tree')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('includes contacts_subtree in each node', async () => {
    q([L1_NODE])
    const { body } = await req('GET', '/api/category-tree')
    const arr = body as typeof L1_NODE[]
    expect(arr[0].contacts_subtree).toBe(450)
  })

  it('500 on db error', async () => {
    qErr('db down')
    const { status } = await req('GET', '/api/category-tree')
    expect(status).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// GET /api/category-tree?parent=<path> — children of a node
// ════════════════════════════════════════════════════════════════════════════

describe('GET /api/category-tree?parent=<path> — children', () => {
  it('returns children of the given parent', async () => {
    q([L2_NODE])
    const { status, body } = await req('GET', '/api/category-tree?parent=Stavebnictvi')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const arr = body as typeof L2_NODE[]
    expect(arr[0].path).toBe('Stavebnictvi > Pozemni-stavby')
    expect(arr[0].has_children).toBe(false)
  })

  it('passes parent param to SQL as $1', async () => {
    q([L2_NODE])
    await req('GET', '/api/category-tree?parent=Stavebnictvi')
    const call = calls.find(c => c.sql.includes('parent_path'))
    expect(call).toBeDefined()
    expect(call!.params).toContain('Stavebnictvi')
  })

  it('returns empty when parent has no children', async () => {
    q([])
    const { status, body } = await req('GET', '/api/category-tree?parent=Leaf')
    expect(status).toBe(200)
    expect(body).toEqual([])
  })

  it('500 on db error with parent param', async () => {
    qErr('timeout')
    const { status } = await req('GET', '/api/category-tree?parent=X')
    expect(status).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /api/category-tree/select — include/exclude with cascade
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/category-tree/select', () => {
  it('400 when paths is missing', async () => {
    const { status } = await req('POST', '/api/category-tree/select', { action: 'include' })
    expect(status).toBe(400)
  })

  it('400 when paths is empty array', async () => {
    const { status } = await req('POST', '/api/category-tree/select', { paths: [], action: 'include' })
    expect(status).toBe(400)
  })

  it('400 when action is invalid', async () => {
    const { status } = await req('POST', '/api/category-tree/select', { paths: ['X'], action: 'toggle' })
    expect(status).toBe(400)
  })

  it('returns ok=true with updated list on include', async () => {
    // BEGIN, UPDATE direct paths, UPDATE descendants (recursive CTE), COMMIT
    q([])                                              // BEGIN
    q([])                                              // UPDATE direct
    q([])                                              // UPDATE descendants
    q([])                                              // COMMIT
    // final SELECT for response
    q([{ path: 'Stavebnictvi', included: true }])
    const { status, body } = await req('POST', '/api/category-tree/select', {
      paths: ['Stavebnictvi'],
      action: 'include',
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; updated: { path: string; included: boolean }[] }
    expect(b.ok).toBe(true)
    expect(Array.isArray(b.updated)).toBe(true)
  })

  it('sets included=false on exclude action', async () => {
    q([])   // BEGIN
    q([])   // UPDATE direct
    q([])   // UPDATE descendants
    q([])   // COMMIT
    q([{ path: 'A', included: false }])  // SELECT for response
    await req('POST', '/api/category-tree/select', { paths: ['A'], action: 'exclude' })
    // The UPDATE SQL should carry the correct boolean
    const updateCall = calls.find(c => c.sql.includes('SET included =') && Array.isArray(c.params))
    expect(updateCall).toBeDefined()
    expect(updateCall!.params![0]).toBe(false)
  })

  it('fires recursive CTE for descendant cascade', async () => {
    q([])
    q([])
    q([])
    q([])
    q([])
    await req('POST', '/api/category-tree/select', { paths: ['Root'], action: 'include' })
    const cteCall = calls.find(c => c.sql.includes('WITH RECURSIVE'))
    expect(cteCall).toBeDefined()
  })

  it('500 on db error rolls back', async () => {
    q([])          // BEGIN
    qErr('lock')   // UPDATE throws
    // ROLLBACK consumed from empty queue → {}
    const { status } = await req('POST', '/api/category-tree/select', {
      paths: ['X'],
      action: 'include',
    })
    expect(status).toBe(500)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// POST /api/campaigns/:id/segment/apply
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/campaigns/:id/segment/apply', () => {
  it('400 on non-numeric campaign id', async () => {
    const { status } = await req('POST', '/api/campaigns/abc/segment/apply', { source: 'category_tree' })
    expect(status).toBe(400)
  })

  it('400 when source is not category_tree', async () => {
    const { status } = await req('POST', '/api/campaigns/1/segment/apply', { source: 'other' })
    expect(status).toBe(400)
  })

  it('404 when campaign not found', async () => {
    q([])  // BEGIN
    q([])  // SELECT campaign — empty
    // ROLLBACK consumed
    const { status } = await req('POST', '/api/campaigns/9999/segment/apply', { source: 'category_tree' })
    expect(status).toBe(404)
  })

  it('returns enrolled/removed/generated_at on success (no included paths)', async () => {
    // New diff-based apply (no blanket wipe + re-insert): BEGIN, SELECT campaign,
    // SELECT included paths (empty), DELETE-prune of PRISTINE rows RETURNING cc.id
    // (removed = #rows pruned, not a COUNT), no enroll INSERT (no included paths),
    // UPDATE category_paths, operator_audit_log INSERT (same tx), COMMIT.
    q([])                                                       // BEGIN
    q([{ id: 1, name: 'Test', status: 'paused' }])              // SELECT campaign
    q([])                                                       // SELECT included paths → empty
    q([{ id: 501 }, { id: 502 }, { id: 503 }, { id: 504 },
       { id: 505 }, { id: 506 }, { id: 507 }])                  // DELETE prune → 7 pristine rows
    // No enroll INSERT since no included paths
    q([])                                                       // UPDATE campaigns.category_paths
    q([])                                                       // INSERT operator_audit_log
    q([])                                                       // COMMIT
    const { status, body } = await req('POST', '/api/campaigns/1/segment/apply', {
      source: 'category_tree',
    })
    expect(status).toBe(200)
    const b = body as { ok: boolean; enrolled: number; removed: number; generated_at: string }
    expect(b.ok).toBe(true)
    expect(b.enrolled).toBe(0)
    expect(b.removed).toBe(7)
    expect(typeof b.generated_at).toBe('string')

    // Prune DELETE must only target PRISTINE rows — in-flight/sent rows
    // (status != 'pending' OR current_step > 0) are NEVER deleted.
    const deleteCall = calls.find(c => c.sql.includes('DELETE FROM campaign_contacts'))
    expect(deleteCall).toBeDefined()
    expect(deleteCall!.sql).toContain("status = 'pending'")
    expect(deleteCall!.sql).toContain('current_step = 0')

    // Audit row written in the SAME transaction (feedback_audit_log_on_mutations).
    const auditCall = calls.find(
      c => c.sql.includes('operator_audit_log') && c.sql.includes('campaign_segment_apply'),
    )
    expect(auditCall).toBeDefined()
  })

  it('returns enrolled count from INSERT rows', async () => {
    q([])                                                       // BEGIN
    q([{ id: 2, name: 'Camp', status: 'paused' }])              // SELECT campaign
    q([{ path: 'Stavebnictvi' }])                               // SELECT included paths
    q([{ id: 71 }, { id: 72 }, { id: 73 }])                     // DELETE prune → 3 pristine rows
    q([{ id: 10 }, { id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }]) // enroll INSERT → 5 rows
    q([])                                                       // UPDATE category_paths
    q([])                                                       // INSERT operator_audit_log
    q([])                                                       // COMMIT
    const { status, body } = await req('POST', '/api/campaigns/2/segment/apply', {
      source: 'category_tree',
    })
    expect(status).toBe(200)
    const b = body as { enrolled: number; removed: number }
    expect(b.enrolled).toBe(5)
    expect(b.removed).toBe(3)

    // Enroll INSERT is a DISTINCT newly-matched contact set filtered against
    // BOTH suppression tables (outreach_suppressions ∪ suppression_list) —
    // not a blanket re-insert of everyone.
    const insertCall = calls.find(
      c => c.sql.includes('INSERT INTO campaign_contacts') && c.sql.includes('SELECT DISTINCT'),
    )
    expect(insertCall).toBeDefined()
    expect(insertCall!.sql).toContain('outreach_suppressions')
    expect(insertCall!.sql).toContain('suppression_list')
  })

  it('updates campaigns.category_paths to included paths', async () => {
    q([])                                                       // BEGIN
    q([{ id: 3, name: 'C', status: 'paused' }])                 // SELECT campaign
    q([{ path: 'Remesla' }, { path: 'Remesla > Opravari' }])    // SELECT included paths
    q([])                                                       // DELETE prune → none
    q([{ id: 20 }])                                             // enroll INSERT → 1 row
    q([])                                                       // UPDATE category_paths
    q([])                                                       // INSERT operator_audit_log
    q([])                                                       // COMMIT
    await req('POST', '/api/campaigns/3/segment/apply', { source: 'category_tree' })
    const updateCall = calls.find(c => c.sql.includes('category_paths') && c.sql.includes('UPDATE campaigns'))
    expect(updateCall).toBeDefined()
  })

  it('500 on db error rolls back', async () => {
    q([])               // BEGIN
    qErr('fail')        // SELECT campaign throws
    // ROLLBACK
    const { status } = await req('POST', '/api/campaigns/1/segment/apply', {
      source: 'category_tree',
    })
    expect(status).toBe(500)
  })
})
