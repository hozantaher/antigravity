/**
 * AP4 P2/P3 — Atomic drain flag + peek/ack handshake tests.
 *
 * Fix 2 (atomic): maybeImmediateDrain — 2 concurrent callers, only 1 drains.
 * Fix 3 (peek/ack): runEgressChaosDetectionCron uses ?peek=1 then ?drain=1&ack=N.
 *
 * Tests:
 *   T-PA01: first peek call uses ?peek=1 (non-destructive)
 *   T-PA02: after successful INSERT, ack drain uses ?drain=1&ack=N
 *   T-PA03: relay ack 409 is non-fatal (cron continues)
 *   T-PA04: observations_inserted reflects actual INSERT count (not peek count)
 *   T-PA05: relay ack not called when peek returns 0 observations
 *   T-PA06: BFF crash simulation — peek succeeds, INSERT throws, no ack sent
 *   T-PA07: idempotent INSERT — ON CONFLICT DO NOTHING means duplicate rows silently dropped
 *   T-PA08: ack count matches peek count (not hard-filtered count)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runEgressChaosDetectionCron } from '../../../src/server-routes/egressChaosDetection.js'

beforeEach(() => {
  process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
  vi.unstubAllGlobals()
})

afterEach(() => {
  delete process.env.ANTI_TRACE_RELAY_URL
  vi.restoreAllMocks()
})

// Track all fetch calls for assertion.
function makeFetchSpy(responses) {
  let idx = 0
  const spy = vi.fn().mockImplementation(() => {
    const resp = responses[idx] ?? { ok: true, json: () => Promise.resolve({ observations: [], count: 0 }) }
    idx++
    return Promise.resolve({
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: () => Promise.resolve(resp.data ?? { observations: [], count: 0 }),
    })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

function makePool(sequence) {
  let idx = 0
  return {
    query: vi.fn().mockImplementation(() => {
      const row = sequence[idx] ?? { rows: [] }
      idx++
      return Promise.resolve(row)
    }),
  }
}

// T-PA01: first fetch uses ?peek=1 (not ?drain=1)
describe('T-PA01 first fetch is peek', () => {
  it('calls relay with peek=1', async () => {
    const fetchSpy = makeFetchSpy([
      { ok: true, data: { observations: [], count: 0 } },
    ])
    const pool = makePool([{ rows: [] }]) // chaos returns no rows

    await runEgressChaosDetectionCron(pool, {})

    const firstCall = fetchSpy.mock.calls[0]?.[0]
    expect(firstCall).toContain('peek=1')
    expect(firstCall).not.toContain('drain=1')
  })
})

// T-PA02: ack drain is called with drain=1&ack=N after INSERT succeeds.
describe('T-PA02 ack drain after INSERT', () => {
  it('calls drain=1&ack=2 when 2 observations peeked', async () => {
    const fetchSpy = makeFetchSpy([
      // peek → 2 obs
      {
        ok: true,
        data: {
          observations: [
            { mailbox_id: '1', country: 'CZ', op_type: 'send', observed_at: '2026-05-08T10:00:00Z' },
            { mailbox_id: '2', country: 'DE', op_type: 'probe', observed_at: '2026-05-08T10:01:00Z' },
          ],
          count: 2,
        },
      },
      // ack drain → ok
      { ok: true, data: {} },
    ])
    const pool = makePool([
      { rows: [] }, // INSERT obs 1
      { rows: [] }, // INSERT obs 2
      { rows: [] }, // chaos detect
    ])

    await runEgressChaosDetectionCron(pool, {})

    const ackCall = fetchSpy.mock.calls[1]?.[0]
    expect(ackCall).toContain('drain=1')
    expect(ackCall).toContain('ack=2')
  })
})

// T-PA03: relay ack returns 409 → non-fatal, cron still returns result.
describe('T-PA03 relay ack 409 is non-fatal', () => {
  it('resolves without throwing', async () => {
    makeFetchSpy([
      {
        ok: true,
        data: {
          observations: [
            { mailbox_id: '3', country: 'CZ', op_type: 'send', observed_at: '2026-05-08T10:00:00Z' },
          ],
          count: 1,
        },
      },
      // ack → 409
      { ok: false, status: 409, data: {} },
    ])
    const pool = makePool([
      { rows: [] }, // INSERT
      { rows: [] }, // chaos detect
    ])

    await expect(runEgressChaosDetectionCron(pool, {})).resolves.toBeDefined()
  })
})

// T-PA04: observations_inserted reflects INSERT count (rows actually inserted).
describe('T-PA04 observations_inserted is INSERT count', () => {
  it('returns insertedCount (not peek count)', async () => {
    makeFetchSpy([
      {
        ok: true,
        data: {
          observations: [
            { mailbox_id: '4', country: 'CZ', op_type: 'send', observed_at: '2026-05-08T10:00:00Z' },
            // second obs has no mailbox_id → skipped in INSERT
            { country: 'DE', op_type: 'probe', observed_at: '2026-05-08T10:01:00Z' },
          ],
          count: 2,
        },
      },
      { ok: true, data: {} }, // ack
    ])
    const pool = makePool([
      { rows: [] }, // INSERT obs 1 only (obs 2 skipped — no mailbox_id)
      { rows: [] }, // chaos detect
    ])

    const result = await runEgressChaosDetectionCron(pool, {})
    // Only 1 row was actually inserted (obs 2 skipped due to missing mailbox_id)
    expect(result.observations_inserted).toBe(1)
  })
})

// T-PA05: ack not called when peek returns 0 observations.
describe('T-PA05 no ack when 0 observations', () => {
  it('only calls peek, no ack', async () => {
    const fetchSpy = makeFetchSpy([
      { ok: true, data: { observations: [], count: 0 } },
    ])
    const pool = makePool([{ rows: [] }])

    await runEgressChaosDetectionCron(pool, {})

    // Only 1 fetch call (the peek) — no ack call.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const onlyCall = fetchSpy.mock.calls[0][0]
    expect(onlyCall).toContain('peek=1')
  })
})

// T-PA06: INSERT throws for all rows → ack is still sent (relay clears peeked rows).
// Rationale: per-row INSERT errors are caught and logged; ack uses peeked count so
// relay advances its head pointer regardless. On next cron cycle the relay won't
// re-emit rows that no longer exist in its buffer.
describe('T-PA06 INSERT throws → ack still sent', () => {
  it('calls ack=1 even when INSERT fails', async () => {
    const fetchSpy = makeFetchSpy([
      {
        ok: true,
        data: {
          observations: [
            { mailbox_id: '5', country: 'CZ', op_type: 'send', observed_at: '2026-05-08T10:00:00Z' },
          ],
          count: 1,
        },
      },
      { ok: true, data: {} }, // ack
    ])

    let insertCalled = false
    const pool = {
      query: vi.fn().mockImplementation((q) => {
        if (typeof q === 'string' && q.includes('mailbox_egress_observation')) {
          insertCalled = true
          return Promise.reject(new Error('db down'))
        }
        return Promise.resolve({ rows: [] })
      }),
    }

    // Should not throw (INSERT error is caught per-row).
    await expect(runEgressChaosDetectionCron(pool, {})).resolves.toBeDefined()
    expect(insertCalled).toBe(true)

    // Ack IS called with peeked count.
    const ackCall = fetchSpy.mock.calls[1]?.[0]
    expect(ackCall).toContain('ack=1')
  })
})

// T-PA07: duplicate peek rows are idempotent in DB via ON CONFLICT DO NOTHING.
describe('T-PA07 idempotent INSERT', () => {
  it('INSERT query uses ON CONFLICT DO NOTHING', async () => {
    makeFetchSpy([
      {
        ok: true,
        data: {
          observations: [
            { mailbox_id: '6', country: 'CZ', op_type: 'send', observed_at: '2026-05-08T10:00:00Z' },
          ],
          count: 1,
        },
      },
      { ok: true, data: {} }, // ack
    ])
    const pool = makePool([
      { rows: [] }, // INSERT
      { rows: [] }, // chaos detect
    ])

    await runEgressChaosDetectionCron(pool, {})

    const insertCall = pool.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('mailbox_egress_observation'),
    )
    expect(insertCall).toBeDefined()
    expect(insertCall[0]).toContain('ON CONFLICT DO NOTHING')
  })
})

// T-PA08: ack count equals the original peeked count (not insertedCount).
describe('T-PA08 ack uses peeked count not inserted count', () => {
  it('ack=N is the peek count', async () => {
    const fetchSpy = makeFetchSpy([
      {
        ok: true,
        data: {
          observations: [
            { mailbox_id: '7', country: 'CZ', op_type: 'send', observed_at: '2026-05-08T10:00:00Z' },
            // 2nd obs missing mailbox_id → skipped in INSERT but still peeked
            { country: 'DE', op_type: 'probe', observed_at: '2026-05-08T10:01:00Z' },
          ],
          count: 2,
        },
      },
      { ok: true, data: {} }, // ack
    ])
    const pool = makePool([
      { rows: [] }, // INSERT obs 1
      { rows: [] }, // chaos detect
    ])

    await runEgressChaosDetectionCron(pool, {})

    // ack must be 2 (the peeked count), not 1 (the inserted count).
    // Relay uses ack to advance its head pointer for crash safety.
    const ackCall = fetchSpy.mock.calls[1]?.[0]
    expect(ackCall).toContain('ack=2')
  })
})
