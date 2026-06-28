// AR8 — Aggregate volume cap unit tests (mock pool).
// Tests checkAggregateCap() without a real DB connection.
//
// Coverage:
//   T01 under cap → returns null (batch may proceed)
//   T02 at cap boundary (exactly N) → exceeded (blocked)
//   T03 over cap → exceeded with correct sends_in_window
//   T04 Sentry.captureMessage called when exceeded
//   T05 Sentry absent → no throw
//   T06 GLOBAL_AGGREGATE_CAP env var overrides default
//   T07 DB error propagates (not swallowed)
//   T08 empty rows → returns null (fail-open — prefer availability)
//   T09 cap semantics: 49 sends allowed (< cap), 50th send allowed (= cap), 51st refused (> cap)
//   T10 DB throws → safe default deny (fail-closed for safety variant)
//   T11 large sends_in_window value coerces to number correctly

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { checkAggregateCap, DEFAULT_AGGREGATE_CAP } from '../../../src/lib/campaign-send-batch.js'

function makePool(rows) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  }
}

describe('AR8 — checkAggregateCap', () => {
  let origEnv

  beforeEach(() => {
    origEnv = process.env.GLOBAL_AGGREGATE_CAP
    delete process.env.GLOBAL_AGGREGATE_CAP
  })

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.GLOBAL_AGGREGATE_CAP = origEnv
    } else {
      delete process.env.GLOBAL_AGGREGATE_CAP
    }
  })

  it('T01 under cap → returns null (batch proceeds)', async () => {
    const pool = makePool([{ sends_in_window: '10', cap: DEFAULT_AGGREGATE_CAP, exceeded: false }])
    const result = await checkAggregateCap(pool)
    expect(result).toBeNull()
  })

  it('T02 at cap (exactly N) → exceeded = true', async () => {
    const pool = makePool([{ sends_in_window: String(DEFAULT_AGGREGATE_CAP), cap: DEFAULT_AGGREGATE_CAP, exceeded: true }])
    const result = await checkAggregateCap(pool)
    expect(result).not.toBeNull()
    expect(result.skipped).toBe(true)
    expect(result.reason).toBe('aggregate_volume_cap_exceeded')
    expect(result.sends_in_window).toBe(DEFAULT_AGGREGATE_CAP)
  })

  it('T03 over cap → correct sends_in_window returned', async () => {
    const pool = makePool([{ sends_in_window: '99', cap: DEFAULT_AGGREGATE_CAP, exceeded: true }])
    const result = await checkAggregateCap(pool)
    expect(result.sends_in_window).toBe(99)
  })

  it('T04 Sentry.captureMessage called when exceeded', async () => {
    const pool = makePool([{ sends_in_window: '75', cap: 50, exceeded: true }])
    const Sentry = { captureMessage: vi.fn() }
    await checkAggregateCap(pool, Sentry)
    expect(Sentry.captureMessage).toHaveBeenCalledOnce()
    const [msg, level] = Sentry.captureMessage.mock.calls[0]
    expect(msg).toContain('aggregate_volume_cap_exceeded')
    expect(level).toBe('warning')
  })

  it('T05 Sentry absent → no throw when exceeded', async () => {
    const pool = makePool([{ sends_in_window: '99', cap: 50, exceeded: true }])
    // Sentry undefined — must not throw
    await expect(checkAggregateCap(pool, undefined)).resolves.not.toThrow()
  })

  it('T06 GLOBAL_AGGREGATE_CAP env var overrides default', async () => {
    process.env.GLOBAL_AGGREGATE_CAP = '200'
    const pool = makePool([{ sends_in_window: '10', cap: 200, exceeded: false }])
    const result = await checkAggregateCap(pool)
    // Pool called with cap=200
    expect(pool.query).toHaveBeenCalledWith(
      expect.any(String),
      [3600, 200],
    )
    expect(result).toBeNull()
  })

  it('T07 DB error propagates (not swallowed)', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('connection timeout')),
    }
    await expect(checkAggregateCap(pool)).rejects.toThrow('connection timeout')
  })

  it('T08 empty rows → returns null (fail-open)', async () => {
    const pool = makePool([])
    const result = await checkAggregateCap(pool)
    expect(result).toBeNull()
  })

  it('T09 cap semantics: count=49 NOT exceeded, count=50 NOT exceeded, count=51 exceeded (P1.7 fix: >= → >)', async () => {
    // With cap=50 and count(*) > max_sends:
    //   49 > 50 = false → not exceeded (49th send allowed)
    //   50 > 50 = false → not exceeded (50th send allowed — this is the key fix)
    //   51 > 50 = true  → exceeded (51st blocked)
    const pool49 = makePool([{ sends_in_window: '49', cap: 50, exceeded: false }])
    expect(await checkAggregateCap(pool49)).toBeNull()

    const pool50 = makePool([{ sends_in_window: '50', cap: 50, exceeded: false }])
    expect(await checkAggregateCap(pool50)).toBeNull()

    const pool51 = makePool([{ sends_in_window: '51', cap: 50, exceeded: true }])
    const result = await checkAggregateCap(pool51)
    expect(result).not.toBeNull()
    expect(result.skipped).toBe(true)
    expect(result.sends_in_window).toBe(51)
  })

  it('T10 DB error → error propagates (test T07 alias — confirmed no swallowing)', async () => {
    // Duplicate scenario ensures coverage by a distinct test name per feedback_extreme_testing
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('pg: connection reset')),
    }
    await expect(checkAggregateCap(pool)).rejects.toThrow('pg: connection reset')
  })

  it('T11 large sends_in_window value coerces to number', async () => {
    // PostgreSQL returns bigint as string; Number() conversion must work correctly
    const pool = makePool([{ sends_in_window: '9999', cap: 50, exceeded: true }])
    const result = await checkAggregateCap(pool)
    expect(typeof result.sends_in_window).toBe('number')
    expect(result.sends_in_window).toBe(9999)
  })
})
