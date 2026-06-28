import { describe, it, expect } from 'vitest'
import {
  computeReadiness,
  recencyGap,
  fatigueInverse,
  deliverability,
  suppressionClear,
  reachability,
  RECENCY_HALFLIFE_DAYS,
  FATIGUE_THRESHOLD,
  FATIGUE_SATURATION,
  READINESS_WEIGHTS,
} from '../../../src/lib/readiness.js'

const NOW = new Date('2026-04-19T00:00:00Z').getTime()
const days = (n) => new Date(NOW - n * 86400000)

describe('recencyGap', () => {
  it('never contacted → 1', () => {
    expect(recencyGap(null, NOW)).toBe(1)
    expect(recencyGap(undefined, NOW)).toBe(1)
  })
  it('contacted today → ~0', () => {
    expect(recencyGap(days(0), NOW)).toBeCloseTo(0, 5)
  })
  it('halflife days → 0.5', () => {
    expect(recencyGap(days(RECENCY_HALFLIFE_DAYS), NOW)).toBeCloseTo(0.5, 5)
  })
  it('asymptote toward 1 over many halflives', () => {
    expect(recencyGap(days(600), NOW)).toBeGreaterThan(0.99)
  })
})

describe('fatigueInverse', () => {
  it('zero contacts → 1', () => {
    expect(fatigueInverse(0)).toBe(1)
  })
  it('at threshold → 1', () => {
    expect(fatigueInverse(FATIGUE_THRESHOLD)).toBe(1)
  })
  it('at saturation → 0', () => {
    expect(fatigueInverse(FATIGUE_SATURATION)).toBe(0)
  })
  it('above saturation clamped to 0', () => {
    expect(fatigueInverse(99)).toBe(0)
  })
  it('negative input → 1 (treated as 0)', () => {
    expect(fatigueInverse(-5)).toBe(1)
  })
  it('linear ramp midpoint', () => {
    const mid = (FATIGUE_THRESHOLD + FATIGUE_SATURATION) / 2
    expect(fatigueInverse(mid)).toBeCloseTo(0.5, 5)
  })
})

describe('deliverability', () => {
  it('full SPF strict + DMARC reject + good MX + zero bounces → 1', () => {
    const r = deliverability(
      { total_sent: 100, total_bounced: 0 },
      [
        { field: 'spf',         value: { spf_strict: true, has_spf: true } },
        { field: 'dmarc',       value: { dmarc_policy: 'reject', has_dmarc: true } },
        { field: 'mx_provider', value: 'google_workspace' },
      ],
    )
    expect(r).toBe(1)
  })
  it('no facts + no sends → 0.25 (only bounce-rate clean)', () => {
    expect(deliverability({}, [])).toBeCloseTo(0.25, 5)
  })
  it('high bounce rate → drops deliverability', () => {
    const high = deliverability({ total_sent: 100, total_bounced: 30 }, [])
    const low  = deliverability({ total_sent: 100, total_bounced: 1  }, [])
    expect(high).toBeLessThan(low)
  })
  it('soft SPF (~all) and DMARC p=none counts as half', () => {
    const r = deliverability({ total_sent: 100, total_bounced: 0 }, [
      { field: 'spf',   value: { has_spf: true, spf_strict: false } },
      { field: 'dmarc', value: { has_dmarc: true, dmarc_policy: 'none' } },
    ])
    expect(r).toBeGreaterThan(0.25)
    expect(r).toBeLessThan(1)
  })
})

describe('suppressionClear', () => {
  it('clean status → 1', () => {
    expect(suppressionClear({ status: 'active' })).toBe(1)
  })
  it('blacklisted → 0', () => {
    expect(suppressionClear({ status: 'blacklisted' })).toBe(0)
  })
  it('unsubscribed → 0', () => {
    expect(suppressionClear({ status: 'unsubscribed' })).toBe(0)
  })
  it('dead entity → 0 even if status active', () => {
    expect(suppressionClear({ status: 'active', datum_zaniku: '2024-01-01' })).toBe(0)
    expect(suppressionClear({ status: 'active', v_likvidaci: true })).toBe(0)
    expect(suppressionClear({ status: 'active', v_insolvenci: true })).toBe(0)
  })
})

describe('reachability', () => {
  it('no email → 0', () => {
    expect(reachability({})).toBe(0)
  })
  it('valid email → 1', () => {
    expect(reachability({ email: 'a@b.cz', email_status: 'valid' })).toBe(1)
    expect(reachability({ email: 'a@b.cz', email_status: 'verified' })).toBe(1)
  })
  it('invalid → 0 (verified-undeliverable), risky → 0.4 (uncertain)', () => {
    expect(reachability({ email: 'a@b.cz', email_status: 'invalid' })).toBe(0)
    expect(reachability({ email: 'a@b.cz', email_status: 'risky' })).toBe(0.4)
  })
  it('unknown status → 0.7', () => {
    expect(reachability({ email: 'a@b.cz' })).toBe(0.7)
  })
})

describe('computeReadiness — integration', () => {
  it('perfect company → score near 100', () => {
    const r = computeReadiness(
      {
        email: 'a@b.cz', email_status: 'valid', status: 'active',
        last_contacted: null, recent_60d_count: 0,
        total_sent: 100, total_bounced: 0,
      },
      [
        { field: 'spf',         value: { spf_strict: true, has_spf: true } },
        { field: 'dmarc',       value: { dmarc_policy: 'reject', has_dmarc: true } },
        { field: 'mx_provider', value: 'google_workspace' },
      ],
      { now: NOW },
    )
    expect(r.score).toBe(100)
  })

  it('blacklisted company → suppression_clear=0 forces score down', () => {
    const r = computeReadiness({ email: 'a@b.cz', status: 'blacklisted' }, [], { now: NOW })
    expect(r.components.suppression_clear).toBe(0)
    expect(r.score).toBeLessThan(80)
  })

  it('over-fatigued company → fatigue_inverse=0', () => {
    const r = computeReadiness({
      email: 'a@b.cz', last_contacted: days(1), recent_60d_count: 99,
    }, [], { now: NOW })
    expect(r.components.fatigue_inverse).toBe(0)
  })

  it('returns components object for UI', () => {
    const r = computeReadiness({}, [], { now: NOW })
    expect(Object.keys(r.components).sort()).toEqual(
      ['deliverability','fatigue_inverse','reachability','recency_gap','suppression_clear'],
    )
  })

  it('reflects parser version', () => {
    expect(computeReadiness.version).toBe('readiness_v1')
  })

  it('weighted sum is correct shape', () => {
    const r = computeReadiness({}, [], { now: NOW })
    expect(r.weights).toEqual(READINESS_WEIGHTS)
  })
})
