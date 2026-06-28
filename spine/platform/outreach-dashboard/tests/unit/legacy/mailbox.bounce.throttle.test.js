/**
 * S11 — Mailbox bounce cascade auto-throttle tests.
 * Tests runMailboxBounceThrottle() in isolation with a mocked pool.
 * No live DB required.
 *
 * BF-A4 (2026-04-25) — extended pool mock supports rowCount overrides
 * (so race-condition tests can assert what happens when an UPDATE finds
 * 0 rows because the status changed mid-tick), added at_floor edge case,
 * and added direct unit tests for the pure decision fn.
 */
import { describe, test, expect, vi } from 'vitest'
import { runMailboxBounceThrottle } from '../../../mailboxBounceThrottle.js'
import { evaluateBounceThrottleAction } from '../../../src/lib/automation.js'

// ── Pool mock factory ──────────────────────────────────────────────
// Supports two call phases:
//   1. SELECT query → returns rows (with total_sent so the JS guard passes)
//   2. UPDATE queries → captured for assertion; rowCount default 1, override
//      via opts.updateRowCount per call type.
function makePool(mailboxRows, opts = {}) {
  const updates = []
  return {
    query: vi.fn(async (sql, params) => {
      if (sql.includes('FROM outreach_mailboxes')) {
        return { rows: mailboxRows.map(r => ({ total_sent: 100, ...r })) }
      }
      if (sql.includes('UPDATE outreach_mailboxes')) {
        updates.push({ sql, params })
        if (sql.includes("status='paused'")) {
          return { rowCount: opts.pauseRowCount ?? 1 }
        }
        return { rowCount: opts.throttleRowCount ?? 1 }
      }
      return { rows: [] }
    }),
    updates,
  }
}

describe('S11 bounce throttle', () => {
  test('bounce_rate < 5% → no update', async () => {
    const pool = makePool([
      { id: 1, daily_cap_override: 90, consecutive_bounces: 0, bounce_rate: 2.5 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(0)
    expect(result.throttled).toBe(0)
    expect(pool.updates).toHaveLength(0)
  })

  test('bounce_rate = 5% → throttle cap to 50%', async () => {
    const pool = makePool([
      { id: 2, daily_cap_override: 80, consecutive_bounces: 0, bounce_rate: 5.0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.throttled).toBe(1)
    expect(result.paused).toBe(0)
    expect(pool.updates[0].params[0]).toBe(40)
    expect(pool.updates[0].params[1]).toBe(2)
  })

  test('bounce_rate 9.9% → throttle, not pause', async () => {
    const pool = makePool([
      { id: 3, daily_cap_override: 100, consecutive_bounces: 0, bounce_rate: 9.9 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.throttled).toBe(1)
    expect(result.paused).toBe(0)
  })

  test('bounce_rate = 10% → pause', async () => {
    const pool = makePool([
      { id: 4, daily_cap_override: 90, consecutive_bounces: 0, bounce_rate: 10.0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(1)
    expect(result.throttled).toBe(0)
    expect(pool.updates[0].sql).toContain("status='paused'")
    expect(pool.updates[0].params[0]).toBe(4)
  })

  test('bounce_rate > 10% → pause', async () => {
    const pool = makePool([
      { id: 5, daily_cap_override: 90, consecutive_bounces: 1, bounce_rate: 20.0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(1)
    expect(result.throttled).toBe(0)
  })

  test('consecutive_bounces >= 5 → pause even if bounce_rate < 10%', async () => {
    const pool = makePool([
      { id: 6, daily_cap_override: 90, consecutive_bounces: 5, bounce_rate: 4.0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(1)
    expect(result.throttled).toBe(0)
  })

  test('consecutive_bounces = 3, low bounce_rate → throttle', async () => {
    const pool = makePool([
      { id: 7, daily_cap_override: 60, consecutive_bounces: 3, bounce_rate: 1.0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.throttled).toBe(1)
    expect(result.paused).toBe(0)
    expect(pool.updates[0].params[0]).toBe(30)
  })

  test('total_sent < 10 → no rows → no action', async () => {
    const pool = makePool([])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(0)
    expect(result.throttled).toBe(0)
    expect(pool.updates).toHaveLength(0)
  })

  test('cap already at or below throttle target → UPDATE called with correct WHERE', async () => {
    const pool = makePool([
      { id: 9, daily_cap_override: 20, consecutive_bounces: 0, bounce_rate: 7.0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.throttled).toBe(1)
    expect(pool.updates[0].params[0]).toBe(10)
    expect(pool.updates[0].sql).toContain('daily_cap_override > $1')
  })

  test('very small cap → throttle clamps to min 10', async () => {
    const pool = makePool([
      { id: 10, daily_cap_override: 15, consecutive_bounces: 0, bounce_rate: 6.0 },
    ])
    await runMailboxBounceThrottle(pool)
    expect(pool.updates[0].params[0]).toBe(10)
  })

  test('null daily_cap_override defaults to 90', async () => {
    const pool = makePool([
      { id: 11, daily_cap_override: null, consecutive_bounces: 0, bounce_rate: 6.0 },
    ])
    await runMailboxBounceThrottle(pool)
    expect(pool.updates[0].params[0]).toBe(45)
  })

  test('mixed mailboxes → correct paused+throttled count', async () => {
    const pool = makePool([
      { id: 1, daily_cap_override: 90, consecutive_bounces: 0, bounce_rate: 2.0 },  // skip
      { id: 2, daily_cap_override: 80, consecutive_bounces: 0, bounce_rate: 7.0 },  // throttle
      { id: 3, daily_cap_override: 70, consecutive_bounces: 0, bounce_rate: 12.0 }, // pause
      { id: 4, daily_cap_override: 60, consecutive_bounces: 4, bounce_rate: 1.0 },  // throttle (consec=4>=3)
      { id: 5, daily_cap_override: 50, consecutive_bounces: 6, bounce_rate: 2.0 },  // pause (consec=6>=5)
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(2)
    expect(result.throttled).toBe(2)
  })

  test('MONKEY: wide range of bounce values → no crash', async () => {
    const values = [0, 0.1, 4.99, 5.0, 5.01, 9.99, 10.0, 10.01, 50, 100]
    for (const bounce_rate of values) {
      const pool = makePool([
        { id: 99, daily_cap_override: 90, consecutive_bounces: 0, bounce_rate },
      ])
      await expect(runMailboxBounceThrottle(pool)).resolves.toBeDefined()
    }
  })

  test('pool.query throws → error propagates out of runMailboxBounceThrottle', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    }
    await expect(runMailboxBounceThrottle(pool)).rejects.toThrow('DB connection lost')
  })

  test('bounce_rate = 0, consecutive_bounces = 0 → no update', async () => {
    const pool = makePool([
      { id: 15, daily_cap_override: 90, consecutive_bounces: 0, bounce_rate: 0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(0)
    expect(result.throttled).toBe(0)
    expect(pool.updates).toHaveLength(0)
  })

  // ── BF-A4 — race + edge case hardening ─────────────────────────────

  test('BF-A4: cap=10 + throttle conditions → at_floor (no UPDATE issued)', async () => {
    // newCap = max(10, floor(10*0.5)) = 10. cap not actually decreasing →
    // no UPDATE; atFloor counter increments instead of throttled.
    const pool = makePool([
      { id: 30, daily_cap_override: 10, consecutive_bounces: 0, bounce_rate: 7.0 },
    ])
    const result = await runMailboxBounceThrottle(pool)
    expect(result.throttled).toBe(0)
    expect(result.atFloor).toBe(1)
    expect(pool.updates).toHaveLength(0) // no DB write — already at floor
  })

  test('BF-A4: pause UPDATE rowCount=0 (status changed mid-tick) → not counted', async () => {
    // Operator unpaused between SELECT and UPDATE → status='active' WHERE
    // matches nothing. Cron must not pretend to have paused it.
    const pool = makePool(
      [{ id: 40, daily_cap_override: 90, consecutive_bounces: 0, bounce_rate: 12 }],
      { pauseRowCount: 0 }
    )
    const result = await runMailboxBounceThrottle(pool)
    expect(result.paused).toBe(0)
    expect(pool.updates).toHaveLength(1) // attempt was made
  })

  test('BF-A4: throttle UPDATE rowCount=0 → not counted', async () => {
    const pool = makePool(
      [{ id: 41, daily_cap_override: 80, consecutive_bounces: 0, bounce_rate: 7 }],
      { throttleRowCount: 0 }
    )
    const result = await runMailboxBounceThrottle(pool)
    expect(result.throttled).toBe(0)
  })

  test('BF-A4: pause UPDATE WHERE re-asserts status=active', async () => {
    const pool = makePool([
      { id: 42, daily_cap_override: 90, consecutive_bounces: 0, bounce_rate: 11 },
    ])
    await runMailboxBounceThrottle(pool)
    expect(pool.updates[0].sql).toContain("status='active'")
  })

  // ── BF-A4 — direct pure-fn unit tests ──────────────────────────────

  test('BF-A4 pure: insufficient sent (sent=9) → noop', () => {
    const r = evaluateBounceThrottleAction({ totalSent: 9, bounceRate: 50, consecutiveBounces: 5 })
    expect(r.action).toBe('noop')
    expect(r.reason).toMatch(/total_sent 9/)
  })

  test('BF-A4 pure: cap exactly at floor → at_floor (no shrinkage)', () => {
    const r = evaluateBounceThrottleAction({
      totalSent: 100, bounceRate: 6, consecutiveBounces: 0, currentCap: 10,
    })
    expect(r.action).toBe('at_floor')
    expect(r.newCap).toBe(10)
  })

  test('BF-A4 pure: cap below floor (corrupt data) → at_floor, returns input cap', () => {
    const r = evaluateBounceThrottleAction({
      totalSent: 100, bounceRate: 7, consecutiveBounces: 0, currentCap: 5,
    })
    expect(r.action).toBe('at_floor')
    expect(r.newCap).toBe(5) // does not change a malformed value
  })

  test('BF-A4 pure: custom floor (5) — cap=10 still throttles to 5', () => {
    const r = evaluateBounceThrottleAction(
      { totalSent: 100, bounceRate: 6, consecutiveBounces: 0, currentCap: 10 },
      { floor: 5 }
    )
    expect(r.action).toBe('throttle')
    expect(r.newCap).toBe(5)
  })

  test('BF-A4 pure: string-typed inputs (PG json round-trip) coerce', () => {
    const r = evaluateBounceThrottleAction({
      totalSent: '100', bounceRate: '12.5', consecutiveBounces: '0', currentCap: '90',
    })
    expect(r.action).toBe('pause')
  })
})
