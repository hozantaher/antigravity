// AR13 — Engagement-driven cap adjustment cron unit tests (mock pool).
//
// Per AR2 audit: open-pixel tracking removed → engagement signal = reply rate.
//
// Phase caps sourced from `src/lib/lifecyclePhaseCaps.js` (migration 116
// operator-180 schedule). Cron under test must agree with that single
// source of truth — this suite asserts the caps it uses match canonical.
//
// Coverage (≥10 per feedback_extreme_testing):
//   T01 reply_rate < 0.5% (< 50 sends) → skipped (insufficient data)
//   T02 reply_rate < 0.5%, ≥50 sends → cap halved
//   T03 reply_rate < 0.5%, cap already at floor 5 → stays at 5
//   T04 reply_rate > 5% → cap grows toward phase cap (25% increase, ceil)
//   T05 reply_rate > 5%, already at phase cap → skipped (no change)
//   T06 neutral range 0.5–5% → skipped
//   T07 audit log INSERT called for each adjustment
//   T08 outreach_threads inaccessible → graceful skip with reason
//   T09 multiple mailboxes — only those outside neutral range adjusted
//   T10 growth never exceeds phase cap (AP1 / migration 116)
//   T11 cap halved from null (uses phase cap as base)
//   T12 Sentry called when adjustments > 0
//   T14 phase caps used by cron match canonical lifecyclePhaseCaps.js
//       (regression guard against AJ10d drift — issue #1417)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runEngagementCapAdjustmentCron } from '../../../src/server-routes/engagementCapAdjustment.js'
import { PHASE_CAPS } from '../../../src/lib/lifecyclePhaseCaps.js'

// ── Helper ────────────────────────────────────────────────────────────────────

function makeMailboxRow({
  id = 1,
  from_address = 'mb1@email.cz',
  daily_cap_override = 40,
  lifecycle_phase = 'production',
  sends_7d = 100,
  replies_7d = 0,
  reply_rate = 0,
} = {}) {
  return { id, from_address, daily_cap_override, lifecycle_phase, sends_7d, replies_7d, reply_rate }
}

/**
 * Make a pool mock for runEngagementCapAdjustmentCron.
 * Sequence (pool.query):
 *   1. SELECT 1 FROM outreach_threads LIMIT 0 (table check)
 *   2. SELECT mailbox engagement stats
 *
 * The cap UPDATE + operator_audit_log INSERT now run together in ONE
 * transaction on a connected client: pool.connect() → BEGIN → UPDATE →
 * INSERT → COMMIT (ROLLBACK on error). The fake client's `.query` is
 * exposed as `pool.clientQuery` so assertions can inspect the in-tx UPDATE
 * (params[0] = new cap) and audit INSERT (params[1] = details JSON).
 */
function makePool({ threadTableOk = true, statsRows = [], auditError = null } = {}) {
  let callIdx = 0
  const query = vi.fn(async () => {
    if (callIdx === 0) {
      callIdx++
      // threads availability check
      if (!threadTableOk) throw new Error('relation "outreach_threads" does not exist')
      return { rows: [] }
    }
    if (callIdx === 1) {
      callIdx++
      return { rows: statsRows }
    }
    callIdx++
    return { rows: [], rowCount: 1 }
  })

  // Cap UPDATE + audit INSERT run on a connected client inside one tx.
  const clientQuery = vi.fn(async (sql) => {
    const trimmed = typeof sql === 'string' ? sql.trim().toUpperCase() : ''
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    if (auditError && sql.includes('operator_audit_log')) throw auditError
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const connect = vi.fn(async () => ({ query: clientQuery, release }))

  return { query, connect, clientQuery, release }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AR13 — runEngagementCapAdjustmentCron', () => {
  it('T01 mailbox with < 50 sends in 7d → not returned by query (SQL filter)', async () => {
    // SQL has HAVING count >= 50; mock returns empty rows.
    const pool = makePool({ statsRows: [] })
    const result = await runEngagementCapAdjustmentCron(pool)
    expect(result.checked).toBe(0)
    expect(result.adjusted).toBe(0)
  })

  it('T02 reply_rate < 0.5%, ≥50 sends → cap halved', async () => {
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: 40, sends_7d: 100, replies_7d: 0, reply_rate: 0.002 })],
    })
    const result = await runEngagementCapAdjustmentCron(pool)
    expect(result.adjusted).toBe(1)
    // Check UPDATE call with new cap = floor(40/2) = 20
    const updateCall = pool.clientQuery.mock.calls.find(c => c[0].includes('UPDATE outreach_mailboxes'))
    expect(updateCall[1][0]).toBe(20) // new cap
  })

  it('T03 reply_rate < 0.5%, cap at 8 → floor at 5', async () => {
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: 8, sends_7d: 60, replies_7d: 0, reply_rate: 0.001 })],
    })
    await runEngagementCapAdjustmentCron(pool)
    const updateCall = pool.clientQuery.mock.calls.find(c => c[0].includes('UPDATE outreach_mailboxes'))
    expect(updateCall[1][0]).toBe(5) // floor(8/2)=4 → clamped to 5
  })

  it('T04 reply_rate > 5% → cap grows by 25% toward phase cap', async () => {
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: 40, lifecycle_phase: 'production', sends_7d: 100, replies_7d: 8, reply_rate: 0.08 })],
    })
    await runEngagementCapAdjustmentCron(pool)
    const updateCall = pool.clientQuery.mock.calls.find(c => c[0].includes('UPDATE outreach_mailboxes'))
    expect(updateCall[1][0]).toBe(50) // ceil(40 * 1.25) = 50; phase cap = 100 → ok
  })

  it('T05 reply_rate > 5%, already at phase cap → skipped', async () => {
    // production phase cap = 180 (migration 116); current override = 180.
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: PHASE_CAPS.production, lifecycle_phase: 'production', sends_7d: 100, replies_7d: 18, reply_rate: 0.10 })],
    })
    const result = await runEngagementCapAdjustmentCron(pool)
    expect(result.skipped).toBeGreaterThanOrEqual(1)
    // No UPDATE should be issued — at phase cap, the grow branch skips before
    // opening a tx, so the connected client is never asked to run the UPDATE.
    const updateCalls = pool.clientQuery.mock.calls.filter(c => c[0].includes('UPDATE outreach_mailboxes'))
    expect(updateCalls).toHaveLength(0)
  })

  it('T06 neutral range 0.5–5% → no change (skipped)', async () => {
    const pool = makePool({
      statsRows: [makeMailboxRow({ sends_7d: 100, replies_7d: 3, reply_rate: 0.03 })],
    })
    const result = await runEngagementCapAdjustmentCron(pool)
    expect(result.adjusted).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it('T07 audit log INSERT called for each adjusted mailbox', async () => {
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: 40, sends_7d: 100, replies_7d: 0, reply_rate: 0.002 })],
    })
    await runEngagementCapAdjustmentCron(pool)
    const auditCall = pool.clientQuery.mock.calls.find(c => c[0].includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    const details = JSON.parse(auditCall[1][1])
    expect(details.action).toBe('reduce')
    expect(details.reply_rate).toBeCloseTo(0.002)

    // The cap UPDATE + audit INSERT must commit together in one tx
    // (HARD: feedback_audit_log_on_mutations). Assert BEGIN < UPDATE < INSERT < COMMIT.
    const sqls = pool.clientQuery.mock.calls.map(c => String(c[0]).trim())
    const beginIdx = sqls.findIndex(s => s.toUpperCase().startsWith('BEGIN'))
    const updateIdx = sqls.findIndex(s => s.includes('UPDATE outreach_mailboxes'))
    const auditIdx = sqls.findIndex(s => s.includes('operator_audit_log'))
    const commitIdx = sqls.findIndex(s => s.toUpperCase().startsWith('COMMIT'))
    expect(beginIdx).toBe(0)
    expect(updateIdx).toBeGreaterThan(beginIdx)
    expect(auditIdx).toBeGreaterThan(updateIdx)
    expect(commitIdx).toBeGreaterThan(auditIdx)
  })

  it('T08 outreach_threads inaccessible → graceful skip', async () => {
    const pool = makePool({ threadTableOk: false })
    const result = await runEngagementCapAdjustmentCron(pool)
    expect(result.skip_reason).toBe('threads_unavailable')
    expect(result.adjusted).toBe(0)
  })

  it('T09 multiple mailboxes — only those outside neutral range adjusted', async () => {
    const pool = makePool({
      statsRows: [
        makeMailboxRow({ id: 1, daily_cap_override: 40, sends_7d: 100, reply_rate: 0.002 }), // < 0.5% → reduce
        makeMailboxRow({ id: 2, daily_cap_override: 40, sends_7d: 100, reply_rate: 0.03 }),  // neutral → skip
        makeMailboxRow({ id: 3, daily_cap_override: 40, sends_7d: 100, reply_rate: 0.08 }),  // > 5% → grow
      ],
    })
    const result = await runEngagementCapAdjustmentCron(pool)
    expect(result.adjusted).toBe(2) // id=1 reduced, id=3 grown
    expect(result.skipped).toBe(1)  // id=2 neutral
  })

  it('T10 growth path never exceeds phase cap', async () => {
    // warmup_d14 cap = 120 (migration 116); current = 100; 25% → ceil(100*1.25)=125 → clamped to 120
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: 100, lifecycle_phase: 'warmup_d14', sends_7d: 60, reply_rate: 0.10 })],
    })
    await runEngagementCapAdjustmentCron(pool)
    const updateCall = pool.clientQuery.mock.calls.find(c => c[0].includes('UPDATE outreach_mailboxes'))
    expect(updateCall[1][0]).toBe(PHASE_CAPS.warmup_d14) // clamped to warmup_d14 phase cap (120)
  })

  it('T11 cap_override is null → uses phase cap as base for reduction', async () => {
    // production cap = 180 (migration 116); halved → floor(180/2) = 90
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: null, lifecycle_phase: 'production', sends_7d: 100, reply_rate: 0.001 })],
    })
    await runEngagementCapAdjustmentCron(pool)
    const updateCall = pool.clientQuery.mock.calls.find(c => c[0].includes('UPDATE outreach_mailboxes'))
    expect(updateCall[1][0]).toBe(Math.floor(PHASE_CAPS.production / 2)) // floor(180/2) = 90
  })

  it('T12 Sentry captureMessage called when adjustments > 0', async () => {
    const pool = makePool({
      statsRows: [makeMailboxRow({ daily_cap_override: 40, sends_7d: 100, reply_rate: 0.002 })],
    })
    const Sentry = { captureMessage: vi.fn() }
    await runEngagementCapAdjustmentCron(pool, { Sentry })
    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
  })

  it('Q4.11 T13 thread with status=replied but updated_at > 7d ago → not counted in replies_7d', async () => {
    // Edge case: stat query (in production) only counts replied threads
    // updated within the 7d window. If a thread is very stale (replied
    // months ago), it must not affect current engagement metrics — the
    // SQL filter excludes it before this code path runs.
    //
    // To assert the cron sees the row as "neutral" (replies_7d already
    // filtered down to a value matching natural engagement), we feed a
    // reply_rate inside the 0.5–5% neutral band so the cron observes the
    // row (checked=1) but does not adjust (adjusted=0).
    const pool = makePool({
      statsRows: [makeMailboxRow({ sends_7d: 100, replies_7d: 2, reply_rate: 0.02 })],
    })
    const result = await runEngagementCapAdjustmentCron(pool)
    expect(result.adjusted).toBe(0)
    expect(result.checked).toBe(1)
  })

  // T14 — regression guard for issue #1417. The cron previously held its own
  // PHASE_CAPS literal {5, 10, 25, 50, 100} that drifted from migration 116
  // (operator-180 schedule). This test pins the cron's growth-clamp behavior
  // to the canonical phase caps for every phase, so any future drift fails
  // here instead of silently mis-judging engagement.
  describe('T14 cron uses canonical phase caps from lifecyclePhaseCaps.js (#1417)', () => {
    /**
     * For a given phase, run the cron with high reply_rate (> 5%) starting
     * from a cap one short of the phase cap, where ceil(base * 1.25) would
     * exceed the cap. The cron must clamp the new cap to PHASE_CAPS[phase].
     */
    async function expectClampedToPhaseCap(phase) {
      const phaseCap = PHASE_CAPS[phase]
      // Start at phaseCap - 1 so the 25% growth definitely exceeds the cap.
      const base = phaseCap - 1
      const pool = makePool({
        statsRows: [makeMailboxRow({
          daily_cap_override: base,
          lifecycle_phase: phase,
          sends_7d: 100,
          replies_7d: 10,
          reply_rate: 0.10,
        })],
      })
      await runEngagementCapAdjustmentCron(pool)
      const updateCall = pool.clientQuery.mock.calls.find(c => c[0].includes('UPDATE outreach_mailboxes'))
      expect(updateCall, `phase=${phase} expected UPDATE clamped to ${phaseCap}`).toBeDefined()
      expect(updateCall[1][0]).toBe(phaseCap)
    }

    it('warmup_d0 clamps to 10', async () => {
      expect(PHASE_CAPS.warmup_d0).toBe(10) // canonical sanity
      await expectClampedToPhaseCap('warmup_d0')
    })

    it('warmup_d3 clamps to 30', async () => {
      expect(PHASE_CAPS.warmup_d3).toBe(30)
      await expectClampedToPhaseCap('warmup_d3')
    })

    it('warmup_d7 clamps to 70', async () => {
      expect(PHASE_CAPS.warmup_d7).toBe(70)
      await expectClampedToPhaseCap('warmup_d7')
    })

    it('warmup_d14 clamps to 120', async () => {
      expect(PHASE_CAPS.warmup_d14).toBe(120)
      await expectClampedToPhaseCap('warmup_d14')
    })

    it('production clamps to 180', async () => {
      expect(PHASE_CAPS.production).toBe(180)
      await expectClampedToPhaseCap('production')
    })

    it('rejects stale 100 as production cap (pre-#1417 drift)', () => {
      // Pin: if any future PR re-introduces the stale 100-cap on production,
      // this hard-fails. Cap must be 180 (migration 116 operator-180 schedule).
      expect(PHASE_CAPS.production).not.toBe(100)
    })
  })
})
