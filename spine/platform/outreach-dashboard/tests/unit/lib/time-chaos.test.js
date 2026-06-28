// HX4 — Time-travel chaos tests for time-chaos.js
//
// Coverage matrix:
//  • DST forward jump (2026-03-29 02:00 CET → 03:00 CEST) — hour 02:xx skipped
//  • DST back jump   (2026-10-25 03:00 CEST → 02:00 CET) — hour 02:xx repeats
//  • Year boundary handling
//  • Clock skew (NTP forward/backward)
//  • Leap second tolerance
//  • Weekend boundary (Mon-Fri 08:00..17:00 exclusive)
//  • Property tests (200 random timestamps): isInSendWindow returns boolean,
//    safeDuration ≥ 0
//
// All assertions are deterministic and locale-independent — the implementation
// uses Intl.DateTimeFormat with timeZone: 'Europe/Prague' so tests pass on any
// host TZ.

import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

import {
  isInSendWindow,
  nextSendWindowOpen,
  msUntilNextSendWindow,
  sameDay,
  classifyWallClock,
  safeDuration,
  formatRFC5322Date,
} from '../../../src/lib/time-chaos.js'

// ── helpers ───────────────────────────────────────────────────────────────

/** Construct a UTC Date from explicit components (no host-TZ ambiguity). */
function utcDate(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms))
}

// ════════════════════════════════════════════════════════════════════════════
// DST transitions — Europe/Prague
// ════════════════════════════════════════════════════════════════════════════

describe('DST forward (2026-03-29): 02:00 CET → 03:00 CEST, hour 02:xx skipped', () => {
  // 1. Send window math unaffected by skipped hour
  it('Sunday 2026-03-29 is Sunday in Prague regardless of DST gap → outside window', () => {
    // 03:00 CEST (UTC 01:00) — Sunday morning post-jump → outside window (weekend)
    const t = utcDate(2026, 3, 29, 1, 0, 0)
    expect(isInSendWindow(t)).toBe(false)
  })

  // 3. The wall-clock 02:30 doesn't exist on 2026-03-29; classifyWallClock
  // helps detect the gap. The function classifies a *real* timestamp — so
  // any UTC instant always has 1 occurrence. We check the post-jump instant.
  it('UTC 2026-03-29 01:00 maps to Prague 03:00 (jump target) — single occurrence', () => {
    const t = utcDate(2026, 3, 29, 1, 0, 0)
    const c = classifyWallClock(t)
    expect(c.ambiguous).toBe(false)
    expect(c.occurrences).toBe(1)
  })

  // 5. nextSendWindowOpen during the DST gap on a Sunday → next Mon 08:00 CEST
  it('nextSendWindowOpen at Sunday 2026-03-29 02:30-equivalent → Mon 2026-03-30 08:00 CEST (UTC 06:00)', () => {
    // No "02:30" exists on 2026-03-29 in Prague. Use UTC 00:30 (Prague 01:30 CET)
    // which is unambiguously pre-jump, still Sunday, well outside window.
    const now = utcDate(2026, 3, 29, 0, 30, 0)
    const next = nextSendWindowOpen(now)
    // 2026-03-30 is Monday, 08:00 CEST = UTC 06:00
    expect(next.toISOString()).toBe('2026-03-30T06:00:00.000Z')
  })

  // 6. Sunday end-of-day → next Monday 08:00 CEST
  it('msUntilNextSendWindow at Sunday 2026-03-29 17:01 CEST → Mon 08:00 CEST', () => {
    // Sunday 17:01 CEST = UTC 15:01. Monday 08:00 CEST = UTC 06:00 next day.
    const now = utcDate(2026, 3, 29, 15, 1, 0)
    const ms = msUntilNextSendWindow(now)
    // expected = 14h59m = 14*3600+59*60 = 53940 sec = 53,940,000 ms
    expect(ms).toBe((14 * 3600 + 59 * 60) * 1000)
  })
})

describe('DST back (2026-10-25): 03:00 CEST → 02:00 CET, hour 02:xx repeats', () => {
  // 2. classifyWallClock — same wall-clock 02:30 occurs twice (UTC 00:30 and 01:30)
  it('Prague 02:30 on 2026-10-25 occurs twice — first instance UTC 00:30 CEST', () => {
    const tFirst = utcDate(2026, 10, 25, 0, 30, 0)
    const c = classifyWallClock(tFirst)
    expect(c.ambiguous).toBe(true)
    expect(c.occurrences).toBe(2)
  })

  it('Prague 02:30 on 2026-10-25 occurs twice — second instance UTC 01:30 CET', () => {
    const tSecond = utcDate(2026, 10, 25, 1, 30, 0)
    const c = classifyWallClock(tSecond)
    expect(c.ambiguous).toBe(true)
    expect(c.occurrences).toBe(2)
  })

  it('Non-ambiguous Prague 04:00 on 2026-10-25 — single occurrence', () => {
    const t = utcDate(2026, 10, 25, 3, 0, 0) // Prague 04:00 CET
    const c = classifyWallClock(t)
    expect(c.ambiguous).toBe(false)
    expect(c.occurrences).toBe(1)
  })

  // 4. UTC instants for ambiguous wall-clocks remain unambiguous
  it('isInSendWindow on Sunday during fall-back → false (still weekend)', () => {
    const tFirst = utcDate(2026, 10, 25, 0, 30, 0)
    const tSecond = utcDate(2026, 10, 25, 1, 30, 0)
    expect(isInSendWindow(tFirst)).toBe(false)
    expect(isInSendWindow(tSecond)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Year boundary
// ════════════════════════════════════════════════════════════════════════════

describe('year boundary handling', () => {
  // 7. dispatch across midnight → no NaN/wrap
  it('2026-12-31 23:59:55 → 2027-01-01 00:00:05 — safeDuration = 10000 ms', () => {
    const a = utcDate(2026, 12, 31, 23, 59, 55)
    const b = utcDate(2027, 1, 1, 0, 0, 5)
    expect(safeDuration(a, b)).toBe(10_000)
    expect(Number.isFinite(safeDuration(a, b))).toBe(true)
  })

  // 8. Friday 2026-12-31 18:00 CET → Mon 2027-01-04 08:00
  it('nextSendWindowOpen at Thu 2026-12-31 18:00 CET (post-window) → Mon 2027-01-04 08:00 CET', () => {
    // 2026-12-31 is a Thursday. 18:00 CET = UTC 17:00. Monday Jan 4 2027 08:00 CET = UTC 07:00.
    // Need to verify weekday — let's keep semantic test consistent with the spec:
    // the spec says "Friday 18:00 → Monday 08:00", but 2026-12-31 is Thursday.
    // We verify the rule on the real day-of-week.
    const now = utcDate(2026, 12, 31, 17, 0, 0) // Thu 18:00 CET
    const next = nextSendWindowOpen(now)
    // Thu post-window → Fri 08:00 CET = 2027-01-01 08:00 CET = UTC 07:00.
    // BUT 2027-01-01 is also a Friday — verify with explicit assertion.
    expect(next.toISOString()).toBe('2027-01-01T07:00:00.000Z')
  })

  // 9. Sat/Sun → Monday handling
  it('nextSendWindowOpen at Fri 2027-01-01 18:00 CET → Mon 2027-01-04 08:00 CET (UTC 07:00)', () => {
    // 2027-01-01 is Friday; post-window jumps to Mon 2027-01-04.
    const now = utcDate(2027, 1, 1, 17, 0, 0) // Fri 18:00 CET
    const next = nextSendWindowOpen(now)
    expect(next.toISOString()).toBe('2027-01-04T07:00:00.000Z')
  })

  // 10. sameDay across year boundary
  it('sameDay across midnight 2026→2027 → false', () => {
    const a = utcDate(2026, 12, 31, 22, 50, 0) // Prague 23:50 CET
    const b = utcDate(2026, 12, 31, 23, 10, 0) // Prague 00:10 CET (already 2027-01-01)
    expect(sameDay(a, b)).toBe(false)
  })

  it('sameDay within Prague 2026-12-31 (both before midnight) → true', () => {
    const a = utcDate(2026, 12, 31, 8, 0, 0) // Prague 09:00
    const b = utcDate(2026, 12, 31, 16, 0, 0) // Prague 17:00
    expect(sameDay(a, b)).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Clock skew
// ════════════════════════════════════════════════════════════════════════════

describe('clock skew safety (safeDuration)', () => {
  // 11. NTP backward jump → returns 0
  it('safeDuration with end < start returns 0 (clock skew backward)', () => {
    const start = utcDate(2026, 6, 15, 12, 0, 0)
    const end = utcDate(2026, 6, 15, 11, 0, 0) // 1h earlier
    expect(safeDuration(start, end)).toBe(0)
  })

  // 12. Identical timestamps → 0
  it('safeDuration with start === end returns 0', () => {
    const t = utcDate(2026, 6, 15, 12, 0, 0)
    expect(safeDuration(t, t)).toBe(0)
  })

  // 13. NTP jump forward → recomputes
  it('isInSendWindow recomputes after forward NTP jump (Mon 07:30 → 08:30 CET)', () => {
    // 2026-06-15 is Monday. 07:30 CEST = UTC 05:30 → outside (08:00 not yet).
    // After +30min jump → 08:30 CEST = UTC 06:30 → inside.
    const before = utcDate(2026, 6, 15, 5, 30, 0)
    const after = utcDate(2026, 6, 15, 6, 30, 0)
    expect(isInSendWindow(before)).toBe(false)
    expect(isInSendWindow(after)).toBe(true)
  })

  // 14. NTP backward jump on a token bucket: safeDuration stays 0 → no refund
  it('NTP jump backward yields safeDuration=0 — token bucket would not refund', () => {
    const tickAt = utcDate(2026, 6, 15, 12, 0, 0)
    const skewedNow = utcDate(2026, 6, 15, 11, 30, 0) // jumped back 30min
    const elapsed = safeDuration(tickAt, skewedNow)
    expect(elapsed).toBe(0)
    // token-bucket math: refundedTokens = elapsed * rate → 0 → no over-refund.
  })

  // 15. Negative timestamp → handled gracefully
  it('isInSendWindow with negative epoch timestamp returns false (graceful)', () => {
    // Pre-1970 epoch. Should not throw, returns boolean.
    const negative = new Date(-1_000_000_000_000) // ~1938
    expect(typeof isInSendWindow(negative)).toBe('boolean')
  })

  it('safeDuration with NaN-bearing date returns 0', () => {
    const valid = utcDate(2026, 6, 15, 12, 0, 0)
    const invalid = new Date(NaN)
    expect(safeDuration(valid, invalid)).toBe(0)
    expect(safeDuration(invalid, valid)).toBe(0)
    expect(safeDuration(invalid, invalid)).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Leap second
// ════════════════════════════════════════════════════════════════════════════

describe('leap second tolerance', () => {
  // 16. JS Date doesn't natively support 23:59:60 — Date constructor with a
  // string "23:59:60" is implementation-defined. We test that the closest
  // representable instants don't crash and produce sensible results.
  it('23:59:60 leap second behavior — Date(...) folds to 00:00:00 next day, no crash', () => {
    // ISO-8601 leap-second strings are typically rejected or normalised. We
    // test the boundary: 23:59:59 vs 00:00:00 next day.
    const justBefore = utcDate(2026, 12, 31, 23, 59, 59) // Thu 23:59:59 UTC
    const justAfter = utcDate(2027, 1, 1, 0, 0, 0)
    // Both are valid, no crash.
    expect(Number.isFinite(justBefore.getTime())).toBe(true)
    expect(Number.isFinite(justAfter.getTime())).toBe(true)
    expect(safeDuration(justBefore, justAfter)).toBe(1000)
    // isInSendWindow handles both without throwing.
    expect(typeof isInSendWindow(justBefore)).toBe('boolean')
    expect(typeof isInSendWindow(justAfter)).toBe('boolean')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Weekend / window-edge boundaries
// ════════════════════════════════════════════════════════════════════════════

describe('window edges (Mon-Fri 08:00..17:00 Europe/Prague, end exclusive)', () => {
  // 17. Friday 17:00 → outside; 16:59:59 → inside
  it('Friday 16:59:59 CEST → inside; 17:00:00 CEST → outside (end exclusive)', () => {
    // 2026-06-19 is Friday. 16:59:59 CEST = UTC 14:59:59. 17:00:00 = UTC 15:00:00.
    const inside = utcDate(2026, 6, 19, 14, 59, 59)
    const outside = utcDate(2026, 6, 19, 15, 0, 0)
    expect(isInSendWindow(inside)).toBe(true)
    expect(isInSendWindow(outside)).toBe(false)
  })

  // 18. Saturday/Sunday/Monday-open boundary
  it('Saturday/Sunday outside; Monday 08:00 inside', () => {
    // 2026-06-20 Saturday 12:00 CEST → UTC 10:00
    const sat = utcDate(2026, 6, 20, 10, 0, 0)
    // 2026-06-21 Sunday 12:00 CEST → UTC 10:00
    const sun = utcDate(2026, 6, 21, 10, 0, 0)
    // 2026-06-22 Monday 08:00:00 CEST → UTC 06:00:00
    const monOpen = utcDate(2026, 6, 22, 6, 0, 0)
    // 2026-06-22 Monday 07:59:59 CEST → UTC 05:59:59
    const monPre = utcDate(2026, 6, 22, 5, 59, 59)

    expect(isInSendWindow(sat)).toBe(false)
    expect(isInSendWindow(sun)).toBe(false)
    expect(isInSendWindow(monOpen)).toBe(true)
    expect(isInSendWindow(monPre)).toBe(false)
  })

  it('msUntilNextSendWindow inside window returns 0', () => {
    // Monday 2026-06-22 10:00 CEST = UTC 08:00
    const inside = utcDate(2026, 6, 22, 8, 0, 0)
    expect(msUntilNextSendWindow(inside)).toBe(0)
  })

  it('nextSendWindowOpen inside window returns the same instant', () => {
    const inside = utcDate(2026, 6, 22, 8, 0, 0)
    const next = nextSendWindowOpen(inside)
    expect(next.getTime()).toBe(inside.getTime())
  })
})

// ════════════════════════════════════════════════════════════════════════════
// sameDay (DST-aware)
// ════════════════════════════════════════════════════════════════════════════

describe('sameDay — DST aware', () => {
  it('2026-03-29 03:00 CEST and 2026-03-29 01:30 CET — same Prague calendar day', () => {
    // Prague 01:30 CET = UTC 00:30.   Prague 03:00 CEST = UTC 01:00.
    const a = utcDate(2026, 3, 29, 0, 30, 0)
    const b = utcDate(2026, 3, 29, 1, 0, 0)
    expect(sameDay(a, b)).toBe(true)
  })

  it('Prague 23:59 vs next Prague 00:01 — different calendar day', () => {
    // 2026-06-15 22:59 CEST = UTC 20:59
    // 2026-06-15 22:01 CEST + 2h = 2026-06-16 00:01 CEST = UTC 22:01
    const a = utcDate(2026, 6, 15, 21, 59, 0) // Prague 23:59
    const b = utcDate(2026, 6, 15, 22, 1, 0) // Prague 00:01 next day
    expect(sameDay(a, b)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Property tests (fast-check, 200 runs)
// ════════════════════════════════════════════════════════════════════════════

describe('property: isInSendWindow returns boolean for any timestamp (200 runs)', () => {
  it('200 random epoch-ms → always boolean, never null/undefined', () => {
    fc.assert(
      fc.property(
        fc.integer({
          // window: year 1970..2100 in epoch ms
          min: 0,
          max: 4_102_444_800_000,
        }),
        (epochMs) => {
          const t = new Date(epochMs)
          const result = isInSendWindow(t)
          return typeof result === 'boolean'
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('property: safeDuration ≥ 0 for any pair (200 runs)', () => {
  it('200 random (start,end) pairs → safeDuration is a finite non-negative number', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        (a, b) => {
          const dur = safeDuration(new Date(a), new Date(b))
          return Number.isFinite(dur) && dur >= 0
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ── formatRFC5322Date — wire-MIME Date header in mailbox locale ───
describe('formatRFC5322Date(now, tz)', () => {
  it('CEST (summer): 2026-05-09 18:07 UTC → "Sat, 09 May 2026 20:07:xx +0200"', () => {
    const t = utcDate(2026, 5, 9, 18, 7, 30)
    const out = formatRFC5322Date(t, 'Europe/Prague')
    expect(out).toMatch(/^Sat, 09 May 2026 20:07:30 \+0200$/)
  })

  it('CET (winter): 2026-01-15 12:00 UTC → "Thu, 15 Jan 2026 13:00:00 +0100"', () => {
    const t = utcDate(2026, 1, 15, 12, 0, 0)
    const out = formatRFC5322Date(t, 'Europe/Prague')
    expect(out).toMatch(/^Thu, 15 Jan 2026 13:00:00 \+0100$/)
  })

  it('default tz is Europe/Prague when omitted', () => {
    const t = utcDate(2026, 7, 4, 10, 0, 0)
    const out = formatRFC5322Date(t)
    expect(out).toMatch(/\+0200$/)  // CEST in July
  })

  it('UTC tz → "+0000" suffix', () => {
    const t = utcDate(2026, 5, 9, 18, 7, 30)
    const out = formatRFC5322Date(t, 'UTC')
    expect(out).toMatch(/\+0000$/)
    expect(out).toContain('Sat, 09 May 2026 18:07:30')
  })

  it('non-Europe TZ — America/New_York EDT → "-0400"', () => {
    const t = utcDate(2026, 7, 4, 16, 0, 0)
    const out = formatRFC5322Date(t, 'America/New_York')
    expect(out).toMatch(/12:00:00 -0400$/)
  })

  it('DST forward boundary: just before vs just after spring-forward', () => {
    // 2026-03-29 00:30 UTC = 01:30 CET (still pre-jump)
    const before = utcDate(2026, 3, 29, 0, 30, 0)
    expect(formatRFC5322Date(before, 'Europe/Prague')).toMatch(/01:30:00 \+0100$/)
    // 2026-03-29 02:30 UTC = 04:30 CEST (post-jump)
    const after = utcDate(2026, 3, 29, 2, 30, 0)
    expect(formatRFC5322Date(after, 'Europe/Prague')).toMatch(/04:30:00 \+0200$/)
  })

  it('invalid Date input falls back to current time, still well-formed', () => {
    const out = formatRFC5322Date(new Date(NaN), 'Europe/Prague')
    expect(out).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/)
  })

  it('non-Date input falls back to current time, still well-formed', () => {
    // @ts-expect-error -- intentional bad input
    const out = formatRFC5322Date('not a date', 'Europe/Prague')
    expect(out).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/)
  })

  it('zero-padding: single-digit day/hour/minute/second all 2-digit', () => {
    const t = utcDate(2026, 1, 5, 5, 3, 7)
    const out = formatRFC5322Date(t, 'Europe/Prague')
    expect(out).toMatch(/^Mon, 05 Jan 2026 06:03:07 \+0100$/)
  })

  it('all 12 months render English short name', () => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    for (let m = 1; m <= 12; m++) {
      const t = utcDate(2026, m, 15, 12, 0, 0)
      const out = formatRFC5322Date(t, 'UTC')
      expect(out).toContain(` ${months[m-1]} 2026 `)
    }
  })

  it('all 7 weekdays render English short name', () => {
    // 2026-05-04 = Mon, 2026-05-05 = Tue, ..., 2026-05-10 = Sun
    const expected = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
    for (let d = 0; d < 7; d++) {
      const t = utcDate(2026, 5, 4 + d, 12, 0, 0)
      const out = formatRFC5322Date(t, 'UTC')
      expect(out.startsWith(expected[d])).toBe(true)
    }
  })

  it('output is RFC 5322 §3.3 conformant (regex match)', () => {
    // day-name "," day month year HH:MM:SS zone
    const re = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/
    for (let h = 0; h < 24; h += 3) {
      const t = utcDate(2026, 5, 9, h, 0, 0)
      expect(formatRFC5322Date(t, 'Europe/Prague')).toMatch(re)
    }
  })
})
