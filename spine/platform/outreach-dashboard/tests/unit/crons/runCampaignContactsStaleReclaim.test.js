// AV-F9 — Unit tests for runCampaignContactsStaleReclaim.
//
// The cron's contract is simulated by a recording pool mock. Real
// "stale > 1h" filtering is enforced by the SQL WHERE clause; the
// mock's job is to return canned rows for the UPDATE…RETURNING and
// capture all subsequent INSERTs.
//
// 8 cases per spec (feedback_extreme_testing T0):
//   1. No stale rows                       → 0 released, no audit, no alert.
//   2. Single stale row                    → released + audit + details flag.
//   3. Multiple campaigns w/ stale rows    → one audit row per campaign.
//   4. Mixed stale/fresh                   → SQL WHERE filters (mock returns
//                                            only stale; no JS gate).
//   5. Stale row already 'sent' externally → SQL WHERE filters (mock returns
//                                            no row; no audit / no alert).
//   6. Above ALERT_THRESHOLD               → mailbox_alerts INSERT emitted.
//   7. Batch limit cap (5000+ stale rows)  → mock returns exactly LIMIT rows;
//                                            cron returns LIMIT; alert fires.
//   8. Pool rejects query                  → fail-soft return with error,
//                                            does not throw.

import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  runCampaignContactsStaleReclaim,
  STALE_THRESHOLD_INTERVAL,
  RECLAIM_BATCH_LIMIT,
  ALERT_THRESHOLD,
  RECLAIM_CRON_INTERVAL_MS,
} from '../../../src/crons/runCampaignContactsStaleReclaim.js'

// ── Pool mock factory ───────────────────────────────────────────────────────
//
// opts:
//   reclaimedRows : array of { id, campaign_id } the UPDATE…RETURNING yields.
//   updateThrows  : Error instance the first UPDATE should throw.
function makePool(opts = {}) {
  const { reclaimedRows = [], updateThrows = null } = opts
  const captured = {
    updateCalls: [],
    auditInserts: [],
    alertInserts: [],
    otherCalls: [],
  }

  const query = vi.fn(async (sql, params) => {
    const s = String(sql)
    if (s.includes('UPDATE campaign_contacts')) {
      captured.updateCalls.push({ sql: s, params })
      if (updateThrows) throw updateThrows
      return { rows: reclaimedRows, rowCount: reclaimedRows.length }
    }
    if (s.includes('INSERT INTO operator_audit_log')) {
      captured.auditInserts.push({ sql: s, params })
      return { rowCount: 1, rows: [] }
    }
    if (s.includes('INSERT INTO mailbox_alerts')) {
      captured.alertInserts.push({ sql: s, params })
      return { rowCount: 1, rows: [] }
    }
    captured.otherCalls.push({ sql: s, params })
    return { rows: [] }
  })

  return { query, captured }
}

describe('AV-F9 runCampaignContactsStaleReclaim — named constants', () => {
  test('exports tuning constants matching spec', () => {
    expect(STALE_THRESHOLD_INTERVAL).toBe('1 hour')
    expect(RECLAIM_BATCH_LIMIT).toBe(5000)
    expect(ALERT_THRESHOLD).toBe(100)
    expect(RECLAIM_CRON_INTERVAL_MS).toBe(10 * 60 * 1000)
  })
})

describe('AV-F9 runCampaignContactsStaleReclaim — behaviour', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('case 1 — no stale rows → 0 released, no audit, no alert', async () => {
    const pool = makePool({ reclaimedRows: [] })
    const r = await runCampaignContactsStaleReclaim(pool)
    expect(r.rows_released).toBe(0)
    expect(r.by_campaign).toEqual({})
    expect(r.alert_emitted).toBe(false)
    expect(r.error).toBeUndefined()
    // UPDATE was issued (idempotency-by-SQL), audit/alert were NOT.
    expect(pool.captured.updateCalls).toHaveLength(1)
    expect(pool.captured.auditInserts).toHaveLength(0)
    expect(pool.captured.alertInserts).toHaveLength(0)
  })

  test('case 2 — single stale row → released + audit + details flag set in SQL', async () => {
    const pool = makePool({
      reclaimedRows: [{ id: 42, campaign_id: 457 }],
    })
    const r = await runCampaignContactsStaleReclaim(pool)
    expect(r.rows_released).toBe(1)
    expect(r.by_campaign).toEqual({ 457: 1 })
    expect(r.alert_emitted).toBe(false)

    // UPDATE SQL must set status='pending' and append the
    // released_* keys to details so post-mortems can identify
    // zombie releases.
    const updateSql = pool.captured.updateCalls[0].sql
    expect(updateSql).toMatch(/SET\s+status\s*=\s*'pending'/)
    expect(updateSql).toContain('released_from_in_flight_at')
    expect(updateSql).toContain('av_f9_stale_lease')
    expect(updateSql).toContain('released_by_cron')

    // UPDATE WHERE must filter for in_flight AND stale.
    expect(updateSql).toContain("status = 'in_flight'")
    expect(updateSql).toContain('updated_at < NOW()')

    // UPDATE params: [STALE_THRESHOLD_INTERVAL, RECLAIM_BATCH_LIMIT].
    expect(pool.captured.updateCalls[0].params).toEqual([
      STALE_THRESHOLD_INTERVAL,
      RECLAIM_BATCH_LIMIT,
    ])

    // One audit_log row written for campaign 457.
    expect(pool.captured.auditInserts).toHaveLength(1)
    const audit = pool.captured.auditInserts[0]
    expect(audit.params[0]).toBe('campaign_contacts_zombie_release_cron')
    expect(audit.params[1]).toBe('cron:runCampaignContactsStaleReclaim')
    expect(audit.params[2]).toBe('campaigns')
    expect(audit.params[3]).toBe(457)
    const details = JSON.parse(audit.params[4])
    expect(details.campaign_id).toBe(457)
    expect(details.rows_released).toBe(1)
    expect(details.stale_threshold).toBe(STALE_THRESHOLD_INTERVAL)
    expect(details.reclaim_batch_limit).toBe(RECLAIM_BATCH_LIMIT)
    expect(details.released_reason).toBe('av_f9_stale_lease')
  })

  test('case 3 — multiple campaigns each w/ stale rows → audit row per campaign with counts', async () => {
    const rows = [
      { id: 1, campaign_id: 457 },
      { id: 2, campaign_id: 457 },
      { id: 3, campaign_id: 458 },
      { id: 4, campaign_id: 459 },
      { id: 5, campaign_id: 459 },
      { id: 6, campaign_id: 459 },
    ]
    const pool = makePool({ reclaimedRows: rows })
    const r = await runCampaignContactsStaleReclaim(pool)
    expect(r.rows_released).toBe(6)
    expect(r.by_campaign).toEqual({ 457: 2, 458: 1, 459: 3 })

    // One audit row per campaign (not per contact).
    expect(pool.captured.auditInserts).toHaveLength(3)
    const auditsByCampaign = {}
    for (const a of pool.captured.auditInserts) {
      const det = JSON.parse(a.params[4])
      auditsByCampaign[det.campaign_id] = det.rows_released
    }
    expect(auditsByCampaign).toEqual({ 457: 2, 458: 1, 459: 3 })

    // Below ALERT_THRESHOLD (100) — no alert.
    expect(pool.captured.alertInserts).toHaveLength(0)
    expect(r.alert_emitted).toBe(false)
  })

  test('case 4 — mixed stale/fresh: SQL WHERE filters → only stale rows reach JS', async () => {
    // The SQL WHERE clause does the filtering. We assert the
    // updated_at threshold is part of the query — the mock returns
    // only the stale rows, simulating the SQL having filtered out
    // any fresh ones already.
    const pool = makePool({
      reclaimedRows: [{ id: 10, campaign_id: 457 }],
    })
    const r = await runCampaignContactsStaleReclaim(pool)
    expect(r.rows_released).toBe(1)
    const updateSql = pool.captured.updateCalls[0].sql
    // The threshold parameter is passed to NOW() - interval.
    expect(updateSql).toMatch(/updated_at < NOW\(\)\s*-\s*\(\$1\)::interval/)
    // The interval value is the named constant.
    expect(pool.captured.updateCalls[0].params[0]).toBe(STALE_THRESHOLD_INTERVAL)
  })

  test('case 5 — stale row externally changed to "sent" → SQL WHERE excludes → no audit / no alert', async () => {
    // Simulates the race where a contact's status flipped to 'sent'
    // between the SELECT and the UPDATE — the WHERE clause guards
    // status='in_flight' so the UPDATE returns zero rows.
    const pool = makePool({ reclaimedRows: [] })
    const r = await runCampaignContactsStaleReclaim(pool)
    expect(r.rows_released).toBe(0)
    // WHERE clause must include the status guard.
    const updateSql = pool.captured.updateCalls[0].sql
    expect(updateSql).toContain("status = 'in_flight'")
    // No audit / no alert.
    expect(pool.captured.auditInserts).toHaveLength(0)
    expect(pool.captured.alertInserts).toHaveLength(0)
  })

  test('case 6 — above ALERT_THRESHOLD released → mailbox_alerts INSERT emitted', async () => {
    // Synthesize ALERT_THRESHOLD+1 rows across two campaigns.
    const rows = Array.from({ length: ALERT_THRESHOLD + 1 }, (_, i) => ({
      id: i + 1,
      // Skew so campaign 457 gets the majority — exercises the
      // top-campaigns ordering in the alert message.
      campaign_id: i < 80 ? 457 : 458,
    }))
    const pool = makePool({ reclaimedRows: rows })
    const r = await runCampaignContactsStaleReclaim(pool)
    expect(r.rows_released).toBe(ALERT_THRESHOLD + 1)
    expect(r.alert_emitted).toBe(true)
    expect(pool.captured.alertInserts).toHaveLength(1)

    const alert = pool.captured.alertInserts[0]
    expect(alert.sql).toContain("'zombie_in_flight'")
    expect(alert.sql).toContain("'warn'")
    expect(alert.sql).toContain('mailbox_id, type, severity, message')
    // mailbox_id NULL — system-wide alert.
    expect(alert.sql).toMatch(/VALUES\s*\(NULL,\s*'zombie_in_flight'/)
    // Message contains the reclaim count and threshold for operator triage.
    expect(alert.params[0]).toContain(`reclaimed ${ALERT_THRESHOLD + 1}`)
    expect(alert.params[0]).toContain(`threshold=${ALERT_THRESHOLD}`)
    // Top campaigns sorted desc — 457:80 listed before 458:21.
    expect(alert.params[0]).toMatch(/457:80.*458:21/)
  })

  test('case 7 — batch limit cap (LIMIT rows returned) → cron returns LIMIT; next tick picks up rest', async () => {
    // The mock returns exactly RECLAIM_BATCH_LIMIT rows. Cron should
    // process them and stop. Audit + alert still fire (limit is well
    // above ALERT_THRESHOLD).
    const rows = Array.from({ length: RECLAIM_BATCH_LIMIT }, (_, i) => ({
      id: i + 1,
      campaign_id: 457,
    }))
    const pool = makePool({ reclaimedRows: rows })
    const r = await runCampaignContactsStaleReclaim(pool)
    expect(r.rows_released).toBe(RECLAIM_BATCH_LIMIT)
    expect(r.by_campaign).toEqual({ 457: RECLAIM_BATCH_LIMIT })

    // LIMIT param passed to UPDATE.
    expect(pool.captured.updateCalls[0].params[1]).toBe(RECLAIM_BATCH_LIMIT)
    const updateSql = pool.captured.updateCalls[0].sql
    expect(updateSql).toMatch(/LIMIT \$2/)

    // Single campaign → single audit row (aggregated count = LIMIT).
    expect(pool.captured.auditInserts).toHaveLength(1)
    const det = JSON.parse(pool.captured.auditInserts[0].params[4])
    expect(det.rows_released).toBe(RECLAIM_BATCH_LIMIT)

    // Alert fires.
    expect(r.alert_emitted).toBe(true)
  })

  test('case 8 — pool rejects → returns fail-soft { rows_released: 0, error } without throwing', async () => {
    const pool = makePool({ updateThrows: new Error('connection terminated') })
    let thrown = null
    let result
    try {
      result = await runCampaignContactsStaleReclaim(pool)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeNull()
    expect(result.rows_released).toBe(0)
    expect(result.by_campaign).toEqual({})
    expect(result.alert_emitted).toBe(false)
    expect(result.error).toBe('connection terminated')
    // No audit / no alert downstream of the failed UPDATE.
    expect(pool.captured.auditInserts).toHaveLength(0)
    expect(pool.captured.alertInserts).toHaveLength(0)
  })
})
