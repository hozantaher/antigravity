// AR17 — Phase-aware send window + hourly sub-cap
//
// Tests:
//   T01  warmup_d0 mailbox at 09:00 Prague → blocked (window 10–14)
//   T02  warmup_d0 at 12:00 Prague → allowed
//   T03  warmup_d0 at 14:00 Prague → blocked (14 is exclusive boundary)
//   T04  production at 07:59 Prague → blocked (night-silence: 00–06 check passes, but before window 08:00)
//   T05  production at 23:00 Prague → blocked (after 20:00)
//   T06  production at 19:30 Prague → allowed (before 20:00)
//   T07  production at 08:00 Prague → allowed (window start)
//   T08  Night-silence 02:00 Prague → blocked for any phase
//   T09  warmup_d3 at 08:00 Prague → blocked (window starts 09:00)
//   T10  warmup_d3 at 09:00 Prague → allowed
//   T11  warmup_d7 at 18:00 Prague → blocked (18 exclusive)
//   T12  warmup_d7 at 17:59 Prague → allowed
//
// AR17 hourly sub-cap:
//   T13  checkHourlySubCap: used < max → null (allowed)
//   T14  checkHourlySubCap: used == max → blocked
//   T15  PHASE_SPREAD.warmup_d0.maxPerHour === 2 (ceil(5/4))
//   T16  PHASE_SPREAD.production.maxPerHour === 9 (ceil(100/12))
//   T17  Unknown phase → falls back to production spread
//   T18  Night-silence block: 05:59 Prague → blocked regardless of phase

import { describe, it, expect, vi } from 'vitest'
import {
  isWithinPhaseWindow,
  pragueHour,
  PHASE_SPREAD,
  checkHourlySubCap,
} from '../../../src/lib/campaign-send-batch.js'

// ── Helper: build a Date at a specific Prague local-hour ─────────────────────
// Uses a known CEST offset of +2 (Prague summer 2026-05-XX).
function pragueDate(hour, minute = 0) {
  const utcOffsetHours = 2 // CEST
  const baseDate = new Date('2026-05-11T00:00:00Z') // Monday
  return new Date(
    baseDate.getTime()
    + (hour - utcOffsetHours) * 60 * 60 * 1000
    + minute * 60 * 1000,
  )
}

describe('AR17 — isWithinPhaseWindow', () => {
  it('T01  warmup_d0 at 09:00 → blocked (window 10–14)', () => {
    expect(isWithinPhaseWindow(pragueDate(9), 'warmup_d0')).toBe(false)
  })

  it('T02  warmup_d0 at 12:00 → allowed', () => {
    expect(isWithinPhaseWindow(pragueDate(12), 'warmup_d0')).toBe(true)
  })

  it('T03  warmup_d0 at 14:00 → blocked (14 is exclusive boundary)', () => {
    expect(isWithinPhaseWindow(pragueDate(14), 'warmup_d0')).toBe(false)
  })

  it('T04  production at 07:59 → blocked (before 08:00)', () => {
    expect(isWithinPhaseWindow(pragueDate(7, 59), 'production')).toBe(false)
  })

  it('T05  production at 23:00 → blocked (after 20:00)', () => {
    expect(isWithinPhaseWindow(pragueDate(23), 'production')).toBe(false)
  })

  it('T06  production at 19:30 → allowed', () => {
    expect(isWithinPhaseWindow(pragueDate(19, 30), 'production')).toBe(true)
  })

  it('T07  production at 08:00 → allowed (window start)', () => {
    expect(isWithinPhaseWindow(pragueDate(8), 'production')).toBe(true)
  })

  it('T08  02:00 Prague → blocked by night-silence for any phase', () => {
    expect(isWithinPhaseWindow(pragueDate(2), 'production')).toBe(false)
    expect(isWithinPhaseWindow(pragueDate(2), 'warmup_d0')).toBe(false)
  })

  it('T09  warmup_d3 at 08:00 → blocked (window starts 09:00)', () => {
    expect(isWithinPhaseWindow(pragueDate(8), 'warmup_d3')).toBe(false)
  })

  it('T10  warmup_d3 at 09:00 → allowed', () => {
    expect(isWithinPhaseWindow(pragueDate(9), 'warmup_d3')).toBe(true)
  })

  it('T11  warmup_d7 at 18:00 → blocked (18 exclusive)', () => {
    expect(isWithinPhaseWindow(pragueDate(18), 'warmup_d7')).toBe(false)
  })

  it('T12  warmup_d7 at 17:59 → allowed', () => {
    expect(isWithinPhaseWindow(pragueDate(17, 59), 'warmup_d7')).toBe(true)
  })

  it('T17  Unknown phase → uses production spread (08:00 allowed)', () => {
    expect(isWithinPhaseWindow(pragueDate(8), 'unknown_phase')).toBe(true)
  })

  it('T18  05:59 Prague → blocked by night-silence (hour=5 < 6)', () => {
    expect(isWithinPhaseWindow(pragueDate(5, 59), 'production')).toBe(false)
  })
})

describe('AR17 — PHASE_SPREAD constants', () => {
  it('T15  warmup_d0.maxPerHour === ceil(5/4) === 2', () => {
    expect(PHASE_SPREAD.warmup_d0.maxPerHour).toBe(2)
  })

  it('T16  production.maxPerHour === ceil(100/12) === 9', () => {
    expect(PHASE_SPREAD.production.maxPerHour).toBe(9)
  })

  it('all known phases have hours[0] < hours[1]', () => {
    for (const [phase, spread] of Object.entries(PHASE_SPREAD)) {
      expect(spread.hours[0]).toBeLessThan(spread.hours[1])
      expect(spread.maxPerHour).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('AR17 — pragueHour helper', () => {
  it('returns Prague hour for a UTC Date', () => {
    // 2026-05-11 08:00 UTC = 10:00 Prague (CEST +2)
    const d = new Date('2026-05-11T08:00:00Z')
    expect(pragueHour(d)).toBe(10)
  })
})

describe('AR17 — checkHourlySubCap', () => {
  function makePool(count) {
    return {
      query: vi.fn().mockResolvedValue({ rows: [{ cnt: count }] }),
    }
  }

  it('T13  used < max → returns null (allowed)', async () => {
    const pool = makePool(0)
    const result = await checkHourlySubCap(pool, 1, 'warmup_d0')
    expect(result).toBeNull()
  })

  it('T14  used == max → returns blocked object', async () => {
    const pool = makePool(PHASE_SPREAD.warmup_d0.maxPerHour)
    const result = await checkHourlySubCap(pool, 1, 'warmup_d0')
    expect(result).not.toBeNull()
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('hourly_sub_cap_exceeded')
    expect(result.used).toBe(PHASE_SPREAD.warmup_d0.maxPerHour)
    expect(result.max).toBe(PHASE_SPREAD.warmup_d0.maxPerHour)
  })

  it('used > max → also returns blocked', async () => {
    const pool = makePool(PHASE_SPREAD.warmup_d0.maxPerHour + 3)
    const result = await checkHourlySubCap(pool, 1, 'warmup_d0')
    expect(result?.blocked).toBe(true)
  })

  it('production: used < cap → allowed', async () => {
    const pool = makePool(PHASE_SPREAD.production.maxPerHour - 1)
    const result = await checkHourlySubCap(pool, 5, 'production')
    expect(result).toBeNull()
  })

  it('queries operator_audit_log with correct action', async () => {
    const pool = makePool(0)
    await checkHourlySubCap(pool, 99, 'production')
    expect(pool.query).toHaveBeenCalledOnce()
    const [sql] = pool.query.mock.calls[0]
    expect(sql).toContain('campaign_contact_send')
    expect(sql).toContain('operator_audit_log')
  })
})
