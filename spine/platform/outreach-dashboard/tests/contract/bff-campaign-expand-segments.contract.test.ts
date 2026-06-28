// AJ10b (#1398) — BFF contract: POST /api/campaigns/:id/expand-segments
// ─────────────────────────────────────────────────────────────────────────────
// Stubs pg; tests:
//   - input validation (400) — invalid id, non-array paths, empty changes
//   - dry-run path (no header required, no DB writes, returns counts)
//   - mutation path 412 (missing X-Confirm-Send)
//   - mutation path 400 (missing reason)
//   - mutation path 404 (campaign not found)
//   - mutation happy path (UPDATE campaigns + INSERT campaign_contacts +
//     INSERT operator_audit_log all in one tx)
//   - audit row carries reason + added/removed paths + new_enrollments
//   - 500 on db error with ROLLBACK

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type QueryOutcome = { rows: unknown[]; rowCount?: number } | Error
const queryQueue: QueryOutcome[] = []
const clientQueue: QueryOutcome[] = []
const calls: Array<{ sql: string; params?: unknown[] }> = []

vi.mock('pg', () => {
  class PoolClient {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      if (!clientQueue.length) return { rows: [], rowCount: 0 }
      const next = clientQueue.shift()!
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
  clientQueue.length = 0
  calls.length = 0
})

function qPool(rows: unknown[], rowCount = rows.length) {
  queryQueue.push({ rows, rowCount })
}
function qPoolErr(msg: string) {
  queryQueue.push(new Error(msg))
}
function qClient(rows: unknown[], rowCount = rows.length) {
  clientQueue.push({ rows, rowCount })
}
function qClientErr(msg: string) {
  clientQueue.push(new Error(msg))
}

async function req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(baseUrl + path, init)
  const text = await r.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: r.status, body: json }
}

// ── Input validation ─────────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/expand-segments — input validation', () => {
  it('400 on invalid id', async () => {
    const { status } = await req('POST', '/api/campaigns/abc/expand-segments', {
      added_paths: ['x'], removed_paths: [], reason: 'r',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(400)
  })

  it('400 on non-array added_paths', async () => {
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: 'not-array', removed_paths: [], reason: 'r',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/added_paths/)
  })

  it('400 on non-array removed_paths', async () => {
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: [], removed_paths: { not: 'array' }, reason: 'r',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/removed_paths/)
  })

  it('400 when both added_paths and removed_paths are empty', async () => {
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: [], removed_paths: [], reason: 'r',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toBe('no_changes')
  })
})

// ── Dry-run path ─────────────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/expand-segments — dry_run', () => {
  it('returns preview without requiring X-Confirm-Send', async () => {
    // SELECT campaign
    qPool([{ id: 457, name: 'Test', category_paths: '["Old > Path"]' }])
    // SELECT count candidates
    qPool([{ cnt: 8794 }])
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['New > Path'],
      removed_paths: [],
      dry_run: true,
    })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.dry_run).toBe(true)
    expect(b.campaign_id).toBe(457)
    expect(b.added).toBe(1)
    expect(b.removed).toBe(0)
    expect(b.new_enrollments).toBe(8794)
    expect(b.added_paths).toEqual(['New > Path'])
  })

  it('does not require reason for dry_run', async () => {
    qPool([{ id: 457, name: 'T', category_paths: '[]' }])
    qPool([{ cnt: 0 }])
    const { status } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['X'], removed_paths: [], dry_run: true,
    })
    expect(status).toBe(200)
  })

  it('dry_run does not call the client (no BEGIN/UPDATE/INSERT)', async () => {
    qPool([{ id: 457, name: 'T', category_paths: '[]' }])
    qPool([{ cnt: 5 }])
    await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['X'], removed_paths: [], dry_run: true,
    })
    expect(calls.some(c => /BEGIN/i.test(c.sql))).toBe(false)
    expect(calls.some(c => /UPDATE campaigns/i.test(c.sql))).toBe(false)
    expect(calls.some(c => /INSERT INTO campaign_contacts/i.test(c.sql))).toBe(false)
  })

  it('filters out duplicate added_paths already in current_paths', async () => {
    qPool([{ id: 457, name: 'T', category_paths: '["Already > Here"]' }])
    // No candidate query because actuallyAdded is empty after dedup
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['Already > Here'], removed_paths: [], dry_run: true,
    })
    expect(status).toBe(200)
    expect((body as { added: number }).added).toBe(0)
    expect((body as { new_enrollments: number }).new_enrollments).toBe(0)
  })
})

// ── Mutation gate: X-Confirm-Send + reason ──────────────────────────────────

describe('POST /api/campaigns/:id/expand-segments — confirm gate', () => {
  it('412 when X-Confirm-Send header is missing on mutation path', async () => {
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['X'], removed_paths: [], reason: 'unblock throughput',
    })
    expect(status).toBe(412)
    expect((body as { error: string }).error).toBe('missing_confirm_header')
  })

  it('400 when reason is empty on mutation path', async () => {
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['X'], removed_paths: [], reason: '',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(400)
    expect((body as { error: string }).error).toBe('reason_required')
  })

  it('400 when reason is whitespace only', async () => {
    const { status } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['X'], removed_paths: [], reason: '   ',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(400)
  })
})

// ── 404 ──────────────────────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/expand-segments — 404', () => {
  it('404 when campaign does not exist', async () => {
    qPool([]) // no campaign row
    const { status } = await req('POST', '/api/campaigns/99999/expand-segments', {
      added_paths: ['X'], removed_paths: [], reason: 'r',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(404)
  })
})

// ── Mutation happy path ──────────────────────────────────────────────────────

describe('POST /api/campaigns/:id/expand-segments — mutation', () => {
  it('UPDATE campaigns + INSERT campaign_contacts + INSERT operator_audit_log in one tx', async () => {
    qPool([{ id: 457, name: 'Strojírenství', category_paths: '["Existing > Path"]' }])
    qClient([]) // BEGIN
    qClient([]) // UPDATE campaigns
    qClient([{ id: 1 }, { id: 2 }, { id: 3 }]) // INSERT campaign_contacts RETURNING (3 new)
    qClient([]) // INSERT operator_audit_log
    qClient([]) // COMMIT
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['New > Path'],
      removed_paths: ['Existing > Path'],
      reason: 'Throughput unblock',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(200)
    const b = body as Record<string, unknown>
    expect(b.ok).toBe(true)
    expect(b.dry_run).toBe(false)
    expect(b.campaign_id).toBe(457)
    expect(b.added).toBe(1)
    expect(b.removed).toBe(1)
    expect(b.new_enrollments).toBe(3)
  })

  it('audit row carries reason, added/removed paths, new_enrollments, campaign metadata', async () => {
    qPool([{ id: 457, name: 'Test Campaign', category_paths: '[]' }])
    qClient([]) // BEGIN
    qClient([]) // UPDATE
    qClient([{ id: 1 }, { id: 2 }]) // INSERT — 2 new
    qClient([]) // INSERT audit
    qClient([]) // COMMIT
    await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['A > B', 'C > D'],
      removed_paths: [],
      reason: 'AC throughput unblock',
    }, { 'x-confirm-send': 'yes' })
    const auditCall = calls.find(c => /operator_audit_log/i.test(c.sql))
    expect(auditCall).toBeDefined()
    expect(auditCall!.sql).toMatch(/campaign_segment_expansion/)
    const params = auditCall!.params as unknown[]
    // params: [operator, campaignId, JSON.stringify(details)]
    expect(params[1]).toBe(457)
    const details = JSON.parse(params[2] as string)
    expect(details.campaign_id).toBe(457)
    expect(details.campaign_name).toBe('Test Campaign')
    expect(details.reason).toBe('AC throughput unblock')
    expect(details.added_paths).toEqual(['A > B', 'C > D'])
    expect(details.removed_paths).toEqual([])
    expect(details.new_enrollments).toBe(2)
  })

  it('passes operator from X-Operator header to audit row', async () => {
    qPool([{ id: 457, name: 'T', category_paths: '[]' }])
    qClient([]); qClient([]); qClient([{ id: 1 }]); qClient([]); qClient([])
    await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['X'], removed_paths: [], reason: 'r',
    }, { 'x-confirm-send': 'yes', 'x-operator': 'tomas@dev' })
    const auditCall = calls.find(c => /operator_audit_log/i.test(c.sql))!
    expect((auditCall.params as unknown[])[0]).toBe('tomas@dev')
  })

  it('skips INSERT campaign_contacts when actuallyAdded is empty (remove-only path)', async () => {
    qPool([{ id: 457, name: 'T', category_paths: '["A","B"]' }])
    qClient([]); qClient([]); qClient([]); qClient([])  // BEGIN/UPDATE/AUDIT/COMMIT
    const { status, body } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: [], removed_paths: ['A'], reason: 'remove A',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(200)
    expect((body as { added: number; removed: number; new_enrollments: number })).toMatchObject({
      added: 0, removed: 1, new_enrollments: 0,
    })
    expect(calls.some(c => /INSERT INTO campaign_contacts/i.test(c.sql))).toBe(false)
  })

  it('UPDATE persists category_paths as JSON string', async () => {
    qPool([{ id: 457, name: 'T', category_paths: '["A"]' }])
    qClient([]); qClient([]); qClient([{ id: 1 }]); qClient([]); qClient([])
    await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['B'], removed_paths: ['A'], reason: 'flip',
    }, { 'x-confirm-send': 'yes' })
    const updateCall = calls.find(c => /UPDATE campaigns/i.test(c.sql))!
    const persisted = JSON.parse((updateCall.params as unknown[])[0] as string)
    expect(persisted).toEqual(['B'])
  })

  it('500 on db error in mutation tx', async () => {
    qPool([{ id: 457, name: 'T', category_paths: '[]' }])
    qClient([]) // BEGIN
    qClientErr('constraint violation') // UPDATE throws
    const { status } = await req('POST', '/api/campaigns/457/expand-segments', {
      added_paths: ['X'], removed_paths: [], reason: 'r',
    }, { 'x-confirm-send': 'yes' })
    expect(status).toBe(500)
    // no audit row inserted since transaction rolled back
    expect(calls.some(c => /campaign_segment_expansion/.test(c.sql))).toBe(false)
  })
})
