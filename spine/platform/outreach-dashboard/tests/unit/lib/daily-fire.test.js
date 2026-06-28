// BF-A6 — computeNextDailyFire DST-aware scheduler.
// Asserts that the next-fire instant always lands at hour:00 wall-clock
// in the target tz, regardless of DST transitions or server tz.

import { describe, it, expect } from 'vitest'
import { computeNextDailyFire } from '../../../src/lib/automation.js'

// Helper: render a Date as "HH" in Europe/Prague.
function pragueHour(d) {
  return Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague', hour: '2-digit', hour12: false,
  }).format(d))
}
function pragueDay(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

describe('computeNextDailyFire — basic correctness', () => {
  it('05:00 Prague — produces a Date at 05:xx Prague wall-clock', () => {
    const now = new Date('2026-04-25T10:00:00Z') // 12:00 Prague (CEST)
    const next = computeNextDailyFire(now, 5, 'Europe/Prague')
    expect(pragueHour(next)).toBe(5)
    expect(next.getTime()).toBeGreaterThan(now.getTime())
  })

  it('00:00 Prague (midnight) — works as edge of day', () => {
    const now = new Date('2026-04-25T20:00:00Z')
    const next = computeNextDailyFire(now, 0, 'Europe/Prague')
    expect(pragueHour(next)).toBe(0)
  })

  it('23:00 Prague — late-day fire', () => {
    const now = new Date('2026-04-25T10:00:00Z')
    const next = computeNextDailyFire(now, 23, 'Europe/Prague')
    expect(pragueHour(next)).toBe(23)
  })

  it('UTC tz works too', () => {
    const now = new Date('2026-04-25T10:00:00Z')
    const next = computeNextDailyFire(now, 7, 'UTC')
    expect(next.toISOString()).toContain('T07:00')
  })
})

describe('computeNextDailyFire — same-day vs next-day', () => {
  it('hour already passed today → schedules tomorrow', () => {
    // Prague 12:00 CEST. Schedule for 05:00 → tomorrow.
    const now = new Date('2026-04-25T10:00:00Z')
    const next = computeNextDailyFire(now, 5, 'Europe/Prague')
    expect(pragueDay(next)).not.toBe(pragueDay(now))
  })

  it('hour still ahead today → schedules today', () => {
    // Prague 06:00 CEST. Schedule for 07:00 → today.
    const now = new Date('2026-04-25T04:00:00Z')
    const next = computeNextDailyFire(now, 7, 'Europe/Prague')
    expect(pragueDay(next)).toBe(pragueDay(now))
    expect(pragueHour(next)).toBe(7)
  })

  it('hour boundary (now exactly at hour) → next-day fire', () => {
    // Prague 05:00:00.000. Schedule for 05:00 → tomorrow (now is not >).
    const now = new Date('2026-04-25T03:00:00Z') // 05:00 Prague CEST
    const next = computeNextDailyFire(now, 5, 'Europe/Prague')
    expect(next.getTime()).toBeGreaterThan(now.getTime())
    expect(pragueHour(next)).toBe(5)
  })
})

describe('computeNextDailyFire — DST transitions (Europe/Prague)', () => {
  // Prague switches CET→CEST on the last Sunday of March at 02:00 local
  // (clock jumps to 03:00 — 23h day).
  // Switches CEST→CET on the last Sunday of October at 03:00 local
  // (clock falls back to 02:00 — 25h day, 02:xx repeats).

  it('CET→CEST transition (March 2026, 29th) — fire still lands at 05:00 Prague', () => {
    // Sat 28 March 2026, 12:00 Prague CET = 11:00 UTC
    const now = new Date('2026-03-28T11:00:00Z')
    const next = computeNextDailyFire(now, 5, 'Europe/Prague')
    expect(pragueHour(next)).toBe(5)
    // Should be Sun 29 March 2026 in Prague tz
    expect(pragueDay(next)).toBe('2026-03-29')
  })

  it('CET→CEST transition — even just before 02:00 wall-clock skip', () => {
    // Sun 29 March 2026, 00:30 Prague CET = 2026-03-28T23:30Z
    const now = new Date('2026-03-28T23:30:00Z')
    const next = computeNextDailyFire(now, 5, 'Europe/Prague')
    expect(pragueHour(next)).toBe(5)
  })

  it('CEST→CET transition (October 2026, 25th) — fire still lands at 03:00 Prague', () => {
    // Sat 24 Oct 2026, 12:00 Prague CEST = 10:00 UTC
    const now = new Date('2026-10-24T10:00:00Z')
    const next = computeNextDailyFire(now, 3, 'Europe/Prague')
    expect(pragueHour(next)).toBe(3)
    expect(pragueDay(next)).toBe('2026-10-25')
  })

  it('CEST→CET transition — fire at 07:00 (Daily Report cron) lands correctly', () => {
    // Sat 24 Oct 2026, 22:00 Prague CEST = 20:00 UTC
    const now = new Date('2026-10-24T20:00:00Z')
    const next = computeNextDailyFire(now, 7, 'Europe/Prague')
    expect(pragueHour(next)).toBe(7)
    expect(pragueDay(next)).toBe('2026-10-25')
  })

  it('rescheduling across DST — second call after first fire still correct', () => {
    // Simulate: cron fired at 05:00 Prague on Sat 28 March 2026 (CET).
    // Rescheduling now should target Sun 29 March 05:00 Prague CEST.
    const fireTime = computeNextDailyFire(new Date('2026-03-28T01:00:00Z'), 5, 'Europe/Prague')
    expect(pragueHour(fireTime)).toBe(5)
    const nextAfter = computeNextDailyFire(fireTime, 5, 'Europe/Prague')
    expect(pragueHour(nextAfter)).toBe(5)
    // Should be Sunday after Saturday — exactly 23h apart wall-clock-wise,
    // because DST spring forward happens between them.
    const elapsedH = (nextAfter.getTime() - fireTime.getTime()) / 3600000
    // 23h CET→CEST day OR 24h day, depending on whether fireTime is before/after DST.
    // Saturday 05:00 Prague CET → Sunday 05:00 Prague CEST = 23 absolute hours.
    expect(elapsedH).toBeCloseTo(23, 1)
  })
})

describe('computeNextDailyFire — input validation', () => {
  it('throws on invalid hour < 0', () => {
    expect(() => computeNextDailyFire(new Date(), -1)).toThrow(RangeError)
  })

  it('throws on invalid hour > 23', () => {
    expect(() => computeNextDailyFire(new Date(), 24)).toThrow(RangeError)
  })

  it('throws on non-integer hour', () => {
    expect(() => computeNextDailyFire(new Date(), 5.5)).toThrow(RangeError)
  })

  it('throws on invalid Date', () => {
    expect(() => computeNextDailyFire(new Date('bad'), 5)).toThrow(TypeError)
    expect(() => computeNextDailyFire('not-a-date', 5)).toThrow(TypeError)
  })

  it('default tz is Europe/Prague', () => {
    const now = new Date('2026-04-25T10:00:00Z')
    const next = computeNextDailyFire(now, 5)
    expect(pragueHour(next)).toBe(5)
  })
})
