/**
 * Unit tests for the Vozidla pipeline helpers.
 * Spustit: cd features/platform/outreach-dashboard && pnpm test tests/unit/vehicleMeta
 */
import { describe, it, expect } from 'vitest'
import { STAGES, stageMeta, bestPrice, formatEur, vehicleTitle, vehicleSpecs } from '../../../src/app/lib/vehicleMeta'

describe('STAGES + stageMeta', () => {
  it('exposes the five funnel stages in order', () => {
    expect(STAGES.map((s) => s.key)).toEqual(['offered', 'negotiating', 'agreed', 'paid', 'picked_up'])
  })
  it('maps statuses to labels, cancelled included, unknown falls back', () => {
    expect(stageMeta('offered').label).toBe('Nabídnuto')
    expect(stageMeta('picked_up').label).toBe('Vyzvednuto')
    expect(stageMeta('cancelled').label).toBe('Zrušeno')
    expect(stageMeta('garbage').label).toBe('garbage')
    expect(stageMeta(null).label).toBe('Neznámý')
  })
})

describe('bestPrice', () => {
  it('prefers agreed > offered > asking', () => {
    expect(bestPrice({ price_asking_eur: 100, price_offered_eur: 90, price_agreed_eur: 80 })).toEqual({ amount: 80, kind: 'Dohodnutá' })
    expect(bestPrice({ price_asking_eur: 100, price_offered_eur: 90 })).toEqual({ amount: 90, kind: 'Nabídnutá' })
    expect(bestPrice({ price_asking_eur: 100 })).toEqual({ amount: 100, kind: 'Požadovaná' })
  })
  it('returns null when no price set (production reality: all 14 priceless)', () => {
    expect(bestPrice({})).toBeNull()
  })
  it('treats 0 as a real price (not falsy-skipped)', () => {
    expect(bestPrice({ price_agreed_eur: 0 })).toEqual({ amount: 0, kind: 'Dohodnutá' })
  })
})

describe('formatEur', () => {
  it('formats EUR with no decimals and em-dash for null', () => {
    expect(formatEur(null)).toBe('—')
    expect(formatEur(12500)).toMatch(/12\s?500/)
  })
})

describe('vehicleTitle + vehicleSpecs', () => {
  it('builds a title from make/model/year defensively', () => {
    expect(vehicleTitle({ make: 'Caterpillar', model: '320', year: 2018 })).toBe('Caterpillar 320 · 2018')
    expect(vehicleTitle({ make: 'Liebherr' })).toBe('Liebherr')
    expect(vehicleTitle({})).toBe('Bez označení')
  })
  it('joins present specs, omits blanks', () => {
    expect(vehicleSpecs({ mileage_km: 12000, fuel: 'diesel' })).toMatch(/12\s?000 km · diesel/)
    expect(vehicleSpecs({})).toBe('')
  })
})

import { statusPatch, stageIndex } from '../../../src/app/lib/vehicleMeta'

describe('status stepper helpers', () => {
  it('statusPatch builds a minimal status-only PATCH body', () => {
    expect(statusPatch('negotiating')).toEqual({ status: 'negotiating' })
  })
  it('stageIndex orders the funnel and returns -1 off-funnel', () => {
    expect(stageIndex('offered')).toBe(0)
    expect(stageIndex('picked_up')).toBe(4)
    expect(stageIndex('cancelled')).toBe(-1)
    expect(stageIndex('garbage')).toBe(-1)
    expect(stageIndex('agreed')).toBeGreaterThan(stageIndex('negotiating'))
  })
})
