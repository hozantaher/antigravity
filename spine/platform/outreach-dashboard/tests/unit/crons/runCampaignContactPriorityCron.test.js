// Unit tests for runCampaignContactPriorityCron (machinery-priority sync, 2026-06-26).
//
// Cases (5):
//   1. constants — exported tuning constants match spec.
//   2. happy path — one short batch (<BATCH_SIZE) → synced + one aggregated audit row.
//   3. idempotency — first batch updates 0 rows → no audit, ticks_remaining=false.
//   4. batch boundary — full batch then empty → two UPDATEs, one batch counted, caught up.
//   5. tick cap — always-full batches stop at TICK_MAX_ROWS (ticks_remaining stays true).

import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  runCampaignContactPriorityCron,
  PRIORITY_SYNC_BATCH_SIZE,
  PRIORITY_SYNC_TICK_MAX_ROWS,
  PRIORITY_SYNC_CRON_INTERVAL_MS,
} from '../../../src/crons/runCampaignContactPriorityCron.js'

/**
 * Pool mock — `updateRowCounts` scripts the rowCount each batched UPDATE returns
 * (in order). When the script is exhausted it returns 0 (caught up). Captures
 * UPDATE calls and the aggregated audit insert.
 */
function makePool({ updateRowCounts = [] } = {}) {
  const captured = { updates: [], auditInserts: [] }
  let idx = 0
  const query = vi.fn(async (sql, params) => {
    const s = String(sql)
    if (s.includes('UPDATE campaign_contacts')) {
      const rowCount = idx < updateRowCounts.length ? updateRowCounts[idx] : 0
      idx++
      captured.updates.push({ params, rowCount })
      return { rowCount, rows: [] }
    }
    if (s.includes('INSERT INTO operator_audit_log')) {
      captured.auditInserts.push({ params })
      return { rowCount: 1, rows: [] }
    }
    return { rows: [] }
  })
  return { query, captured }
}

describe('runCampaignContactPriorityCron — named constants', () => {
  test('exports tuning constants (no magic numbers)', () => {
    expect(PRIORITY_SYNC_BATCH_SIZE).toBe(2000)
    expect(PRIORITY_SYNC_TICK_MAX_ROWS).toBe(20000)
    expect(PRIORITY_SYNC_CRON_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
  })
})

describe('runCampaignContactPriorityCron — behaviour', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  test('case 1 — happy path: one short batch of 5 → synced=5, one audit row', async () => {
    const pool = makePool({ updateRowCounts: [5] })
    const r = await runCampaignContactPriorityCron(pool)
    expect(r.synced).toBe(5)
    expect(r.batches).toBe(1)
    expect(r.ticks_remaining).toBe(false)
    expect(pool.captured.updates).toHaveLength(1)
    expect(pool.captured.updates[0].params[0]).toBe(PRIORITY_SYNC_BATCH_SIZE) // LIMIT
    expect(pool.captured.auditInserts).toHaveLength(1)
    const details = JSON.parse(pool.captured.auditInserts[0].params[0])
    expect(details.synced).toBe(5)
    expect(details.batch_size).toBe(PRIORITY_SYNC_BATCH_SIZE)
  })

  test('case 2 — idempotency: 0 rows updated → no audit, no further work', async () => {
    const pool = makePool({ updateRowCounts: [0] })
    const r = await runCampaignContactPriorityCron(pool)
    expect(r.synced).toBe(0)
    expect(r.batches).toBe(0)
    expect(r.ticks_remaining).toBe(false)
    expect(pool.captured.updates).toHaveLength(1)
    expect(pool.captured.auditInserts).toHaveLength(0)
  })

  test('case 3 — batch boundary: full batch then empty → two UPDATEs, one counted batch', async () => {
    const pool = makePool({ updateRowCounts: [PRIORITY_SYNC_BATCH_SIZE, 0] })
    const r = await runCampaignContactPriorityCron(pool)
    expect(r.synced).toBe(PRIORITY_SYNC_BATCH_SIZE)
    expect(r.batches).toBe(1)
    expect(pool.captured.updates).toHaveLength(2)
    expect(r.ticks_remaining).toBe(false)
    expect(pool.captured.auditInserts).toHaveLength(1)
  })

  test('case 4 — tick cap: always-full batches stop at TICK_MAX_ROWS', async () => {
    const fullForever = Array.from(
      { length: PRIORITY_SYNC_TICK_MAX_ROWS / PRIORITY_SYNC_BATCH_SIZE + 5 },
      () => PRIORITY_SYNC_BATCH_SIZE,
    )
    const pool = makePool({ updateRowCounts: fullForever })
    const r = await runCampaignContactPriorityCron(pool)
    expect(r.synced).toBe(PRIORITY_SYNC_TICK_MAX_ROWS)
    expect(r.ticks_remaining).toBe(true)
    expect(pool.captured.updates).toHaveLength(PRIORITY_SYNC_TICK_MAX_ROWS / PRIORITY_SYNC_BATCH_SIZE)
    const details = JSON.parse(pool.captured.auditInserts[0].params[0])
    expect(details.synced).toBe(PRIORITY_SYNC_TICK_MAX_ROWS)
  })
})
