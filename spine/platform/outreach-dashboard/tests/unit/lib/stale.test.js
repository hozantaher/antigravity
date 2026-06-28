import { describe, it, expect } from 'vitest'
import { formatAge, isStale } from '../../../src/lib/stale.js'

const NOW = new Date('2026-04-21T12:00:00Z').getTime()
const ago = (ms) => NOW - ms

describe('formatAge', () => {
  it('returns "právě teď" for sub-5-second ages', () => {
    expect(formatAge(ago(0), NOW)).toBe('právě teď')
    expect(formatAge(ago(4999), NOW)).toBe('právě teď')
  })

  it('formats seconds between 5 s and 1 min', () => {
    expect(formatAge(ago(5_000), NOW)).toBe('před 5 s')
    expect(formatAge(ago(59_000), NOW)).toBe('před 59 s')
  })

  it('formats minutes between 1 min and 1 h', () => {
    expect(formatAge(ago(60_000), NOW)).toBe('před 1 min')
    expect(formatAge(ago(30 * 60_000), NOW)).toBe('před 30 min')
    expect(formatAge(ago(59 * 60_000), NOW)).toBe('před 59 min')
  })

  it('formats hours for ages >= 1 h', () => {
    expect(formatAge(ago(3_600_000), NOW)).toBe('před 1 h')
    expect(formatAge(ago(5 * 3_600_000), NOW)).toBe('před 5 h')
  })

  it('accepts Date instances and ISO strings', () => {
    expect(formatAge(new Date(ago(10_000)), NOW)).toBe('před 10 s')
    expect(formatAge(new Date(ago(10_000)).toISOString(), NOW)).toBe('před 10 s')
  })

  it('returns "—" for null / undefined / garbage', () => {
    expect(formatAge(null, NOW)).toBe('—')
    expect(formatAge(undefined, NOW)).toBe('—')
    expect(formatAge('not a date', NOW)).toBe('—')
  })

  it('clamps future timestamps (clock skew) to "právě teď"', () => {
    expect(formatAge(NOW + 10_000, NOW)).toBe('právě teď')
  })
})

describe('isStale', () => {
  const POLL = 60_000 // 60 s

  it('returns false when age <= pollMs * 2.5', () => {
    expect(isStale(ago(0), POLL, NOW)).toBe(false)
    expect(isStale(ago(POLL), POLL, NOW)).toBe(false)
    expect(isStale(ago(POLL * 2.5), POLL, NOW)).toBe(false)
  })

  it('returns true when age > pollMs * 2.5', () => {
    expect(isStale(ago(POLL * 2.5 + 1), POLL, NOW)).toBe(true)
    expect(isStale(ago(POLL * 10), POLL, NOW)).toBe(true)
  })

  it('returns false when loadedAt is missing', () => {
    expect(isStale(null, POLL, NOW)).toBe(false)
    expect(isStale(undefined, POLL, NOW)).toBe(false)
  })

  it('returns false when pollMs is 0 or non-positive (non-polling widget)', () => {
    expect(isStale(ago(10 * 60_000), 0, NOW)).toBe(false)
    expect(isStale(ago(10 * 60_000), -5, NOW)).toBe(false)
    expect(isStale(ago(10 * 60_000), NaN, NOW)).toBe(false)
  })
})
