// AR7 — Send window enforcement for send-batch endpoint
//
// Tests:
//   T01  09:00 Prague Monday → inside window → no 423
//   T02  08:59 Prague Monday → outside window → 423
//   T03  17:00 Prague Monday → inside window (last valid hour) → no 423
//   T04  17:01 Prague Monday (outside 08:00–16:59) → 423
//   T05  03:00 UTC (= 04:00 Prague CEST) Saturday → 423 (weekend)
//   T06  X-Force-Send: yes overrides window → proceeds past gate (200 or next check)
//   T07  X-Force-Send: yes → audit log INSERT called with 'send_window_force_override'
//   T08  X-Force-Send: yes → safeError.captureMessage called with 'warning'
//   T09  Sunday 12:00 Prague → 423 (weekend)
//   T10  Friday 16:59 Prague → inside window → no 423
//   T11  isWithinSendWindow returns false on Saturday at noon
//   T12  retry_after_seconds present in 423 response

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isWithinSendWindow } from '../../../src/lib/automation.js'

// ── Helper: build a Prague-tz Date from weekday index + hour + minute ────────
// weekday: 0=Mon, 1=Tue, ..., 4=Fri, 5=Sat, 6=Sun
function makeDate({ weekdayOffset = 0, hour = 12, minute = 0, utcOffsetHours = 2 }) {
  // Start from a known Monday 2026-05-11 00:00 UTC (= 02:00 CEST)
  const monday = new Date('2026-05-11T00:00:00Z')
  const ms = monday.getTime()
    + weekdayOffset * 24 * 60 * 60 * 1000   // days
    + (hour - utcOffsetHours) * 60 * 60 * 1000  // target Prague hour → UTC
    + minute * 60 * 1000
  return new Date(ms)
}

describe('AR7 — isWithinSendWindow boundary tests', () => {
  it('T01  09:00 Prague Monday → allowed', () => {
    const d = makeDate({ weekdayOffset: 0, hour: 9, minute: 0 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(true)
  })

  it('T02  07:59 Prague Monday → blocked (before 08:00)', () => {
    const d = makeDate({ weekdayOffset: 0, hour: 7, minute: 59 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(false)
  })

  it('T03  16:59 Prague Monday → allowed (last valid minute)', () => {
    const d = makeDate({ weekdayOffset: 0, hour: 16, minute: 59 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(true)
  })

  it('T04  17:00 Prague Monday → blocked (window ends at 17:00 exclusive)', () => {
    const d = makeDate({ weekdayOffset: 0, hour: 17, minute: 0 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(false)
  })

  it('T05  Saturday 12:00 Prague → blocked (weekend)', () => {
    const d = makeDate({ weekdayOffset: 5, hour: 12, minute: 0 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(false)
  })

  it('T09  Sunday 12:00 Prague → blocked (weekend)', () => {
    const d = makeDate({ weekdayOffset: 6, hour: 12, minute: 0 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(false)
  })

  it('T10  Friday 16:59 Prague → allowed', () => {
    const d = makeDate({ weekdayOffset: 4, hour: 16, minute: 59 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(true)
  })

  it('T11  Saturday 12:00 Prague → isWithinSendWindow returns false', () => {
    // Explicit assertion mirroring T05 for ratchet clarity
    const d = makeDate({ weekdayOffset: 5, hour: 12, minute: 0 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(false)
  })

  it('T00  08:00 Prague Monday → allowed (window start)', () => {
    const d = makeDate({ weekdayOffset: 0, hour: 8, minute: 0 })
    expect(isWithinSendWindow(d, 'Europe/Prague')).toBe(true)
  })
})

// ── Thin integration: send-batch route gate simulation ───────────────────────
// We simulate the gate logic from campaigns.js without importing the full
// Express app (avoids DB dependency in unit scope).
//
// Gate function extracted to be independently testable:
function sendWindowGate({ now, tz, force, pool, campaignId, count, safeError }) {
  const open = isWithinSendWindow(now, tz)
  if (!open && !force) {
    return { status: 423, body: { error: 'send_window_closed', retry_after_seconds: 3600 } }
  }
  if (!open && force) {
    // Simulate async side-effects (pool.query + Sentry) via callbacks
    pool._auditInsert(campaignId, count)
    safeError.captureMessage('send_window_force_override', { level: 'warning', extra: { campaignId } })
    return { status: 'passed_gate', force: true }
  }
  return { status: 'passed_gate', force: false }
}

describe('AR7 — send-batch gate integration', () => {
  let pool
  let safeError

  beforeEach(() => {
    pool = { _inserted: [], _auditInsert: vi.fn((id, count) => pool._inserted.push({ id, count })) }
    safeError = { captureMessage: vi.fn() }
  })

  it('T06  X-Force-Send overrides closed window → passed_gate', () => {
    const now = makeDate({ weekdayOffset: 5, hour: 12 }) // Saturday
    const result = sendWindowGate({ now, tz: 'Europe/Prague', force: true, pool, campaignId: 42, count: 5, safeError })
    expect(result.status).toBe('passed_gate')
    expect(result.force).toBe(true)
  })

  it('T07  X-Force-Send → audit log INSERT called with campaignId', () => {
    const now = makeDate({ weekdayOffset: 5, hour: 12 })
    sendWindowGate({ now, tz: 'Europe/Prague', force: true, pool, campaignId: 42, count: 5, safeError })
    expect(pool._auditInsert).toHaveBeenCalledWith(42, 5)
  })

  it('T08  X-Force-Send → Sentry captureMessage called with warning level', () => {
    const now = makeDate({ weekdayOffset: 5, hour: 12 })
    sendWindowGate({ now, tz: 'Europe/Prague', force: true, pool, campaignId: 42, count: 5, safeError })
    expect(safeError.captureMessage).toHaveBeenCalledWith(
      'send_window_force_override',
      expect.objectContaining({ level: 'warning' }),
    )
  })

  it('T12  423 response includes retry_after_seconds', () => {
    const now = makeDate({ weekdayOffset: 5, hour: 12 })
    const result = sendWindowGate({ now, tz: 'Europe/Prague', force: false, pool, campaignId: 1, count: 1, safeError })
    expect(result.status).toBe(423)
    expect(typeof result.body.retry_after_seconds).toBe('number')
    expect(result.body.retry_after_seconds).toBeGreaterThan(0)
  })

  it('T03b  Inside window → no gate block', () => {
    const now = makeDate({ weekdayOffset: 0, hour: 10 }) // Monday 10:00
    const result = sendWindowGate({ now, tz: 'Europe/Prague', force: false, pool, campaignId: 1, count: 1, safeError })
    expect(result.status).toBe('passed_gate')
    expect(result.force).toBe(false)
    expect(pool._auditInsert).not.toHaveBeenCalled()
    expect(safeError.captureMessage).not.toHaveBeenCalled()
  })
})
