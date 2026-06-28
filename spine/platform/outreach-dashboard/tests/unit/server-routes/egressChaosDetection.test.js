// Sprint AP4 — runEgressChaosDetectionCron unit tests (mock pool + fetch).
//
// Tests:
//   T01 No observations from relay + no chaos rows → 0 flagged
//   T02 Relay has observations → INSERTs into DB
//   T03 1 mailbox / 1 country in 1h → no flag (detect_mailbox_egress_chaos returns 0 rows)
//   T04 1 mailbox / 2 countries in 1h → flag → status=egress_chaos_detected
//   T05 1 mailbox / 5 countries in 1h → flag + reason lists all countries
//   T06 Already egress_chaos_detected → skip (no double-flag)
//   T07 warmup_d0 mailbox < 24h old → exempt
//   T08 warmup_d0 mailbox > 24h old → NOT exempt (flag)
//   T09 Mixed: 2 mailboxes, 1 chaotic + 1 normal → only chaotic flagged
//   T10 Sentry.captureMessage called with correct severity
//   T11 Relay drain HTTP error → non-fatal (cron continues with existing DB rows)
//   T12 DB INSERT obs failure → non-fatal (cron continues)

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runEgressChaosDetectionCron } from '../../../src/server-routes/egressChaosDetection.js'

// ── Mock helpers ────────────────────────────────────────────────────────────

function makeSentry() {
  return { captureMessage: vi.fn() }
}

/**
 * Build a pool mock whose .query() resolves with given rows per call index.
 * `sequence` covers ONLY pool.query calls (relay-obs INSERTs, the
 * detect_mailbox_egress_chaos SELECT, and the per-mailbox state SELECT).
 *
 * The status flip to 'egress_chaos_detected' + the mailbox_egress_chaos_flag
 * audit INSERT now run together in ONE transaction on a connected client:
 * pool.connect() → BEGIN → UPDATE → INSERT → COMMIT. The fake client's
 * `.query` is exposed as `pool.clientQuery` so assertions can inspect the
 * in-tx UPDATE + audit INSERT — they no longer appear on pool.query.
 */
function makePool(sequence) {
  let idx = 0
  const query = vi.fn().mockImplementation(() => {
    const row = sequence[idx] ?? { rows: [] }
    idx++
    return Promise.resolve(row)
  })
  const clientQuery = vi.fn(async (sql) => {
    const trimmed = typeof sql === 'string' ? sql.trim().toUpperCase() : ''
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 1 }
  })
  const release = vi.fn()
  return {
    query,
    connect: vi.fn(async () => ({ query: clientQuery, release })),
    clientQuery,
    release,
  }
}

/** Patch global fetch. Restore via vi.restoreAllMocks(). */
function mockFetch(response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(response),
  }))
}

function mockFetchError(msg = 'network error') {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(msg)))
}

const NOW_MS = new Date('2026-05-08T12:00:00Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW_MS)
  vi.unstubAllGlobals()
  // Ensure ANTI_TRACE_RELAY_URL is set so the relay drain path is exercised
  process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.ANTI_TRACE_RELAY_URL
})

// T01: No observations + no chaos → 0 flagged.
describe('T01 no observations, no chaos', () => {
  it('returns flagged=0', async () => {
    mockFetch({ observations: [], count: 0 })
    const pool = makePool([
      // detect_mailbox_egress_chaos → no rows
      { rows: [] },
    ])
    const result = await runEgressChaosDetectionCron(pool, {})
    expect(result.flagged).toBe(0)
    expect(result.observations_inserted).toBe(0)
  })
})

// T02: Relay returns 2 observations → INSERTs both.
describe('T02 relay observations inserted into DB', () => {
  it('inserts 2 rows', async () => {
    mockFetch({
      observations: [
        { mailbox_id: '10', country: 'CZ', endpoint_label: 'cz1', op_type: 'send', observed_at: '2026-05-08T11:00:00Z' },
        { mailbox_id: '10', country: 'DE', endpoint_label: 'de1', op_type: 'probe', observed_at: '2026-05-08T11:30:00Z' },
      ],
      count: 2,
    })
    const pool = makePool([
      // INSERT obs 1
      { rows: [] },
      // INSERT obs 2
      { rows: [] },
      // detect_mailbox_egress_chaos → no chaos rows (already stored)
      { rows: [] },
    ])

    await runEgressChaosDetectionCron(pool, {})

    // Verify INSERT was called for each observation
    const insertCalls = pool.query.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('mailbox_egress_observation'),
    )
    expect(insertCalls).toHaveLength(2)
  })
})

// T03: detect_mailbox_egress_chaos returns 0 rows → no flag.
describe('T03 1 country → no flag', () => {
  it('flagged=0', async () => {
    mockFetch({ observations: [], count: 0 })
    const pool = makePool([{ rows: [] }]) // chaos returns no rows
    const result = await runEgressChaosDetectionCron(pool, {})
    expect(result.flagged).toBe(0)
  })
})

// T04: 2 countries in 1h → flag.
describe('T04 2 countries → flag', () => {
  it('updates status=egress_chaos_detected', async () => {
    mockFetch({ observations: [], count: 0 })
    const Sentry = makeSentry()
    const pool = makePool([
      // chaos → 1 row: mailbox 10, 2 countries
      { rows: [{ mailbox_id: '10', country_count: 2, country_list: ['CZ', 'DE'] }] },
      // SELECT mailbox state
      { rows: [{ lifecycle_phase: 'production', status: 'active', created_at: new Date(NOW_MS - 30 * 24 * 3600000).toISOString() }] },
      // (status flip UPDATE + audit INSERT now run on the in-tx client, not pool.query)
    ])

    const result = await runEgressChaosDetectionCron(pool, { Sentry })
    expect(result.flagged).toBe(1)

    // The UPDATE now runs inside the tx on the connected client.
    const updateCalls = pool.clientQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes("status = 'egress_chaos_detected'"),
    )
    expect(updateCalls).toHaveLength(1)

    // Status flip + mailbox_egress_chaos_flag audit INSERT must commit together
    // in one tx (HARD: feedback_audit_log_on_mutations). BEGIN < UPDATE < INSERT < COMMIT.
    const sqls = pool.clientQuery.mock.calls.map(c => String(c[0]).trim())
    const beginIdx = sqls.findIndex(s => s.toUpperCase().startsWith('BEGIN'))
    const updateIdx = sqls.findIndex(s => s.includes("status = 'egress_chaos_detected'"))
    const auditIdx = sqls.findIndex(s => s.includes('operator_audit_log') && s.includes('mailbox_egress_chaos_flag'))
    const commitIdx = sqls.findIndex(s => s.toUpperCase().startsWith('COMMIT'))
    expect(beginIdx).toBe(0)
    expect(updateIdx).toBeGreaterThan(beginIdx)
    expect(auditIdx).toBeGreaterThan(updateIdx)
    expect(commitIdx).toBeGreaterThan(auditIdx)
  })
})

// T05: 5 countries in 1h → flag with all countries in reason.
describe('T05 5 countries listed in reason', () => {
  it('status_reason includes all countries', async () => {
    mockFetch({ observations: [], count: 0 })
    const pool = makePool([
      { rows: [{ mailbox_id: '20', country_count: 5, country_list: ['AT', 'CZ', 'DE', 'PL', 'SK'] }] },
      { rows: [{ lifecycle_phase: 'production', status: 'active', created_at: new Date(NOW_MS - 10 * 24 * 3600000).toISOString() }] },
      // (UPDATE + audit INSERT run on the in-tx client, not pool.query)
    ])

    await runEgressChaosDetectionCron(pool, {})

    const updateCall = pool.clientQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes("status = 'egress_chaos_detected'"),
    )
    expect(updateCall).toBeDefined()
    const reason = updateCall[1][1]
    expect(reason).toContain('AT,CZ,DE,PL,SK')
    expect(reason).toContain('5')
  })
})

// T06: Already egress_chaos_detected → skip.
describe('T06 already flagged → skip', () => {
  it('does not double-flag', async () => {
    mockFetch({ observations: [], count: 0 })
    const pool = makePool([
      { rows: [{ mailbox_id: '30', country_count: 3, country_list: ['CZ', 'DE', 'AT'] }] },
      { rows: [{ lifecycle_phase: 'production', status: 'egress_chaos_detected', created_at: new Date(NOW_MS - 5 * 24 * 3600000).toISOString() }] },
    ])

    const result = await runEgressChaosDetectionCron(pool, {})
    expect(result.flagged).toBe(0)

    // No tx must be opened for an already-flagged mailbox — the UPDATE now runs
    // on the connected client, so assert there are zero in-tx status-flip calls.
    const updateCalls = pool.clientQuery.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes("status = 'egress_chaos_detected'"),
    )
    expect(updateCalls).toHaveLength(0)
  })
})

// T07: warmup_d0 < 24h old → exempt.
describe('T07 warmup_d0 <24h → exempt', () => {
  it('does not flag', async () => {
    mockFetch({ observations: [], count: 0 })
    const pool = makePool([
      { rows: [{ mailbox_id: '40', country_count: 2, country_list: ['CZ', 'DE'] }] },
      // created_at = 1 hour ago
      { rows: [{ lifecycle_phase: 'warmup_d0', status: 'active', created_at: new Date(NOW_MS - 3600000).toISOString() }] },
    ])

    const result = await runEgressChaosDetectionCron(pool, {})
    expect(result.flagged).toBe(0)
  })
})

// T08: warmup_d0 > 24h old → NOT exempt (flag).
describe('T08 warmup_d0 >24h → flag', () => {
  it('flags the mailbox', async () => {
    mockFetch({ observations: [], count: 0 })
    const pool = makePool([
      { rows: [{ mailbox_id: '50', country_count: 2, country_list: ['CZ', 'DE'] }] },
      // created_at = 48h ago
      { rows: [{ lifecycle_phase: 'warmup_d0', status: 'active', created_at: new Date(NOW_MS - 48 * 3600000).toISOString() }] },
      // (UPDATE + audit INSERT run on the in-tx client, not pool.query)
    ])

    const result = await runEgressChaosDetectionCron(pool, {})
    expect(result.flagged).toBe(1)
  })
})

// T09: Mixed: chaotic mailbox + normal mailbox → only chaotic flagged.
describe('T09 mixed mailboxes', () => {
  it('flags only the chaotic one', async () => {
    mockFetch({ observations: [], count: 0 })
    const pool = makePool([
      // chaos returns 2 rows: mailbox 60 (chaos) + mailbox 61 (1 country only wouldn't be returned)
      // Actually detect_mailbox_egress_chaos only returns mailboxes with >1 country,
      // so "normal" mailbox with 1 country won't appear here.
      // Simulate chaos function returning both as if both have >1 country, but mb 61 gets skipped:
      {
        rows: [
          { mailbox_id: '60', country_count: 3, country_list: ['CZ', 'DE', 'AT'] },
          { mailbox_id: '61', country_count: 2, country_list: ['CZ', 'SK'] },
        ],
      },
      // mailbox 60 state (UPDATE + audit INSERT for mb 60 now run on the in-tx
      // client, so the NEXT pool.query is mb 61's state SELECT — not an UPDATE)
      { rows: [{ lifecycle_phase: 'production', status: 'active', created_at: new Date(NOW_MS - 15 * 24 * 3600000).toISOString() }] },
      // mailbox 61 — already flagged → skipped (no double-flag)
      { rows: [{ lifecycle_phase: 'warmup_d3', status: 'egress_chaos_detected', created_at: new Date(NOW_MS - 5 * 24 * 3600000).toISOString() }] },
    ])

    const result = await runEgressChaosDetectionCron(pool, {})
    expect(result.flagged).toBe(1)
  })
})

// T10: Sentry.captureMessage called with 'error' level.
describe('T10 Sentry alert on flag', () => {
  it('fires with error level', async () => {
    mockFetch({ observations: [], count: 0 })
    const Sentry = makeSentry()
    const pool = makePool([
      { rows: [{ mailbox_id: '70', country_count: 2, country_list: ['CZ', 'DE'] }] },
      { rows: [{ lifecycle_phase: 'production', status: 'active', created_at: new Date(NOW_MS - 5 * 24 * 3600000).toISOString() }] },
      // (UPDATE + audit INSERT run on the in-tx client, not pool.query)
    ])

    await runEgressChaosDetectionCron(pool, { Sentry })

    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
    const [msg, opts] = Sentry.captureMessage.mock.calls[0]
    expect(msg).toContain('mailbox_egress_chaos')
    expect(opts.level).toBe('error')

    // Sentry only fires on the committed path — the tx must have COMMITted.
    const sqls = pool.clientQuery.mock.calls.map(c => String(c[0]).trim().toUpperCase())
    expect(sqls).toContain('COMMIT')
  })
})

// T11: Relay drain HTTP error → non-fatal, cron continues.
describe('T11 relay drain error → non-fatal', () => {
  it('continues detecting from existing DB rows', async () => {
    mockFetchError('ECONNREFUSED')
    const pool = makePool([{ rows: [] }]) // chaos returns no rows

    // Should not throw
    await expect(runEgressChaosDetectionCron(pool, {})).resolves.toBeDefined()
  })
})

// T12: DB INSERT obs failure → non-fatal, detection still runs.
describe('T12 DB INSERT failure → non-fatal', () => {
  it('continues after INSERT error', async () => {
    mockFetch({
      observations: [
        { mailbox_id: '80', country: 'CZ', endpoint_label: 'cz1', op_type: 'send', observed_at: '2026-05-08T11:00:00Z' },
      ],
      count: 1,
    })
    let insertCalled = false
    const pool = {
      query: vi.fn().mockImplementation((q) => {
        if (typeof q === 'string' && q.includes('mailbox_egress_observation')) {
          insertCalled = true
          return Promise.reject(new Error('db error'))
        }
        return Promise.resolve({ rows: [] })
      }),
    }

    // Should not throw
    await expect(runEgressChaosDetectionCron(pool, {})).resolves.toBeDefined()
    expect(insertCalled).toBe(true)
  })
})
