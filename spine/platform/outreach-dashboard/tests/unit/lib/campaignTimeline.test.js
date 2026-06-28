import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  TIMELINE_EVENT_ICON,
  TIMELINE_EVENT_LABEL,
  CLASSIFICATION_CLASS,
  CLASSIFICATION_LABEL,
  TIMELINE_DEFAULT_LIMIT,
  relativeTime,
} from '../../../src/lib/campaignTimeline.js'

describe('campaignTimeline — static dictionaries', () => {
  it('every event icon key has a matching label', () => {
    expect(Object.keys(TIMELINE_EVENT_ICON).sort()).toEqual(
      Object.keys(TIMELINE_EVENT_LABEL).sort()
    )
  })

  it('every classification class key has a matching label', () => {
    expect(Object.keys(CLASSIFICATION_CLASS).sort()).toEqual(
      Object.keys(CLASSIFICATION_LABEL).sort()
    )
  })

  it('default page limit is a positive integer named constant', () => {
    expect(Number.isInteger(TIMELINE_DEFAULT_LIMIT)).toBe(true)
    expect(TIMELINE_DEFAULT_LIMIT).toBeGreaterThan(0)
  })
})

describe('relativeTime — compact Czech elapsed formatter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Anchor "now" so the time-delta buckets are deterministic.
  const NOW = new Date('2026-06-02T12:00:00.000Z')
  const ago = (ms) => new Date(NOW.getTime() - ms).toISOString()
  const SEC = 1000
  const MIN = 60 * SEC
  const HR = 60 * MIN
  const DAY = 24 * HR

  function withNow(fn) {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    try {
      return fn()
    } finally {
      vi.useRealTimers()
    }
  }

  it('returns em-dash for null/empty/undefined', () => {
    expect(relativeTime(null)).toBe('—')
    expect(relativeTime(undefined)).toBe('—')
    expect(relativeTime('')).toBe('—')
  })

  it('seconds bucket below 1 minute', () => {
    withNow(() => {
      expect(relativeTime(ago(5 * SEC))).toBe('5s')
      expect(relativeTime(ago(0))).toBe('0s')
    })
  })

  it('crosses to minutes exactly at 60s boundary', () => {
    withNow(() => {
      expect(relativeTime(ago(59 * SEC))).toBe('59s')
      expect(relativeTime(ago(60 * SEC))).toBe('1 min')
    })
  })

  it('crosses to hours exactly at 60min boundary', () => {
    withNow(() => {
      expect(relativeTime(ago(59 * MIN))).toBe('59 min')
      expect(relativeTime(ago(60 * MIN))).toBe('1 h')
    })
  })

  it('crosses to days exactly at 24h boundary', () => {
    withNow(() => {
      expect(relativeTime(ago(23 * HR))).toBe('23 h')
      expect(relativeTime(ago(24 * HR))).toBe('1 d')
    })
  })

  it('crosses to months exactly at 30d boundary', () => {
    withNow(() => {
      expect(relativeTime(ago(29 * DAY))).toBe('29 d')
      expect(relativeTime(ago(30 * DAY))).toBe('1 měs')
      expect(relativeTime(ago(90 * DAY))).toBe('3 měs')
    })
  })
})
