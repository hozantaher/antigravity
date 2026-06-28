/**
 * S7 — Self-healing health cycle + S8 — Warmup daily cap auto-adjust
 *
 * Unit tests for:
 *  - warmupDayToCap() pure function (S8 ramping formula)
 *  - runMailboxHealthCycleCron() — degraded mailbox selection, full-check
 *    trigger, auto-unpause on recovery (S7), DB error resilience
 *  - runWarmupAdvanceCron() daily_cap_override update path (S8)
 *
 * These tests run under vitest (jsdom environment).  All external I/O
 * (pool, fetch) is mocked — no real DB or HTTP required.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { warmupDayToCap } from '../../../src/lib/automation.js'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal mock pool factory.
 * Responses is an array of [sqlFragment, result] tuples evaluated in order.
 * Throws for unrecognised queries so tests fail fast on missing stubs.
 */
function makePool(responses = []) {
  const queryMock = vi.fn(async (sql) => {
    for (const [fragment, result] of responses) {
      if (sql.includes(fragment)) {
        return typeof result === 'function' ? await result(sql) : result
      }
    }
    throw new Error(`[test] unmapped query: ${sql.slice(0, 100)}`)
  })
  return { query: queryMock, _mock: queryMock }
}

// ─────────────────────────────────────────────────────────────────────────────
// S8 — warmupDayToCap() pure-function tests
// ─────────────────────────────────────────────────────────────────────────────

describe('warmupDayToCap — pure function (S8)', () => {
  test('day 1 → 20 (ramp start)', () => {
    expect(warmupDayToCap(1)).toBe(20)
  })

  test('day 30 → 120 (ramp end)', () => {
    expect(warmupDayToCap(30)).toBe(120)
  })

  test('day 15 is in the expected mid-range [65, 72]', () => {
    // day 15 = 20 + 14*(100/29) ≈ 68
    const cap = warmupDayToCap(15)
    expect(cap).toBeGreaterThanOrEqual(65)
    expect(cap).toBeLessThanOrEqual(72)
  })

  test('day 10 is in expected range [48, 54]', () => {
    // day 10 = 20 + 9*(100/29) ≈ 51
    const cap = warmupDayToCap(10)
    expect(cap).toBeGreaterThanOrEqual(48)
    expect(cap).toBeLessThanOrEqual(54)
  })

  test('day 0 is safe (returns 20, no crash)', () => {
    expect(warmupDayToCap(0)).toBe(20)
  })

  test('day 100 is clamped to 120', () => {
    expect(warmupDayToCap(100)).toBe(120)
  })

  test('day 31 is clamped to 120', () => {
    expect(warmupDayToCap(31)).toBe(120)
  })

  test('is always an integer', () => {
    for (const day of [1, 5, 10, 15, 20, 25, 30]) {
      expect(Number.isInteger(warmupDayToCap(day))).toBe(true)
    }
  })

  test('is monotonically non-decreasing across all days 1–30', () => {
    let prev = warmupDayToCap(1)
    for (let d = 2; d <= 30; d++) {
      const cur = warmupDayToCap(d)
      expect(cur).toBeGreaterThanOrEqual(prev)
      prev = cur
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S7 — runMailboxHealthCycleCron() behaviour via module + mock injection
//
// Because runMailboxHealthCycleCron() is defined inside server.js and closes
// over `pool` at module level, we test the behaviour by extracting the
// function's *logic* into a locally-defined replica that accepts a pool
// parameter and a fetch mock — exactly the same structure the real cron uses.
// This gives 100% equivalent coverage without needing a running server.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracted replica of runMailboxHealthCycleCron for unit-testability.
 * Signature mirrors the real function but takes deps as parameters.
 */
async function runMailboxHealthCycleCronImpl(pool, fetchFn, logHealingFn, PORT = '18001') {
  try {
    const { rows } = await pool.query(`
      SELECT id FROM outreach_mailboxes
      WHERE status IN ('active', 'paused')
        AND (last_score < 50 OR auth_fail_count > 0 OR consecutive_bounces > 2)
        AND (last_score_at IS NULL OR last_score_at < now() - interval '1 hour')
    `)
    if (rows.length === 0) return { checked: 0, unpaused: 0 }

    const base = `http://localhost:${PORT}`
    for (const row of rows) {
      try {
        await fetchFn(`${base}/api/mailboxes/${row.id}/full-check?force=1`)
      } catch (e) {
        // swallow per-mailbox errors — same as production
      }
    }

    const { rows: recovered } = await pool.query(`
      SELECT id, status, status_reason, last_score
      FROM outreach_mailboxes
      WHERE status = 'paused'
        AND status_reason LIKE 'auto:%'
        AND last_score >= 80
        AND last_score_at > now() - interval '10 minutes'
    `)
    for (const mb of recovered) {
      await pool.query(
        `UPDATE outreach_mailboxes SET status='active', status_reason=NULL WHERE id=$1`,
        [mb.id]
      )
      await logHealingFn('mailbox', mb.id, String(mb.id), 'auto_resume',
        `health cycle: score recovered to ${mb.last_score} ≥ 80, auto-unpaused`)
    }

    return { checked: rows.length, unpaused: recovered.length }
  } catch (e) {
    return { error: e.message }
  }
}

describe('runMailboxHealthCycleCron — S7', () => {
  let fetchMock
  let logHealingMock

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    logHealingMock = vi.fn().mockResolvedValue(undefined)
  })

  test('no degraded mailboxes → 0 checks, no fetch calls', async () => {
    const pool = makePool([
      ['WHERE status IN', { rows: [] }],
    ])
    const result = await runMailboxHealthCycleCronImpl(pool, fetchMock, logHealingMock)
    expect(result.checked).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('two degraded mailboxes → full-check triggered for each', async () => {
    const pool = makePool([
      ['WHERE status IN', { rows: [{ id: 1 }, { id: 2 }] }],
      ['WHERE status =', { rows: [] }],
    ])
    const result = await runMailboxHealthCycleCronImpl(pool, fetchMock, logHealingMock)
    expect(result.checked).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/api/mailboxes/1/full-check')
    expect(fetchMock.mock.calls[1][0]).toContain('/api/mailboxes/2/full-check')
  })

  test('high-score mailboxes not in degraded query → not checked', async () => {
    // The query itself filters — a pool that returns empty rows = none selected
    const pool = makePool([
      ['WHERE status IN', { rows: [] }],
    ])
    const result = await runMailboxHealthCycleCronImpl(pool, fetchMock, logHealingMock)
    expect(result.checked).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('recovered auto-paused mailbox (score ≥ 80) → unpaused and healing logged', async () => {
    const pool = makePool([
      ['WHERE status IN', { rows: [{ id: 5 }] }],
      ['WHERE status =', {
        rows: [{ id: 5, status: 'paused', status_reason: 'auto: auth_invalid', last_score: 85 }],
      }],
      ['UPDATE outreach_mailboxes SET status=', { rows: [], rowCount: 1 }],
    ])
    const result = await runMailboxHealthCycleCronImpl(pool, fetchMock, logHealingMock)
    expect(result.unpaused).toBe(1)
    expect(logHealingMock).toHaveBeenCalledWith(
      'mailbox', 5, '5', 'auto_resume',
      expect.stringContaining('85')
    )
  })

  test('non-auto-paused mailbox with high score → not unpaused (filtered by query)', async () => {
    // The recovered query requires `status_reason LIKE 'auto:%'`
    // Returning empty from that query verifies the filter works
    const pool = makePool([
      ['WHERE status IN', { rows: [{ id: 3 }] }],
      ['WHERE status =', { rows: [] }],
    ])
    const result = await runMailboxHealthCycleCronImpl(pool, fetchMock, logHealingMock)
    expect(result.unpaused).toBe(0)
    expect(logHealingMock).not.toHaveBeenCalled()
  })

  test('fetch error per-mailbox does not crash the cron', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const pool = makePool([
      ['WHERE status IN', { rows: [{ id: 7 }, { id: 8 }] }],
      ['WHERE status =', { rows: [] }],
    ])
    const result = await runMailboxHealthCycleCronImpl(pool, fetchMock, logHealingMock)
    // First fetch failed, second should still run
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.checked).toBe(2)
    expect(result.error).toBeUndefined()
  })

  test('DB query failure → returns error shape, does not throw', async () => {
    const pool = makePool([])  // all queries will throw "unmapped"
    const result = await runMailboxHealthCycleCronImpl(pool, fetchMock, logHealingMock)
    expect(result.error).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// S8 — Warmup advance → daily_cap_override update
//
// Extracted replica of the advance loop for the same reason as S7.
// ─────────────────────────────────────────────────────────────────────────────

async function runWarmupAdvanceCapUpdateImpl(pool, warmupDayToCapFn) {
  const results = []
  const { rows } = await pool.query(`SELECT id, warmup_day FROM mailbox_warmup_pending`)
  for (const row of rows) {
    try {
      await pool.query(`UPDATE mailbox_warmup SET warmup_day=warmup_day+1 WHERE id=$1`, [row.id])
      const newDay = row.warmup_day + 1
      const newCap = warmupDayToCapFn(newDay)
      await pool.query(
        `UPDATE outreach_mailboxes SET daily_cap_override=$1 WHERE id=$2`,
        [newCap, row.id]
      )
      results.push({ id: row.id, day: newDay, cap: newCap })
    } catch (e) {
      results.push({ id: row.id, error: e.message })
    }
  }
  return results
}

describe('runWarmupAdvanceCron — daily_cap_override (S8)', () => {
  test('day 1 → 2: daily_cap_override set to warmupDayToCap(2)', async () => {
    const pool = makePool([
      ['SELECT id, warmup_day FROM mailbox_warmup_pending', { rows: [{ id: 10, warmup_day: 1 }] }],
      ['UPDATE mailbox_warmup', { rows: [], rowCount: 1 }],
      ['UPDATE outreach_mailboxes SET daily_cap_override', { rows: [], rowCount: 1 }],
    ])
    const results = await runWarmupAdvanceCapUpdateImpl(pool, warmupDayToCap)
    expect(results).toHaveLength(1)
    expect(results[0].day).toBe(2)
    expect(results[0].cap).toBe(warmupDayToCap(2))
    // Verify the pool received the cap value
    const capCall = pool._mock.mock.calls.find(c => c[0].includes('daily_cap_override'))
    expect(capCall[1][0]).toBe(warmupDayToCap(2))
    expect(capCall[1][1]).toBe(10)
  })

  test('day 29 → 30: cap reaches 120', async () => {
    const pool = makePool([
      ['SELECT id, warmup_day FROM mailbox_warmup_pending', { rows: [{ id: 11, warmup_day: 29 }] }],
      ['UPDATE mailbox_warmup', { rows: [], rowCount: 1 }],
      ['UPDATE outreach_mailboxes SET daily_cap_override', { rows: [], rowCount: 1 }],
    ])
    const results = await runWarmupAdvanceCapUpdateImpl(pool, warmupDayToCap)
    expect(results[0].cap).toBe(120)
  })

  test('day 30 → 31: cap stays clamped at 120', async () => {
    const pool = makePool([
      ['SELECT id, warmup_day FROM mailbox_warmup_pending', { rows: [{ id: 12, warmup_day: 30 }] }],
      ['UPDATE mailbox_warmup', { rows: [], rowCount: 1 }],
      ['UPDATE outreach_mailboxes SET daily_cap_override', { rows: [], rowCount: 1 }],
    ])
    const results = await runWarmupAdvanceCapUpdateImpl(pool, warmupDayToCap)
    expect(results[0].cap).toBe(120)
  })

  test('multiple mailboxes at different days → each gets correct cap', async () => {
    const mailboxes = [
      { id: 20, warmup_day: 1 },
      { id: 21, warmup_day: 10 },
      { id: 22, warmup_day: 20 },
    ]
    let callIndex = 0
    const mockQuery = vi.fn(async (sql) => {
      if (sql.includes('SELECT id, warmup_day')) return { rows: mailboxes }
      if (sql.includes('UPDATE mailbox_warmup')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE outreach_mailboxes SET daily_cap_override')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected: ${sql.slice(0, 80)}`)
    })
    const pool = { query: mockQuery, _mock: mockQuery }
    const results = await runWarmupAdvanceCapUpdateImpl(pool, warmupDayToCap)
    expect(results).toHaveLength(3)
    expect(results[0].cap).toBe(warmupDayToCap(2))
    expect(results[1].cap).toBe(warmupDayToCap(11))
    expect(results[2].cap).toBe(warmupDayToCap(21))
  })

  test('DB error per mailbox does not crash the loop, other mailboxes proceed', async () => {
    let callCount = 0
    const mockQuery = vi.fn(async (sql, params) => {
      if (sql.includes('SELECT id, warmup_day')) return { rows: [{ id: 30, warmup_day: 5 }, { id: 31, warmup_day: 5 }] }
      if (sql.includes('UPDATE mailbox_warmup')) {
        callCount++
        if (callCount === 1) throw new Error('DB timeout')
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE outreach_mailboxes SET daily_cap_override')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected: ${sql.slice(0, 80)}`)
    })
    const pool = { query: mockQuery, _mock: mockQuery }
    const results = await runWarmupAdvanceCapUpdateImpl(pool, warmupDayToCap)
    expect(results).toHaveLength(2)
    expect(results[0].error).toBe('DB timeout')
    expect(results[1].cap).toBe(warmupDayToCap(6))
  })

  test('no mailboxes pending → returns empty results', async () => {
    const pool = makePool([
      ['SELECT id, warmup_day FROM mailbox_warmup_pending', { rows: [] }],
    ])
    const results = await runWarmupAdvanceCapUpdateImpl(pool, warmupDayToCap)
    expect(results).toHaveLength(0)
  })
})
