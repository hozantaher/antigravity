// AV-F5-A — Unit tests for prospectScorer.
//
// 10 cases per spec, covering all factor branches + exclusion paths.
//
//   1. Ideal tier + verified email + never contacted        → score >= 85
//   2. Irrelevant tier + invalid email                      → score = 0, excluded=true
//   3. Good tier + recently contacted (< 90d)               → never_contacted_weight = 0 → lower
//   4. Fleet keyword in company name boosts vs. no-fleet
//   5. Sector match boosts vs. unknown sector
//   6. email_status='bounced' → score=0 + factors.excluded=true
//   7. Missing company JOIN  → fallback weights, score around 30-40
//   8. crm_client_id IS NOT NULL → score = null + factors.excluded=true
//   9. Email confidence >= 0.7 (no status verified) → email_quality_weight = 0.7
//  10. Old contact (created_at > 180d, last_contacted NULL) → recency_weight = 0.2

import { describe, test, expect } from 'vitest'
import {
  scoreProspect,
  icpTierWeight,
  emailQualityWeight,
  neverContactedWeight,
  recencyWeight,
  sectorMatchWeight,
  fleetSignalWeight,
  isExcludedEmailStatus,
  SCORER_VERSION,
  ICP_TIER_WEIGHT_IDEAL,
  ICP_TIER_WEIGHT_GOOD,
  ICP_TIER_WEIGHT_UNKNOWN,
  EMAIL_QUALITY_WEIGHT_VERIFIED,
  EMAIL_QUALITY_WEIGHT_HIGH_CONFIDENCE,
  EMAIL_QUALITY_WEIGHT_UNKNOWN,
  NEVER_CONTACTED_WEIGHT_FRESH,
  NEVER_CONTACTED_WEIGHT_COOLDOWN,
  RECENCY_WEIGHT_OLD,
  SECTOR_MATCH_WEIGHT_FULL,
  SECTOR_MATCH_WEIGHT_NONE,
  FLEET_SIGNAL_WEIGHT_MATCH,
  FLEET_SIGNAL_WEIGHT_NONE,
  EXCLUDED_EMAIL_STATUSES,
} from '../../../src/lib/prospectScorer.js'

const FIXED_NOW = new Date('2026-05-19T12:00:00Z')

function daysAgo(d) {
  return new Date(FIXED_NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()
}

describe('AV-F5-A prospectScorer — primary cases', () => {
  test('case 1 — ideal tier + verified email + never contacted + recent + sector + fleet → score >= 85', () => {
    const contact = {
      crm_client_id: null,
      email_status: 'verified',
      email_confidence: 0.95,
      last_contacted: null,
      created_at: daysAgo(10),
    }
    const company = {
      icp_tier: 'ideal',
      sector_primary: 'machinery',
      category_path: 'B/machinery/cranes',
      name: 'Strojírna ABC s.r.o.',
    }
    const r = scoreProspect(contact, company, { now: FIXED_NOW })
    expect(r.score).toBeGreaterThanOrEqual(85)
    expect(r.factors.excluded).toBe(false)
    expect(r.factors.icp_tier_weight).toBe(ICP_TIER_WEIGHT_IDEAL)
    expect(r.factors.email_quality_weight).toBe(EMAIL_QUALITY_WEIGHT_VERIFIED)
    expect(r.factors.never_contacted_weight).toBe(NEVER_CONTACTED_WEIGHT_FRESH)
    expect(r.factors.sector_match_weight).toBe(SECTOR_MATCH_WEIGHT_FULL)
    expect(r.factors.fleet_signal_weight).toBe(FLEET_SIGNAL_WEIGHT_MATCH)
    expect(r.scorer_version).toBe(SCORER_VERSION)
  })

  test('case 2 — irrelevant tier + invalid email → excluded, score=0', () => {
    const contact = {
      crm_client_id: null,
      email_status: 'invalid',
      email_confidence: 0.0,
      last_contacted: null,
      created_at: daysAgo(10),
    }
    const company = {
      icp_tier: 'irrelevant',
      sector_primary: null,
      category_path: null,
      name: 'Random LLC',
    }
    const r = scoreProspect(contact, company, { now: FIXED_NOW })
    expect(r.score).toBe(0)
    expect(r.factors.excluded).toBe(true)
    expect(r.factors.excluded_reason).toBe('email_status_invalid')
  })

  test('case 3 — good tier + recently contacted (< 90d) → never_contacted_weight=0, lower score', () => {
    const contact = {
      crm_client_id: null,
      email_status: 'verified',
      email_confidence: 0.9,
      last_contacted: daysAgo(30),   // inside 90d cooldown
      created_at: daysAgo(40),
    }
    const company = {
      icp_tier: 'good',
      sector_primary: 'machinery',
      category_path: null,
      name: 'Strojírny XY',
    }
    const r = scoreProspect(contact, company, { now: FIXED_NOW })
    expect(r.factors.never_contacted_weight).toBe(NEVER_CONTACTED_WEIGHT_COOLDOWN)
    expect(r.factors.icp_tier_weight).toBe(ICP_TIER_WEIGHT_GOOD)
    // ICP 50*0.7=35, email 10, never 0, recency 5*0.5=2.5, sector 10, fleet 10 = 67.5
    expect(r.score).toBeLessThan(85)
    expect(r.score).toBeGreaterThan(50)
  })

  test('case 4 — fleet keyword in company name boosts vs. no-fleet equivalent', () => {
    const base = {
      crm_client_id: null,
      email_status: 'verified',
      email_confidence: 0.9,
      last_contacted: null,
      created_at: daysAgo(10),
    }
    const fleetCompany = {
      icp_tier: 'good',
      sector_primary: null,            // sector unknown so we isolate the fleet signal
      category_path: null,
      name: 'AutoServis Bagr s.r.o.',  // matches /bagr/
    }
    const plainCompany = {
      icp_tier: 'good',
      sector_primary: null,
      category_path: null,
      name: 'Generic Office Studio',   // no fleet keyword
    }
    const withFleet = scoreProspect(base, fleetCompany, { now: FIXED_NOW })
    const withoutFleet = scoreProspect(base, plainCompany, { now: FIXED_NOW })
    expect(withFleet.factors.fleet_signal_weight).toBe(FLEET_SIGNAL_WEIGHT_MATCH)
    expect(withoutFleet.factors.fleet_signal_weight).toBe(FLEET_SIGNAL_WEIGHT_NONE)
    // Fleet contributes 10 vs 3 → 7 point gap when only fleet differs.
    expect(withFleet.score - withoutFleet.score).toBeCloseTo(7, 1)
  })

  test('case 5 — sector match boosts vs. unknown sector', () => {
    const base = {
      crm_client_id: null,
      email_status: 'verified',
      email_confidence: 0.9,
      last_contacted: null,
      created_at: daysAgo(10),
    }
    const matched = {
      icp_tier: 'good',
      sector_primary: 'construction',
      category_path: null,
      name: 'Plain Office',  // no fleet keyword to isolate sector
    }
    const unknown = {
      icp_tier: 'good',
      sector_primary: 'something_random',
      category_path: null,
      name: 'Plain Office',
    }
    const a = scoreProspect(base, matched, { now: FIXED_NOW })
    const b = scoreProspect(base, unknown, { now: FIXED_NOW })
    expect(a.factors.sector_match_weight).toBe(SECTOR_MATCH_WEIGHT_FULL)
    expect(b.factors.sector_match_weight).toBe(SECTOR_MATCH_WEIGHT_NONE)
    expect(a.score - b.score).toBeCloseTo(10, 1)
  })

  test('case 6 — email_status="bounced" → score=0, factors.excluded=true', () => {
    const r = scoreProspect(
      {
        crm_client_id: null,
        email_status: 'bounced',
        email_confidence: 0.95,
        last_contacted: null,
        created_at: daysAgo(10),
      },
      { icp_tier: 'ideal', sector_primary: 'machinery', name: 'Top Co' },
      { now: FIXED_NOW },
    )
    expect(r.score).toBe(0)
    expect(r.factors.excluded).toBe(true)
    expect(r.factors.excluded_reason).toBe('email_status_bounced')
    // Even with maximal upstream signals, the exclusion gates first.
  })

  test('case 7 — missing company JOIN → fallback weights, score around 30-40', () => {
    const r = scoreProspect(
      {
        crm_client_id: null,
        email_status: 'valid',
        email_confidence: null,
        last_contacted: null,
        created_at: daysAgo(10),
      },
      null,
      { now: FIXED_NOW },
    )
    // ICP_UNKNOWN 50*0.2=10, email_verified 10, never_fresh 15, recency_very_recent 5,
    // sector none 0, fleet none 3 → 43
    expect(r.score).toBeGreaterThanOrEqual(30)
    expect(r.score).toBeLessThanOrEqual(45)
    expect(r.factors.icp_tier_weight).toBe(ICP_TIER_WEIGHT_UNKNOWN)
    expect(r.factors.sector_match_weight).toBe(SECTOR_MATCH_WEIGHT_NONE)
    expect(r.factors.fleet_signal_weight).toBe(FLEET_SIGNAL_WEIGHT_NONE)
  })

  test('case 8 — crm_client_id set → score=null + factors.excluded=true', () => {
    const r = scoreProspect(
      {
        crm_client_id: 999,
        email_status: 'verified',
        email_confidence: 0.95,
        last_contacted: null,
        created_at: daysAgo(10),
      },
      { icp_tier: 'ideal', sector_primary: 'machinery', name: 'Top Co' },
      { now: FIXED_NOW },
    )
    expect(r.score).toBeNull()
    expect(r.factors.excluded).toBe(true)
    expect(r.factors.excluded_reason).toBe('crm_client_id_set')
  })

  test('case 9 — email_confidence >= 0.7 without verified status → email_quality_weight = 0.7', () => {
    const r = scoreProspect(
      {
        crm_client_id: null,
        email_status: 'unknown',
        email_confidence: 0.8,
        last_contacted: null,
        created_at: daysAgo(10),
      },
      { icp_tier: 'good', sector_primary: 'machinery', name: 'Plain Office' },
      { now: FIXED_NOW },
    )
    expect(r.factors.email_quality_weight).toBe(EMAIL_QUALITY_WEIGHT_HIGH_CONFIDENCE)
  })

  test('case 10 — created_at > 180d AND last_contacted IS NULL → recency_weight = 0.2 + never_fresh', () => {
    const r = scoreProspect(
      {
        crm_client_id: null,
        email_status: 'valid',
        email_confidence: 0.9,
        last_contacted: null,
        created_at: daysAgo(400),
      },
      { icp_tier: 'good', sector_primary: 'machinery', name: 'Plain Office' },
      { now: FIXED_NOW },
    )
    expect(r.factors.recency_weight).toBe(RECENCY_WEIGHT_OLD)
    expect(r.factors.never_contacted_weight).toBe(NEVER_CONTACTED_WEIGHT_FRESH)
  })
})

describe('AV-F5-A prospectScorer — per-factor branch coverage', () => {
  test('icpTierWeight covers all branches incl. unknown', () => {
    expect(icpTierWeight('ideal')).toBe(1.0)
    expect(icpTierWeight('good')).toBe(0.7)
    expect(icpTierWeight('marginal')).toBe(0.3)
    expect(icpTierWeight('irrelevant')).toBe(0.05)
    expect(icpTierWeight(null)).toBe(0.2)
    expect(icpTierWeight('totally_unknown')).toBe(0.2)
  })

  test('emailQualityWeight: verified > confidence>=0.7 > unknown', () => {
    expect(emailQualityWeight({ email_status: 'verified' })).toBe(EMAIL_QUALITY_WEIGHT_VERIFIED)
    expect(emailQualityWeight({ email_status: 'valid' })).toBe(EMAIL_QUALITY_WEIGHT_VERIFIED)
    expect(emailQualityWeight({ email_confidence: 0.8 })).toBe(EMAIL_QUALITY_WEIGHT_HIGH_CONFIDENCE)
    expect(emailQualityWeight({ email_confidence: 0.5 })).toBe(EMAIL_QUALITY_WEIGHT_UNKNOWN)
    expect(emailQualityWeight({})).toBe(EMAIL_QUALITY_WEIGHT_UNKNOWN)
  })

  test('isExcludedEmailStatus covers all 3 excluded statuses', () => {
    for (const s of EXCLUDED_EMAIL_STATUSES) {
      expect(isExcludedEmailStatus(s)).toBe(true)
    }
    expect(isExcludedEmailStatus('valid')).toBe(false)
    expect(isExcludedEmailStatus(null)).toBe(false)
    expect(isExcludedEmailStatus(undefined)).toBe(false)
  })

  test('neverContactedWeight: NULL > 90d > <90d', () => {
    expect(neverContactedWeight(null, FIXED_NOW)).toBe(1.0)
    expect(neverContactedWeight(daysAgo(120), FIXED_NOW)).toBe(0.6)
    expect(neverContactedWeight(daysAgo(30), FIXED_NOW)).toBe(0.0)
    // Bogus value → fresh (defensive)
    expect(neverContactedWeight('not-a-date', FIXED_NOW)).toBe(1.0)
  })

  test('recencyWeight: <=30d > <=180d > older', () => {
    expect(recencyWeight(daysAgo(5), FIXED_NOW)).toBe(1.0)
    expect(recencyWeight(daysAgo(100), FIXED_NOW)).toBe(0.5)
    expect(recencyWeight(daysAgo(400), FIXED_NOW)).toBe(0.2)
    expect(recencyWeight(null, FIXED_NOW)).toBe(0.2)
  })

  test('sectorMatchWeight: primary > partial path > none', () => {
    expect(sectorMatchWeight({ sector_primary: 'machinery' })).toBe(1.0)
    expect(sectorMatchWeight({ sector_primary: 'other', category_path: 'B/construction/X' })).toBe(0.5)
    expect(sectorMatchWeight({ sector_primary: 'other', category_path: 'B/unknown/X' })).toBe(0.0)
    expect(sectorMatchWeight(null)).toBe(0.0)
  })

  test('fleetSignalWeight: keyword match in name OR path → 1.0 else 0.3', () => {
    expect(fleetSignalWeight({ name: 'Doprava XYZ' })).toBe(1.0)
    expect(fleetSignalWeight({ category_path: 'B/services/servis-aut' })).toBe(1.0)
    expect(fleetSignalWeight({ name: 'Office Studio' })).toBe(0.3)
    expect(fleetSignalWeight(null)).toBe(0.3)
  })

  test('score is clamped + rounded to 2 decimal places (NUMERIC(5,2))', () => {
    const r = scoreProspect(
      {
        crm_client_id: null,
        email_status: 'verified',
        email_confidence: 0.95,
        last_contacted: null,
        created_at: daysAgo(5),
      },
      { icp_tier: 'ideal', sector_primary: 'machinery', name: 'Bagry & Stroje' },
      { now: FIXED_NOW },
    )
    // No clamp needed (max possible = 100), but value must be in range.
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
    // Two-decimal rounding.
    const rounded = Math.round(r.score * 100) / 100
    expect(r.score).toBe(rounded)
  })

  test('raw_components reflect each factor times its base', () => {
    const r = scoreProspect(
      {
        crm_client_id: null,
        email_status: 'verified',
        email_confidence: 0.95,
        last_contacted: null,
        created_at: daysAgo(5),
      },
      { icp_tier: 'ideal', sector_primary: 'machinery', name: 'Plain Office' },
      { now: FIXED_NOW },
    )
    expect(r.factors.raw_components.icp).toBeCloseTo(50, 2)       // 50 * 1.0
    expect(r.factors.raw_components.email).toBeCloseTo(10, 2)     // 10 * 1.0
    expect(r.factors.raw_components.never).toBeCloseTo(15, 2)     // 15 * 1.0
    expect(r.factors.raw_components.recency).toBeCloseTo(5, 2)    //  5 * 1.0
    expect(r.factors.raw_components.sector).toBeCloseTo(10, 2)    // 10 * 1.0
    expect(r.factors.raw_components.fleet).toBeCloseTo(3, 2)      // 10 * 0.3 (no fleet kw)
    expect(r.score).toBeCloseTo(93, 2)
  })
})
