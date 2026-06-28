// AV-F5-A — Unit tests for runProspectScoringCron.
//
// Cases (4 total, ≥3 minimum per spec):
//   1. Happy path  — SELECT returns 2 contacts → UPDATE issued for each + audit row.
//   2. Idempotency — SELECT returns 0 rows on first call → no UPDATE / no audit.
//   3. Batch boundary — SELECT returns BATCH_SIZE rows, then 0 → two SELECTs, one batch processed.
//   4. Exclusion path — bounced email row is scored to 0 + factors.excluded=true persisted.

import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  runProspectScoringCron,
  PROSPECT_SCORE_BATCH_SIZE,
  PROSPECT_SCORE_TICK_MAX_ROWS,
  PROSPECT_SCORE_RECOMPUTE_INTERVAL_HOURS,
  PROSPECT_SCORE_CRON_INTERVAL_MS,
} from '../../../src/crons/runProspectScoringCron.js'

function makeRow(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    email_status: overrides.email_status ?? 'valid',
    email_confidence: overrides.email_confidence ?? 0.9,
    last_contacted: overrides.last_contacted ?? null,
    created_at: overrides.created_at ?? '2026-05-10T00:00:00Z',
    crm_client_id: null,
    ico: overrides.ico ?? '12345678',
    icp_tier: overrides.icp_tier ?? 'good',
    sector_primary: overrides.sector_primary ?? 'machinery',
    category_path: overrides.category_path ?? null,
    company_name: overrides.company_name ?? 'Strojírny Test',
  }
}

/**
 * Pool mock — captures all queries, returns scripted SELECT batches.
 * Each entry in `selectBatches` is the rows returned by one SELECT (in order).
 * `connect()` returns a client-shaped object that proxies query() back here so
 * we observe BEGIN / UPDATE / COMMIT.
 */
function makePool({ selectBatches = [], failBegin = false } = {}) {
  const captured = {
    selects: 0,
    updates: [],
    auditInserts: [],
    begins: 0,
    commits: 0,
    rollbacks: 0,
  }
  let selectIdx = 0

  const query = vi.fn(async (sql, params) => {
    const s = String(sql)
    if (s.startsWith('SELECT c.id') && s.includes('FROM contacts c')) {
      captured.selects++
      const rows = selectBatches[selectIdx] ?? []
      selectIdx++
      return { rows }
    }
    if (s.startsWith('BEGIN')) {
      captured.begins++
      if (failBegin) throw new Error('boom')
      return { rows: [] }
    }
    if (s.startsWith('COMMIT')) {
      captured.commits++
      return { rows: [] }
    }
    if (s.startsWith('ROLLBACK')) {
      captured.rollbacks++
      return { rows: [] }
    }
    if (s.startsWith('UPDATE contacts')) {
      captured.updates.push({ sql: s, params })
      return { rowCount: 1, rows: [] }
    }
    if (s.includes('INSERT INTO operator_audit_log')) {
      captured.auditInserts.push({ sql: s, params })
      return { rowCount: 1, rows: [] }
    }
    return { rows: [] }
  })

  const client = {
    query,
    release: vi.fn(),
  }
  return {
    query,
    connect: vi.fn(async () => client),
    captured,
  }
}

describe('AV-F5-A runProspectScoringCron — named constants', () => {
  test('exports tuning constants matching spec', () => {
    expect(PROSPECT_SCORE_BATCH_SIZE).toBe(500)
    expect(PROSPECT_SCORE_TICK_MAX_ROWS).toBe(5000)
    expect(PROSPECT_SCORE_RECOMPUTE_INTERVAL_HOURS).toBe(24)
    expect(PROSPECT_SCORE_CRON_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
  })
})

describe('AV-F5-A runProspectScoringCron — behaviour', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('case 1 — happy path: 2 candidates → 2 UPDATEs + 1 aggregated audit row', async () => {
    const pool = makePool({
      selectBatches: [
        [makeRow({ id: 1 }), makeRow({ id: 2, icp_tier: 'ideal' })],
        // Second SELECT returns empty → cron stops.
        [],
      ],
    })
    const r = await runProspectScoringCron(pool)
    expect(r.scored).toBe(2)
    expect(r.batches).toBe(1)
    expect(pool.captured.updates).toHaveLength(2)
    // UPDATE params: [id, score, factors_json]
    expect(pool.captured.updates[0].params[0]).toBe(1)
    expect(typeof pool.captured.updates[0].params[1]).toBe('number')
    expect(typeof pool.captured.updates[0].params[2]).toBe('string')  // JSON.stringify'd
    // BEGIN/COMMIT pair.
    expect(pool.captured.begins).toBe(1)
    expect(pool.captured.commits).toBe(1)
    expect(pool.captured.rollbacks).toBe(0)
    // One aggregated audit row at end of tick.
    expect(pool.captured.auditInserts).toHaveLength(1)
    const auditDetails = JSON.parse(pool.captured.auditInserts[0].params[0])
    expect(auditDetails.scored).toBe(2)
    expect(auditDetails.scorer_version).toBe('linear_v1')
    expect(auditDetails.batch_size).toBe(PROSPECT_SCORE_BATCH_SIZE)
  })

  test('case 2 — idempotency: empty first SELECT → no UPDATEs, no audit insert', async () => {
    const pool = makePool({
      selectBatches: [[]],
    })
    const r = await runProspectScoringCron(pool)
    expect(r.scored).toBe(0)
    expect(r.batches).toBe(0)
    expect(r.ticks_remaining).toBe(false)
    expect(pool.captured.updates).toHaveLength(0)
    expect(pool.captured.auditInserts).toHaveLength(0)
    expect(pool.captured.begins).toBe(0)
  })

  test('case 3 — batch boundary: full batch then short batch → process both', async () => {
    // First SELECT returns BATCH_SIZE rows → cron loops; second SELECT returns
    // a short batch (< BATCH_SIZE) → loop exits after processing it.
    const fullBatch = Array.from({ length: PROSPECT_SCORE_BATCH_SIZE }, (_, i) => makeRow({ id: i + 1 }))
    const shortBatch = [makeRow({ id: 9001 }), makeRow({ id: 9002 })]
    const pool = makePool({ selectBatches: [fullBatch, shortBatch] })

    const r = await runProspectScoringCron(pool)
    expect(r.scored).toBe(PROSPECT_SCORE_BATCH_SIZE + 2)
    expect(r.batches).toBe(2)
    expect(pool.captured.selects).toBe(2)
    expect(pool.captured.updates).toHaveLength(PROSPECT_SCORE_BATCH_SIZE + 2)
    expect(pool.captured.begins).toBe(2)
    expect(pool.captured.commits).toBe(2)
    expect(pool.captured.rollbacks).toBe(0)
    // Caught up after the partial batch.
    expect(r.ticks_remaining).toBe(false)
  })

  test('case 4 — exclusion path: bounced row → UPDATE writes score=0 + factors.excluded=true', async () => {
    const pool = makePool({
      selectBatches: [
        [makeRow({ id: 42, email_status: 'bounced' })],
        [],
      ],
    })
    const r = await runProspectScoringCron(pool)
    expect(r.scored).toBe(1)
    expect(pool.captured.updates).toHaveLength(1)
    expect(pool.captured.updates[0].params[0]).toBe(42)
    expect(pool.captured.updates[0].params[1]).toBe(0)
    const factors = JSON.parse(pool.captured.updates[0].params[2])
    expect(factors.excluded).toBe(true)
    expect(factors.excluded_reason).toBe('email_status_bounced')
  })
})
