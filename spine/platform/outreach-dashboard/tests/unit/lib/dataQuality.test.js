import { describe, it, expect } from 'vitest'
import {
  computeDataQuality,
  stalenessFactor,
  SIGNAL_WEIGHTS,
  STALENESS,
  MIN_MULTIPLIER_FLOOR,
} from '../../../src/lib/dataQuality.js'

const NOW = new Date('2026-04-19T00:00:00Z').getTime()
const days = (n) => new Date(NOW - n * 86400000).toISOString()

describe('stalenessFactor', () => {
  it('fresh facts (<90d) keep factor 1', () => {
    expect(stalenessFactor(days(0), NOW)).toBe(1)
    expect(stalenessFactor(days(89), NOW)).toBe(1)
  })
  it('linearly decays from 90 to 365 days', () => {
    const mid = stalenessFactor(days(227.5), NOW)
    expect(mid).toBeGreaterThan(STALENESS.expired_factor)
    expect(mid).toBeLessThan(1)
  })
  it('expired (>=365d) hits floor', () => {
    expect(stalenessFactor(days(365), NOW)).toBe(STALENESS.expired_factor)
    expect(stalenessFactor(days(2000), NOW)).toBe(STALENESS.expired_factor)
  })
  it('null/undefined fetched_at → expired floor', () => {
    expect(stalenessFactor(null, NOW)).toBe(STALENESS.expired_factor)
    expect(stalenessFactor(undefined, NOW)).toBe(STALENESS.expired_factor)
  })
})

describe('computeDataQuality — base signals from company row', () => {
  it('empty company → dqs is low but multiplier never below floor', () => {
    const r = computeDataQuality({}, [])
    expect(r.dqs).toBeCloseTo(0, 5)
    expect(r.multiplier).toBe(MIN_MULTIPLIER_FLOOR)
  })

  it('fully populated base row → all base signals present', () => {
    const r = computeDataQuality({
      ico: '12345678', email: 'info@firma.cz', website: 'https://firma.cz',
      sector: 'construction', velikost_firmy: 'medium', address: 'Praha',
    }, [])
    expect(r.signals.has_email.present).toBe(true)
    expect(r.signals.has_website.present).toBe(true)
    expect(r.signals.has_sector.present).toBe(true)
    expect(r.signals.has_size.present).toBe(true)
    expect(r.signals.has_address.present).toBe(true)
    expect(r.signals.is_active_entity.present).toBe(true)
  })

  it('dead entity (datum_zaniku set) → is_active_entity false', () => {
    const r = computeDataQuality({ ico: '111', datum_zaniku: '2024-01-01' }, [])
    expect(r.signals.is_active_entity.present).toBe(false)
  })

  it('v_likvidaci or v_insolvenci → is_active_entity false', () => {
    expect(computeDataQuality({ ico: '1', v_likvidaci: true }, []).signals.is_active_entity.present).toBe(false)
    expect(computeDataQuality({ ico: '1', v_insolvenci: true }, []).signals.is_active_entity.present).toBe(false)
  })

  it('handles legacy field names (web/odvetvi/size/adresa)', () => {
    const r = computeDataQuality({
      ico: '1', web: 'https://x.cz', odvetvi: 'agro', size: 'small', adresa: 'Brno',
    }, [])
    expect(r.signals.has_website.present).toBe(true)
    expect(r.signals.has_sector.present).toBe(true)
    expect(r.signals.has_size.present).toBe(true)
    expect(r.signals.has_address.present).toBe(true)
  })
})

describe('computeDataQuality — enrichment facts', () => {
  it('mx_provider=none/unknown does not count as present', () => {
    const r = computeDataQuality({}, [
      { field: 'mx_provider', value: 'none', fetched_at: days(0) },
    ])
    expect(r.signals.has_mx_provider.present).toBe(false)
    const r2 = computeDataQuality({}, [
      { field: 'mx_provider', value: 'unknown', fetched_at: days(0) },
    ])
    expect(r2.signals.has_mx_provider.present).toBe(false)
  })

  it('mx_provider=google_workspace counts as present', () => {
    const r = computeDataQuality({}, [
      { field: 'mx_provider', value: 'google_workspace', fetched_at: days(10) },
    ])
    expect(r.signals.has_mx_provider.present).toBe(true)
    expect(r.signals.has_mx_provider.contribution).toBeCloseTo(SIGNAL_WEIGHTS.has_mx_provider, 5)
  })

  it('SPF/DMARC nested booleans extracted correctly', () => {
    const r = computeDataQuality({}, [
      { field: 'spf',   value: { has_spf: true,   spf_strict: true },   fetched_at: days(0) },
      { field: 'dmarc', value: { has_dmarc: true, dmarc_policy: 'reject' }, fetched_at: days(0) },
    ])
    expect(r.signals.has_spf.present).toBe(true)
    expect(r.signals.has_dmarc.present).toBe(true)
  })

  it('SPF/DMARC absent → present=false', () => {
    const r = computeDataQuality({}, [
      { field: 'spf',   value: { has_spf: false, spf_strict: false }, fetched_at: days(0) },
      { field: 'dmarc', value: { has_dmarc: false, dmarc_policy: null }, fetched_at: days(0) },
    ])
    expect(r.signals.has_spf.present).toBe(false)
    expect(r.signals.has_dmarc.present).toBe(false)
  })

  it('revenue / employee_count count when > 0', () => {
    const r = computeDataQuality({}, [
      { field: 'revenue',        value: 10_000_000, fetched_at: days(0) },
      { field: 'employee_count', value: 25,         fetched_at: days(0) },
    ])
    expect(r.signals.has_revenue.present).toBe(true)
    expect(r.signals.has_employee_count.present).toBe(true)
  })

  it('arrays for tech_stack / tendr_history / statutari', () => {
    const r = computeDataQuality({}, [
      { field: 'tech_stack',    value: ['react', 'shopify'], fetched_at: days(0) },
      { field: 'tendr_history', value: [{ id: 1 }],          fetched_at: days(0) },
      { field: 'statutari',     value: ['Jan Novák'],         fetched_at: days(0) },
    ])
    expect(r.signals.has_tech_stack.present).toBe(true)
    expect(r.signals.has_tendr_history.present).toBe(true)
    expect(r.signals.has_statutari.present).toBe(true)
  })

  it('empty arrays → not present', () => {
    const r = computeDataQuality({}, [
      { field: 'tech_stack',    value: [], fetched_at: days(0) },
      { field: 'tendr_history', value: [], fetched_at: days(0) },
    ])
    expect(r.signals.has_tech_stack.present).toBe(false)
    expect(r.signals.has_tendr_history.present).toBe(false)
  })
})

describe('computeDataQuality — staleness affects contribution', () => {
  it('fresh fact contributes full weight, expired contributes 40%', () => {
    const fresh = computeDataQuality({}, [
      { field: 'mx_provider', value: 'google_workspace', fetched_at: days(0) },
    ])
    const expired = computeDataQuality({}, [
      { field: 'mx_provider', value: 'google_workspace', fetched_at: days(500) },
    ])
    expect(fresh.signals.has_mx_provider.contribution).toBeGreaterThan(
      expired.signals.has_mx_provider.contribution,
    )
    expect(expired.signals.has_mx_provider.fresh).toBe(STALENESS.expired_factor)
  })
})

describe('computeDataQuality — multiplier shape', () => {
  it('floor is honored at zero data', () => {
    const r = computeDataQuality({}, [])
    expect(r.multiplier).toBe(MIN_MULTIPLIER_FLOOR)
  })

  it('full data yields multiplier = 1.0', () => {
    const company = {
      ico: '1', email: 'a@b.cz', website: 'x.cz', sector: 's',
      velikost_firmy: 'medium', address: 'z',
    }
    const facts = [
      { field: 'mx_provider',    value: 'google_workspace', fetched_at: days(0) },
      { field: 'spf',            value: { has_spf: true },  fetched_at: days(0) },
      { field: 'dmarc',          value: { has_dmarc: true },fetched_at: days(0) },
      { field: 'revenue',        value: 1_000_000,          fetched_at: days(0) },
      { field: 'employee_count', value: 10,                 fetched_at: days(0) },
      { field: 'tech_stack',     value: ['x'],              fetched_at: days(0) },
      { field: 'tendr_history',  value: [1],                fetched_at: days(0) },
      { field: 'statutari',      value: ['x'],              fetched_at: days(0) },
    ]
    const r = computeDataQuality(company, facts)
    expect(r.dqs).toBe(1)
    expect(r.multiplier).toBe(1)
  })

  it('multiplier monotone in dqs', () => {
    const a = computeDataQuality({ ico: '1', email: 'a@b.cz' }, [])
    const b = computeDataQuality({ ico: '1', email: 'a@b.cz', website: 'x.cz' }, [])
    expect(b.multiplier).toBeGreaterThan(a.multiplier)
  })
})

describe('reflects parser version', () => {
  it('exposes version', () => {
    expect(computeDataQuality.version).toBe('dqs_v1')
  })
})
