import { describe, it, expect } from 'vitest'
import {
  tierFactor,
  effectiveTtlDays,
  evaluateRefresh,
  planRefreshJobs,
  TIER_TTL_FACTOR,
  MIN_DAYS,
  MAX_DAYS,
  DEFAULT_TIER_FACTOR,
} from '../../../src/lib/refreshPolicy.js'

const NOW = new Date('2026-04-19T00:00:00Z')
const days = (n) => new Date(NOW.getTime() - n * 86400000)

describe('tierFactor', () => {
  it.each([
    ['S', 0.3], ['A', 0.5], ['B', 1.0], ['C', 1.6], ['D', 2.5],
  ])('tier %s → factor %f', (tier, expected) => {
    expect(tierFactor(tier)).toBe(expected)
  })
  it('lowercase tier still maps', () => {
    expect(tierFactor('s')).toBe(0.3)
  })
  it('null/unknown → default factor', () => {
    expect(tierFactor(null)).toBe(DEFAULT_TIER_FACTOR)
    expect(tierFactor('mystery')).toBe(DEFAULT_TIER_FACTOR)
  })
})

describe('effectiveTtlDays — clamping', () => {
  it('S tier with 90d source ttl → 27 days (above MIN_DAYS)', () => {
    expect(effectiveTtlDays('S', 90)).toBe(27)
  })
  it('S tier with very short TTL clamped to MIN_DAYS', () => {
    expect(effectiveTtlDays('S', 10)).toBe(MIN_DAYS)
  })
  it('D tier with long TTL clamped to MAX_DAYS', () => {
    expect(effectiveTtlDays('D', 1000)).toBe(MAX_DAYS)
  })
  it('zero or invalid source TTL → MAX_DAYS (treat as never)', () => {
    expect(effectiveTtlDays('B', 0)).toBe(MAX_DAYS)
    expect(effectiveTtlDays('B', null)).toBe(MAX_DAYS)
    expect(effectiveTtlDays('B', 'oops')).toBe(MAX_DAYS)
  })
})

describe('evaluateRefresh', () => {
  it('dead entity is never due', () => {
    const r = evaluateRefresh({
      tier: 'S', sourceTtlDays: 30,
      lastFetchedAt: days(1000), deadEntity: true, now: NOW,
    })
    expect(r.due).toBe(false)
    expect(r.reason).toBe('dead_entity')
  })

  it('never_fetched → due immediately', () => {
    const r = evaluateRefresh({
      tier: 'B', sourceTtlDays: 30, lastFetchedAt: null, now: NOW,
    })
    expect(r.due).toBe(true)
    expect(r.reason).toBe('never_fetched')
  })

  it('fresh fact within TTL → not due', () => {
    const r = evaluateRefresh({
      tier: 'B', sourceTtlDays: 90, lastFetchedAt: days(10), now: NOW,
    })
    expect(r.due).toBe(false)
    expect(r.reason).toBe('fresh')
    expect(r.next_due_at.getTime()).toBeGreaterThan(NOW.getTime())
  })

  it('stale fact past TTL → due', () => {
    const r = evaluateRefresh({
      tier: 'B', sourceTtlDays: 90, lastFetchedAt: days(120), now: NOW,
    })
    expect(r.due).toBe(true)
    expect(r.reason).toBe('stale')
  })

  it('S-tier company gets refreshed sooner than D-tier (same source)', () => {
    const fetched = days(40)
    const sTier = evaluateRefresh({ tier: 'S', sourceTtlDays: 90, lastFetchedAt: fetched, now: NOW })
    const dTier = evaluateRefresh({ tier: 'D', sourceTtlDays: 90, lastFetchedAt: fetched, now: NOW })
    expect(sTier.effective_ttl_days).toBeLessThan(dTier.effective_ttl_days)
  })

  it('age_days computed in days', () => {
    const r = evaluateRefresh({
      tier: 'B', sourceTtlDays: 30, lastFetchedAt: days(7), now: NOW,
    })
    expect(r.age_days).toBeCloseTo(7, 1)
  })

  it('invalid fetched_at → due (treat as never)', () => {
    const r = evaluateRefresh({
      tier: 'B', sourceTtlDays: 30, lastFetchedAt: 'not-a-date', now: NOW,
    })
    expect(r.due).toBe(true)
    expect(r.reason).toBe('invalid_fetched_at')
  })
})

describe('planRefreshJobs', () => {
  const rows = [
    { company_id: 1, score_tier: 'S', source: 'mx_lookup',  source_ttl_days: 180, last_fetched_at: days(70) }, // S 180×0.3=54, age 70 → due
    { company_id: 2, score_tier: 'D', source: 'mx_lookup',  source_ttl_days: 180, last_fetched_at: days(70) }, // D 180×2.5=450, fresh
    { company_id: 3, score_tier: 'B', source: 'mx_lookup',  source_ttl_days: 180, last_fetched_at: null      }, // never → due
    { company_id: 4, score_tier: 'A', source: 'mx_lookup',  source_ttl_days: 180, last_fetched_at: days(30), dead_entity: true }, // dead, skip
  ]

  it('returns jobs for due rows only', () => {
    const jobs = planRefreshJobs(rows, { now: NOW })
    const ids = jobs.map(j => j.company_id).sort()
    expect(ids).toEqual([1, 3])
  })

  it('each job has company_id, source, scheduled_at', () => {
    const jobs = planRefreshJobs(rows, { now: NOW })
    for (const j of jobs) {
      expect(j.company_id).toBeTypeOf('number')
      expect(j.source).toBe('mx_lookup')
      expect(j.scheduled_at).toBeInstanceOf(Date)
      expect(j.reason).toMatch(/stale|never_fetched/)
    }
  })

  it('empty input → empty output', () => {
    expect(planRefreshJobs([])).toEqual([])
    expect(planRefreshJobs(null)).toEqual([])
  })

  it('reflects parser version', () => {
    expect(planRefreshJobs.version).toBe('refresh_v1')
  })
})
