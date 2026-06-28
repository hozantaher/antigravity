// Tests for useWatchdogSnooze + pure helpers (alertKey, snoozeUntil, pruneExpired)
// Memory feedback_extreme_testing: ≥10 cases required.

import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  alertKey,
  snoozeUntil,
  pruneExpired,
  useWatchdogSnooze,
} from '../../../src/hooks/useWatchdogSnooze'

const LS_KEY = 'watchdog:snoozed:v1'

// --- localStorage mock (simple in-memory store) ---
let lsStore = {}
const lsMock = {
  getItem: vi.fn((k) => lsStore[k] ?? null),
  setItem: vi.fn((k, v) => { lsStore[k] = v }),
  removeItem: vi.fn((k) => { delete lsStore[k] }),
  clear: vi.fn(() => { lsStore = {} }),
}
Object.defineProperty(globalThis, 'localStorage', { value: lsMock, writable: true })

beforeEach(() => {
  lsStore = {}
  vi.restoreAllMocks()
  // Re-wire mocks after restoreAllMocks
  lsMock.getItem.mockImplementation((k) => lsStore[k] ?? null)
  lsMock.setItem.mockImplementation((k, v) => { lsStore[k] = v })
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Pure helper tests ──────────────────────────────────────────────────────

describe('alertKey', () => {
  it('returns stable key combining check_name, target, severity', () => {
    const ev = { check_name: 'bounce_rate_high', target: 'mb@test.cz', severity: 'critical' }
    expect(alertKey(ev)).toBe('bounce_rate_high::mb@test.cz::critical')
  })

  it('uses empty string for missing target', () => {
    const ev = { check_name: 'auth_fail_alert', severity: 'warn' }
    expect(alertKey(ev)).toBe('auth_fail_alert::::warn')
  })

  it('falls back to mailbox field when target absent', () => {
    const ev = { check_name: 'stale_email_domain', mailbox: 'a@b.cz', severity: 'info' }
    expect(alertKey(ev)).toBe('stale_email_domain::a@b.cz::info')
  })
})

describe('snoozeUntil', () => {
  it('1h adds exactly 3600000 ms', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const expected = new Date('2026-05-05T11:00:00.000Z').getTime()
    expect(snoozeUntil('1h')).toBe(expected)
  })

  it('4h adds exactly 14400000 ms', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const expected = new Date('2026-05-05T14:00:00.000Z').getTime()
    expect(snoozeUntil('4h')).toBe(expected)
  })

  it('end_of_day computes 23:59:59.999 of today', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const result = snoozeUntil('end_of_day')
    const d = new Date(result)
    expect(d.getHours()).toBe(23)
    expect(d.getMinutes()).toBe(59)
    expect(d.getSeconds()).toBe(59)
  })

  it('permanent returns year-2099 timestamp', () => {
    const result = snoozeUntil('permanent')
    expect(new Date(result).getFullYear()).toBe(2099)
  })

  it('unknown option throws', () => {
    expect(() => snoozeUntil('unknown')).toThrow(/Unknown snooze option/)
  })
})

describe('pruneExpired', () => {
  it('removes entries whose timestamp is in the past', () => {
    const now = 1000000
    const map = { a: now - 1, b: now + 1000 }
    expect(pruneExpired(map, now)).toEqual({ b: now + 1000 })
  })

  it('removes entries equal to now (not strictly greater)', () => {
    const now = 1000000
    const map = { a: now }
    expect(pruneExpired(map, now)).toEqual({})
  })

  it('keeps all entries when none are expired', () => {
    const now = 1000
    const map = { x: 2000, y: 9999 }
    expect(pruneExpired(map, now)).toEqual(map)
  })

  it('returns empty object for empty input', () => {
    expect(pruneExpired({}, 0)).toEqual({})
  })
})

// ── Hook integration tests ─────────────────────────────────────────────────

const EV = { id: 1, check_name: 'stuck_campaign_contact', severity: 'warn' }
const EV2 = { id: 2, check_name: 'auth_fail_alert', severity: 'critical' }

describe('useWatchdogSnooze — basic snooze/unsnooze', () => {
  it('isSnoozed returns false by default', () => {
    const { result } = renderHook(() => useWatchdogSnooze())
    expect(result.current.isSnoozed(EV)).toBe(false)
  })

  it('snooze(ev, "1h") → isSnoozed returns true', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const { result } = renderHook(() => useWatchdogSnooze())
    act(() => result.current.snooze(EV, '1h'))
    expect(result.current.isSnoozed(EV)).toBe(true)
  })

  it('unsnooze removes the snooze', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const { result } = renderHook(() => useWatchdogSnooze())
    act(() => result.current.snooze(EV, '1h'))
    act(() => result.current.unsnooze(EV))
    expect(result.current.isSnoozed(EV)).toBe(false)
  })

  it('snooze persists to localStorage', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const { result } = renderHook(() => useWatchdogSnooze())
    act(() => result.current.snooze(EV, '4h'))
    const stored = JSON.parse(lsStore[LS_KEY])
    expect(stored[alertKey(EV)]).toBeGreaterThan(Date.now())
  })
})

describe('useWatchdogSnooze — multiple independent alerts', () => {
  it('snoozed and unsnoozed alerts are tracked independently', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const { result } = renderHook(() => useWatchdogSnooze())
    act(() => result.current.snooze(EV, '1h'))
    act(() => result.current.snooze(EV2, '4h'))
    expect(result.current.isSnoozed(EV)).toBe(true)
    expect(result.current.isSnoozed(EV2)).toBe(true)
    act(() => result.current.unsnooze(EV))
    expect(result.current.isSnoozed(EV)).toBe(false)
    expect(result.current.isSnoozed(EV2)).toBe(true)
  })
})

describe('useWatchdogSnooze — expiry', () => {
  it('isSnoozed returns false once time passes snooze deadline', () => {
    vi.useFakeTimers()
    const start = new Date('2026-05-05T10:00:00.000Z')
    vi.setSystemTime(start)
    const { result } = renderHook(() => useWatchdogSnooze())
    act(() => result.current.snooze(EV, '1h'))
    expect(result.current.isSnoozed(EV)).toBe(true)
    // Advance past the 1h snooze
    vi.advanceTimersByTime(61 * 60 * 1000)
    expect(result.current.isSnoozed(EV)).toBe(false)
  })
})

describe('useWatchdogSnooze — localStorage persistence across re-mount', () => {
  it('re-mounting hook reloads snoozed alerts from localStorage', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))

    // First mount: snooze
    const { result: r1, unmount } = renderHook(() => useWatchdogSnooze())
    act(() => r1.current.snooze(EV, '4h'))
    unmount()

    // Second mount: should read from localStorage
    const { result: r2 } = renderHook(() => useWatchdogSnooze())
    expect(r2.current.isSnoozed(EV)).toBe(true)
  })
})

describe('useWatchdogSnooze — pruneNow', () => {
  it('pruneNow removes expired entries from state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const { result } = renderHook(() => useWatchdogSnooze())
    act(() => result.current.snooze(EV, '1h'))
    // Advance past expiry
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    act(() => result.current.pruneNow())
    expect(result.current.snoozeMap[alertKey(EV)]).toBeUndefined()
  })
})

describe('useWatchdogSnooze — permanent option', () => {
  it('permanent snooze is still active many years from now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const { result } = renderHook(() => useWatchdogSnooze())
    act(() => result.current.snooze(EV, 'permanent'))
    // Advance 10 years
    vi.advanceTimersByTime(10 * 365 * 24 * 60 * 60 * 1000)
    expect(result.current.isSnoozed(EV)).toBe(true)
  })
})

describe('useWatchdogSnooze — corrupted localStorage', () => {
  it('tolerates invalid JSON in localStorage gracefully', () => {
    lsStore[LS_KEY] = 'NOT_JSON'
    expect(() => renderHook(() => useWatchdogSnooze())).not.toThrow()
  })

  it('tolerates non-object value in localStorage gracefully', () => {
    lsStore[LS_KEY] = JSON.stringify([1, 2, 3])
    const { result } = renderHook(() => useWatchdogSnooze())
    expect(result.current.isSnoozed(EV)).toBe(false)
  })
})
