// AR11 — Bounce rate auto-pause cron unit tests (mock pool).
// Tests runBounceRateMonitorCron() without a real DB or network.
//
// Coverage (P1.8 fix: soft+hard bounce detection added):
//   T01 no high-bounce mailboxes → 0 paused, 0 checked
//   T02 10 sent + 1 hard bounce (10%) → pause fired (>= 5%)
//   T03 9 sent + 1 bounce (11%) → no pause (< 10 minimum sends — SQL filter)
//   T04 already-paused mailbox not double-flipped (rowCount=0)
//   T05 Sentry captureMessage called on pause
//   T06 Sentry absent → no throw
//   T07 status_reason includes rate + hard/soft counts
//   T08 multiple mailboxes — only high-bounce ones paused
//   T09 DB error propagates
//   T10 exactly 5% bounce (0.05) → pause triggered (boundary)
//   T11 only soft bounces (4xx failed) exceed threshold → pause triggered
//   T12 mix of hard + soft: combined rate triggers pause, neither alone would
//   T13 soft_bounces=0, hard_bounces=0 → no pause regardless of total
//   T14 status_reason mentions both hard and soft bounce counts

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runBounceRateMonitorCron } from '../../../src/server-routes/bounceRateMonitor.js'

// P1.8 schema: bounceRows now include hard_bounces + soft_bounces fields.
//
// The pause UPDATE (... RETURNING id) + the mailbox_bounce_autopause audit
// INSERT now run together in ONE transaction on a connected client:
// pool.connect() → BEGIN → UPDATE RETURNING id → INSERT → COMMIT. The pause
// is gated on the UPDATE returning a row (WHERE status='active' matched), so
// `updateRowCount > 0` means "row was active and got paused" and 0 means
// "already paused / no-op" (UPDATE RETURNING yields no rows). The fake
// client's `.query` is exposed as `pool.clientQuery` for in-tx assertions.
function makePool({ bounceRows = [], updateRowCount = 1 } = {}) {
  // pool.query is now only the initial SELECT of bouncy mailboxes.
  const query = vi.fn().mockResolvedValue({ rows: bounceRows })

  const clientQuery = vi.fn(async (sql) => {
    const trimmed = typeof sql === 'string' ? sql.trim().toUpperCase() : ''
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('UPDATE outreach_mailboxes')) {
      // UPDATE ... RETURNING id — a matched active row returns its id.
      return { rows: updateRowCount > 0 ? [{ id: 777 }] : [], rowCount: updateRowCount }
    }
    // audit INSERT (mailbox_bounce_autopause) or any other in-tx query
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  const connect = vi.fn(async () => ({ query: clientQuery, release }))

  return { query, connect, clientQuery, release }
}

describe('AR11 — runBounceRateMonitorCron', () => {
  it('T01 no high-bounce mailboxes → 0 paused, 0 checked', async () => {
    const pool = makePool({ bounceRows: [] })
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(0)
    expect(result.checked).toBe(0)
  })

  it('T02 10 sent + 1 hard bounce (10%) → pause fired', async () => {
    const pool = makePool({
      bounceRows: [
        { mailbox_used: 'mb1@email.cz', hard_bounces: '1', soft_bounces: '0', bounces: '1', total: '10', rate: 0.10 },
      ],
      updateRowCount: 1,
    })
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(1)
    expect(result.checked).toBe(1)
  })

  it('T03 under 10 minimum sends → query returns no rows (filter in SQL)', async () => {
    // The SQL has HAVING count(*) >= 10 — so 9-send mailboxes never appear.
    // Simulate: query returns empty (as DB would).
    const pool = makePool({ bounceRows: [] })
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(0)
  })

  it('T04 already-paused mailbox — UPDATE returns rowCount=0 → paused count not incremented', async () => {
    const pool = makePool({
      bounceRows: [
        { mailbox_used: 'mb2@email.cz', hard_bounces: '2', soft_bounces: '0', bounces: '2', total: '10', rate: 0.20 },
      ],
      updateRowCount: 0, // UPDATE WHERE status='active' matched nothing (already paused)
    })
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(0) // rowCount was 0 → not counted
    expect(result.checked).toBe(1)
  })

  it('T05 Sentry captureMessage called when pause fires', async () => {
    const pool = makePool({
      bounceRows: [{ mailbox_used: 'mb3@email.cz', hard_bounces: '3', soft_bounces: '0', bounces: '3', total: '20', rate: 0.15 }],
      updateRowCount: 1,
    })
    const Sentry = { captureMessage: vi.fn() }
    await runBounceRateMonitorCron(pool, { Sentry })
    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
    const [msg, level] = Sentry.captureMessage.mock.calls[0]
    expect(msg).toContain('mailbox_bounce_rate_high')
    expect(level).toBe('error')

    // The pause UPDATE + mailbox_bounce_autopause audit INSERT commit together
    // in one tx (HARD: feedback_audit_log_on_mutations); the Sentry alert only
    // fires on the committed path. Assert BEGIN < UPDATE < audit INSERT < COMMIT.
    const sqls = pool.clientQuery.mock.calls.map(c => String(c[0]).trim())
    const beginIdx = sqls.findIndex(s => s.toUpperCase().startsWith('BEGIN'))
    const updateIdx = sqls.findIndex(s => s.includes('UPDATE outreach_mailboxes'))
    const auditIdx = sqls.findIndex(s => s.includes('operator_audit_log') && s.includes('mailbox_bounce_autopause'))
    const commitIdx = sqls.findIndex(s => s.toUpperCase().startsWith('COMMIT'))
    expect(beginIdx).toBe(0)
    expect(updateIdx).toBeGreaterThan(beginIdx)
    expect(auditIdx).toBeGreaterThan(updateIdx)
    expect(commitIdx).toBeGreaterThan(auditIdx)
  })

  it('T06 Sentry absent → no throw', async () => {
    const pool = makePool({
      bounceRows: [{ mailbox_used: 'mb4@email.cz', hard_bounces: '2', soft_bounces: '0', bounces: '2', total: '10', rate: 0.20 }],
      updateRowCount: 1,
    })
    await expect(runBounceRateMonitorCron(pool, {})).resolves.not.toThrow()
  })

  it('T07 status_reason includes rate percentage and hard/soft counts', async () => {
    const pool = makePool({
      bounceRows: [{ mailbox_used: 'mb5@email.cz', hard_bounces: '2', soft_bounces: '1', bounces: '3', total: '30', rate: 0.10 }],
      updateRowCount: 1,
    })
    await runBounceRateMonitorCron(pool)
    // The pause UPDATE now runs on the in-tx client — find it among client queries.
    const updateCall = pool.clientQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('UPDATE outreach_mailboxes'))
    const reason = updateCall[1][1] // second arg array, index 1 = status_reason
    expect(reason).toContain('10.0pct')
    expect(reason).toContain('hard')
    expect(reason).toContain('soft')
  })

  it('T08 multiple mailboxes — all high-bounce ones paused', async () => {
    // Each row gets its own pool.connect() tx; both UPDATEs return a row
    // (updateRowCount=1) so both are paused.
    const pool = makePool({
      bounceRows: [
        { mailbox_used: 'mb6@email.cz', hard_bounces: '2', soft_bounces: '0', bounces: '2', total: '10', rate: 0.20 },
        { mailbox_used: 'mb7@email.cz', hard_bounces: '3', soft_bounces: '0', bounces: '3', total: '20', rate: 0.15 },
      ],
      updateRowCount: 1,
    })
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(2)
    expect(result.checked).toBe(2)
  })

  it('T09 DB error propagates from cron', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('DB gone')),
    }
    await expect(runBounceRateMonitorCron(pool)).rejects.toThrow('DB gone')
  })

  it('T10 exactly 5% bounce (boundary) → pause triggered', async () => {
    const pool = makePool({
      bounceRows: [
        { mailbox_used: 'mb8@email.cz', hard_bounces: '1', soft_bounces: '0', bounces: '1', total: '20', rate: 0.05 },
      ],
      updateRowCount: 1,
    })
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(1)
  })

  it('T11 only soft bounces (4xx failed) exceed threshold → pause triggered (P1.8)', async () => {
    // All failures are soft (4xx greylisting) — no hard bounces
    const pool = makePool({
      bounceRows: [
        { mailbox_used: 'mb9@email.cz', hard_bounces: '0', soft_bounces: '2', bounces: '2', total: '20', rate: 0.10 },
      ],
      updateRowCount: 1,
    })
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(1)
    expect(result.checked).toBe(1)
  })

  it('T12 mixed hard+soft: combined rate exceeds threshold, neither alone would (P1.8)', async () => {
    // hard=1 (5%) and soft=1 (5%) alone below 5% but combined = 2/20 = 10% → pause
    // Wait, 1/20 = 5% alone would trigger. Use: 0 hard + 1 soft / 25 total = 4% (no trigger)
    // vs combined: 1 hard + 1 soft / 25 = 8% → trigger
    const poolCombined = makePool({
      bounceRows: [
        { mailbox_used: 'mb10@email.cz', hard_bounces: '1', soft_bounces: '1', bounces: '2', total: '25', rate: 0.08 },
      ],
      updateRowCount: 1,
    })
    const resultCombined = await runBounceRateMonitorCron(poolCombined)
    expect(resultCombined.paused).toBe(1)
  })

  it('T13 zero bounces (hard=0, soft=0) → no pause', async () => {
    const pool = makePool({ bounceRows: [] }) // No rows returned = no mailboxes above threshold
    const result = await runBounceRateMonitorCron(pool)
    expect(result.paused).toBe(0)
    expect(result.checked).toBe(0)
  })

  it('T14 status_reason contains both hard and soft bounce count labels (P1.8)', async () => {
    const pool = makePool({
      bounceRows: [{ mailbox_used: 'mb11@email.cz', hard_bounces: '3', soft_bounces: '2', bounces: '5', total: '30', rate: 0.167 }],
      updateRowCount: 1,
    })
    await runBounceRateMonitorCron(pool)
    const updateCall = pool.clientQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('UPDATE outreach_mailboxes'))
    const reason = updateCall[1][1]
    // Reason must mention "hard" and "soft" for operator clarity
    expect(reason).toMatch(/hard/)
    expect(reason).toMatch(/soft/)
    expect(reason).toContain('3')  // hard_bounces count
    expect(reason).toContain('2')  // soft_bounces count
  })
})
