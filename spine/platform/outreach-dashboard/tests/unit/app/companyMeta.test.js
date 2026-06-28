/**
 * companyMeta — Firmy presentation helpers.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/companyMeta
 */
import { describe, it, expect } from 'vitest'
import { icpMeta, scoreValue, companySubtitle, companyTitle } from '../../../src/app/lib/companyMeta'

describe('icpMeta', () => {
  it('maps the real icp_tier domain (ideal/good/marginal), null for irrelevant/blank', () => {
    // Domain = features/acquisition/contacts/classify/icp.go ICPTier: ideal·good·marginal·irrelevant
    expect(icpMeta('ideal').label).toBe('ICP ideál')
    expect(icpMeta('good').label).toBe('ICP dobré')
    expect(icpMeta('marginal').label).toBe('ICP slabší')
    expect(icpMeta('irrelevant')).toBeNull()
    // 'excellent'/'fair' were never emitted by the classifier — no chip.
    expect(icpMeta('excellent')).toBeNull()
    expect(icpMeta(null)).toBeNull()
  })
})

describe('scoreValue', () => {
  it('rounds composite, falls back to targeting, null when unscored', () => {
    expect(scoreValue({ composite_score: 36.7 })).toBe(37)
    expect(scoreValue({ best_targeting_score: 18.2 })).toBe(18)
    expect(scoreValue({ composite_score: 0 })).toBe(0)
    expect(scoreValue({})).toBeNull()
  })
})

describe('companySubtitle + companyTitle', () => {
  it('joins sector + locality, omits blanks', () => {
    expect(companySubtitle({ sector_primary: 'agriculture', address_locality: 'Brno' })).toBe('agriculture · Brno')
    expect(companySubtitle({ sector_primary: 'agriculture' })).toBe('agriculture')
    expect(companySubtitle({})).toBe('')
  })
  it('title prefers name, then ico, then placeholder', () => {
    expect(companyTitle({ name: 'ACME s.r.o.' })).toBe('ACME s.r.o.')
    expect(companyTitle({ ico: '12345678' })).toBe('12345678')
    expect(companyTitle({})).toBe('Bez názvu')
  })
})
