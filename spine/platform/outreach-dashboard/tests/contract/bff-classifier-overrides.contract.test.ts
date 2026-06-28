// KT-B4 — BFF contract tests for operator override capture.
//
// Two endpoints under test:
//   1. PATCH /api/replies/:id/classify  → INSERT into classifier_overrides
//      when operator label differs from existing (LLM/cron) classification.
//   2. GET   /api/classifier/overrides?days=N → recent overrides + confusion
//      matrix shape; days clamped to [1, 90].
//
// All DB calls are mocked via the `pg` Pool stub. We assert SQL shape and
// param contents so future refactors that change the storage layer still
// have to honour the contract.

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
  for (const k of ['BFF_IMPORT_ONLY', 'BFF_AUTH_DISABLED', 'DATABASE_URL']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
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

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
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

const overrideCallSql = (sql: string) =>
  /INSERT INTO classifier_overrides/i.test(sql)

describe('PATCH /api/replies/:id/classify — KT-B4 override capture', () => {
  it('INSERTs classifier_overrides row when operator label differs from existing', async () => {
    // Pre-update SELECT — current LLM/cron classification = "auto_reply"
    q([{ classification: 'auto_reply' }])
    // UPDATE reply_inbox returns row
    q([{
      id: 11,
      from_email: 'a@b.cz',
      contact_id: 1,
      campaign_id: 2,
      classification: 'positive',
      handled: true,
      handled_at: new Date().toISOString(),
    }])
    // INSERT classifier_overrides
    q([], 1)

    const { status, body } = await req(
      'PATCH',
      '/api/replies/11/classify',
      { classification: 'positive' },
      { 'x-operator': 'tomas@example.cz' },
    )
    expect(status).toBe(200)
    expect((body as { ok: boolean }).ok).toBe(true)

    const insert = calls.find(c => overrideCallSql(c.sql))
    expect(insert, 'override INSERT must be present').toBeTruthy()
    expect(insert!.params).toEqual([11, 'auto_reply', 'positive', 'tomas@example.cz'])
  })

  it('does NOT insert override when operator label matches existing classification', async () => {
    q([{ classification: 'positive' }])           // pre-update
    q([{ id: 12, from_email: 'a@b.cz', contact_id: 1, campaign_id: 2, classification: 'positive', handled: true, handled_at: '' }])
    // (no INSERT into classifier_overrides expected)

    const { status } = await req(
      'PATCH',
      '/api/replies/12/classify',
      { classification: 'positive' },
    )
    expect(status).toBe(200)
    expect(calls.find(c => overrideCallSql(c.sql))).toBeUndefined()
  })

  it('captures override when LLM had no opinion yet (original = null)', async () => {
    q([{ classification: null }])
    q([{ id: 13, from_email: 'a@b.cz', contact_id: 1, campaign_id: 2, classification: 'negative', handled: true, handled_at: '' }])
    q([], 1)

    await req('PATCH', '/api/replies/13/classify', { classification: 'negative' })
    const insert = calls.find(c => overrideCallSql(c.sql))
    expect(insert).toBeTruthy()
    // First param = reply id, second = original (null), third = override
    expect(insert!.params![0]).toBe(13)
    expect(insert!.params![1]).toBeNull()
    expect(insert!.params![2]).toBe('negative')
  })

  it('falls back to "unknown" operator when no x-operator header sent', async () => {
    q([{ classification: 'auto_reply' }])
    q([{ id: 14, from_email: 'a@b.cz', contact_id: 1, campaign_id: 2, classification: 'question', handled: true, handled_at: '' }])
    q([], 1)

    await req('PATCH', '/api/replies/14/classify', { classification: 'question' })
    const insert = calls.find(c => overrideCallSql(c.sql))
    expect(insert!.params![3]).toBe('unknown')
  })

  it('rejects invalid classification with 400 and does not write override', async () => {
    const { status, body } = await req(
      'PATCH',
      '/api/replies/15/classify',
      { classification: 'definitely-not-a-label' },
    )
    expect(status).toBe(400)
    expect((body as { error: string }).error).toMatch(/invalid classification/)
    expect(calls.find(c => overrideCallSql(c.sql))).toBeUndefined()
  })

  it('does NOT insert override when classification omitted (handled-only case)', async () => {
    // No pre-update SELECT expected; UPDATE with COALESCE keeps existing label.
    q([{ id: 16, from_email: 'a@b.cz', contact_id: 1, campaign_id: 2, classification: 'positive', handled: true, handled_at: '' }])

    const { status } = await req('PATCH', '/api/replies/16/classify', {})
    expect(status).toBe(200)
    expect(calls.find(c => overrideCallSql(c.sql))).toBeUndefined()
  })

  it('returns 404 when reply not found and writes no override', async () => {
    q([{ classification: 'auto_reply' }])
    q([])  // UPDATE matched zero rows

    const { status } = await req(
      'PATCH',
      '/api/replies/9999/classify',
      { classification: 'positive' },
    )
    expect(status).toBe(404)
    expect(calls.find(c => overrideCallSql(c.sql))).toBeUndefined()
  })
})

describe('GET /api/classifier/overrides — KT-B4 confusion matrix endpoint', () => {
  it('returns overrides + confusion_matrix shape with default days=7', async () => {
    const now = new Date().toISOString()
    q([
      { id: 1, reply_id: 100, original_classification: 'auto_reply', override_classification: 'positive', operator: 't', ts: now },
      { id: 2, reply_id: 101, original_classification: 'auto_reply', override_classification: 'positive', operator: 't', ts: now },
      { id: 3, reply_id: 102, original_classification: 'positive',   override_classification: 'negative', operator: 't', ts: now },
    ])

    const { status, body } = await req('GET', '/api/classifier/overrides')
    expect(status).toBe(200)
    const data = body as {
      days: number
      total: number
      overrides: unknown[]
      confusion_matrix: Array<{ original: string | null; override: string; count: number }>
    }
    expect(data.days).toBe(7)
    expect(data.total).toBe(3)
    expect(data.overrides).toHaveLength(3)
    // matrix should aggregate the two (auto_reply→positive) into count=2
    const ap = data.confusion_matrix.find(
      m => m.original === 'auto_reply' && m.override === 'positive',
    )
    expect(ap?.count).toBe(2)
    const pn = data.confusion_matrix.find(
      m => m.original === 'positive' && m.override === 'negative',
    )
    expect(pn?.count).toBe(1)
  })

  it('clamps days > 90 down to 90', async () => {
    q([])
    const { status, body } = await req('GET', '/api/classifier/overrides?days=365')
    expect(status).toBe(200)
    expect((body as { days: number }).days).toBe(90)

    // Confirm the SQL was parameterised with 90 (not 365)
    const sel = calls.find(c => /FROM classifier_overrides/i.test(c.sql))
    expect(sel?.params).toEqual([90])
  })

  it('falls back to days=7 when query missing or non-numeric', async () => {
    q([])
    const { body: b1 } = await req('GET', '/api/classifier/overrides')
    expect((b1 as { days: number }).days).toBe(7)

    q([])
    const { body: b2 } = await req('GET', '/api/classifier/overrides?days=abc')
    expect((b2 as { days: number }).days).toBe(7)

    q([])
    const { body: b3 } = await req('GET', '/api/classifier/overrides?days=0')
    expect((b3 as { days: number }).days).toBe(7)

    q([])
    const { body: b4 } = await req('GET', '/api/classifier/overrides?days=-5')
    expect((b4 as { days: number }).days).toBe(7)
  })

  it('returns empty matrix + total=0 when no overrides exist', async () => {
    q([])
    const { status, body } = await req('GET', '/api/classifier/overrides?days=30')
    expect(status).toBe(200)
    const data = body as { total: number; confusion_matrix: unknown[]; overrides: unknown[] }
    expect(data.total).toBe(0)
    expect(data.confusion_matrix).toEqual([])
    expect(data.overrides).toEqual([])
  })

  it('treats null original_classification as a distinct matrix cell', async () => {
    const now = new Date().toISOString()
    q([
      { id: 1, reply_id: 1, original_classification: null,         override_classification: 'positive', operator: 't', ts: now },
      { id: 2, reply_id: 2, original_classification: null,         override_classification: 'positive', operator: 't', ts: now },
      { id: 3, reply_id: 3, original_classification: 'auto_reply', override_classification: 'positive', operator: 't', ts: now },
    ])

    const { body } = await req('GET', '/api/classifier/overrides')
    const data = body as {
      confusion_matrix: Array<{ original: string | null; override: string; count: number }>
    }
    const nullCell = data.confusion_matrix.find(
      m => m.original === null && m.override === 'positive',
    )
    expect(nullCell?.count).toBe(2)
    const arCell = data.confusion_matrix.find(
      m => m.original === 'auto_reply' && m.override === 'positive',
    )
    expect(arCell?.count).toBe(1)
  })

  it('orders overrides newest-first (DESC ts)', async () => {
    const sql0 = (calls[0]?.sql ?? '') // not yet populated
    expect(sql0).toBe('') // sanity — beforeEach clears
    q([])
    await req('GET', '/api/classifier/overrides?days=14')
    const sel = calls.find(c => /FROM classifier_overrides/i.test(c.sql))
    expect(sel?.sql).toMatch(/ORDER BY ts DESC/i)
  })
})
