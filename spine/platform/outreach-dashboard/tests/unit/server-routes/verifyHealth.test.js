// verifyHealth.test.js — ADD-2 (2026-05-14)
// ─────────────────────────────────────────────────────────────────────────────
// Unit coverage for the classifyVerifyHealth pure helper used by the
// GET /api/verify-queue/health endpoint. Verifies the threshold cliffs
// (45 min stale, 90 min stuck) + pre-condition gates (paused / disabled /
// no_ticks_yet).

import { describe, it, expect } from 'vitest'
import {
  classifyVerifyHealth,
  VERIFY_HEALTH_STUCK_MINUTES_DEFAULT,
  VERIFY_HEALTH_STALE_MINUTES_DEFAULT,
} from '../../../src/server-routes/verifyLoop.js'

const NOW = new Date('2026-05-14T12:00:00Z')

function minutesAgo(min) {
  return new Date(NOW.getTime() - min * 60_000)
}

describe('classifyVerifyHealth', () => {
  it('paused — short-circuits to status_reason=paused regardless of last tick', () => {
    const h = classifyVerifyHealth(minutesAgo(5), { enabled: true, paused: true, now: NOW })
    expect(h.status_reason).toBe('paused')
    expect(h.is_healthy).toBe(false)
    expect(h.minutes_since_last_tick).toBeNull()
  })

  it('disabled — short-circuits to status_reason=disabled', () => {
    const h = classifyVerifyHealth(minutesAgo(5), { enabled: false, paused: false, now: NOW })
    expect(h.status_reason).toBe('disabled')
    expect(h.is_healthy).toBe(false)
  })

  it('null last_tick + enabled — status_reason=no_ticks_yet', () => {
    const h = classifyVerifyHealth(null, { enabled: true, paused: false, now: NOW })
    expect(h.status_reason).toBe('no_ticks_yet')
    expect(h.is_healthy).toBe(false)
  })

  it('invalid date string — treated as no_ticks_yet', () => {
    const h = classifyVerifyHealth('not-a-date', { enabled: true, paused: false, now: NOW })
    expect(h.status_reason).toBe('no_ticks_yet')
  })

  it('running — last tick < stale threshold returns is_healthy=true', () => {
    const h = classifyVerifyHealth(minutesAgo(5), { enabled: true, paused: false, now: NOW })
    expect(h.status_reason).toBe('running')
    expect(h.is_healthy).toBe(true)
    expect(h.minutes_since_last_tick).toBe(5)
  })

  it('running — exactly 1 minute below stale threshold still running', () => {
    const h = classifyVerifyHealth(
      minutesAgo(VERIFY_HEALTH_STALE_MINUTES_DEFAULT - 1),
      { enabled: true, paused: false, now: NOW },
    )
    expect(h.status_reason).toBe('running')
  })

  it('stale — at stale threshold flips to stale', () => {
    const h = classifyVerifyHealth(
      minutesAgo(VERIFY_HEALTH_STALE_MINUTES_DEFAULT),
      { enabled: true, paused: false, now: NOW },
    )
    expect(h.status_reason).toBe('stale')
    expect(h.is_healthy).toBe(false)
  })

  it('stuck — at stuck threshold flips to stuck (red)', () => {
    const h = classifyVerifyHealth(
      minutesAgo(VERIFY_HEALTH_STUCK_MINUTES_DEFAULT),
      { enabled: true, paused: false, now: NOW },
    )
    expect(h.status_reason).toBe('stuck')
    expect(h.is_healthy).toBe(false)
  })

  it('stuck — well past stuck threshold remains stuck (not paused/disabled)', () => {
    const h = classifyVerifyHealth(minutesAgo(720), { enabled: true, paused: false, now: NOW })
    expect(h.status_reason).toBe('stuck')
    expect(h.minutes_since_last_tick).toBe(720)
  })

  it('exposes the resolved thresholds back to the caller', () => {
    const h = classifyVerifyHealth(minutesAgo(5), {
      enabled: true,
      paused: false,
      stuckMinutes: 120,
      staleMinutes: 60,
      now: NOW,
    })
    expect(h.stuck_threshold_minutes).toBe(120)
    expect(h.stale_threshold_minutes).toBe(60)
  })

  it('respects operator overrides — custom stuck threshold trips earlier', () => {
    // 30 min ago + custom stuck=20 → stuck.
    const h = classifyVerifyHealth(minutesAgo(30), {
      enabled: true,
      paused: false,
      stuckMinutes: 20,
      staleMinutes: 10,
      now: NOW,
    })
    expect(h.status_reason).toBe('stuck')
  })
})
