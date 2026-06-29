import { describe, expect, it } from 'vitest'
import {
  ALERT_DUE_DAYS,
  ALERT_ITEM_CAP,
  SAVED_SEARCH_MAX_PER_USER,
  alertDueCutoffMs,
  isValidSavedSearchName,
  normalizeSavedSearchQuery,
  savedSearchFilterCount,
  savedSearchQueryToItemFilter,
} from '~/models'
import { savedSearchPatchToUpdate } from '~/server/repos/mappers'

describe('normalizeSavedSearchQuery', () => {
  it('keeps valid facets + term and round-trips through the record form', () => {
    const out = normalizeSavedSearchQuery({ q: 'octavia', type: 'auction', categoryId: 'cars', priceMax: 300000 })
    expect(out).toEqual({ q: 'octavia', type: 'auction', categoryId: 'cars', priceMax: 300000 })
  })

  it('drops empty/blank/unknown facets and junk numbers', () => {
    const out = normalizeSavedSearchQuery({
      q: '   ',
      type: 'bogus' as never,
      fuelType: 'unobtanium' as never,
      priceMin: -5 as never,
      categoryId: '',
    })
    expect(out).toEqual({})
  })

  it('treats null/undefined as an empty query', () => {
    expect(normalizeSavedSearchQuery(null)).toEqual({})
    expect(normalizeSavedSearchQuery(undefined)).toEqual({})
  })
})

describe('savedSearchQueryToItemFilter', () => {
  it('forces sold:false and hidden:false regardless of the stored query', () => {
    const f = savedSearchQueryToItemFilter({ q: 'bmw', type: 'auction' })
    expect(f.sold).toBe(false)
    expect(f.hidden).toBe(false)
    expect(f.q).toBe('bmw')
    expect(f.type).toBe('auction')
  })

  it('passes structured facets through and elides absent ones', () => {
    const f = savedSearchQueryToItemFilter({ categoryId: 'cars', priceMin: 1000, yearFrom: 2018 })
    expect(f).toMatchObject({ sold: false, hidden: false, categoryId: 'cars', priceMin: 1000, yearFrom: 2018 })
    expect('q' in f).toBe(false)
    expect('color' in f).toBe(false)
  })

  it('sanitizes a dirty stored query before mapping', () => {
    const f = savedSearchQueryToItemFilter({ type: 'junk' as never, color: 'nope' as never, q: 'audi' })
    expect(f).toEqual({ sold: false, hidden: false, q: 'audi' })
  })
})

describe('savedSearchFilterCount', () => {
  it('counts active facets/term', () => {
    expect(savedSearchFilterCount({})).toBe(0)
    expect(savedSearchFilterCount({ q: 'a' })).toBe(1)
    expect(savedSearchFilterCount({ q: 'a', type: 'auction', categoryId: 'cars' })).toBe(3)
  })
})

describe('isValidSavedSearchName', () => {
  it('accepts a non-blank, in-bound name', () => {
    expect(isValidSavedSearchName('My search')).toBe(true)
  })

  it('rejects blank, non-string, and over-length names', () => {
    expect(isValidSavedSearchName('   ')).toBe(false)
    expect(isValidSavedSearchName('')).toBe(false)
    expect(isValidSavedSearchName(123)).toBe(false)
    expect(isValidSavedSearchName(undefined)).toBe(false)
    expect(isValidSavedSearchName('x'.repeat(121))).toBe(false)
  })
})

describe('alertDueCutoffMs + constants', () => {
  it('computes the cutoff as now minus the weekly window', () => {
    const now = 1_000_000_000_000
    expect(alertDueCutoffMs(now)).toBe(now - ALERT_DUE_DAYS * 86_400_000)
  })

  it('exposes sane caps', () => {
    expect(ALERT_DUE_DAYS).toBe(7)
    expect(ALERT_ITEM_CAP).toBeGreaterThan(0)
    expect(SAVED_SEARCH_MAX_PER_USER).toBeGreaterThan(0)
  })
})

describe('savedSearchPatchToUpdate (self-edit whitelist)', () => {
  it('maps only name + alertEnabled', () => {
    expect(savedSearchPatchToUpdate({ name: '  New  ', alertEnabled: false })).toEqual({
      name: 'New',
      alertEnabled: false,
    })
  })

  it('ignores non-whitelisted keys (userId/id/query/lastAlertedAt)', () => {
    const u = savedSearchPatchToUpdate({
      name: 'Keep',
      userId: 'attacker',
      id: 'other',
      query: { q: 'x' },
      lastAlertedAt: new Date(),
    } as never)
    expect(u).toEqual({ name: 'Keep' })
    expect('userId' in u).toBe(false)
    expect('query' in u).toBe(false)
    expect('lastAlertedAt' in u).toBe(false)
  })

  it('drops an invalid name and a non-boolean alertEnabled', () => {
    expect(savedSearchPatchToUpdate({ name: '   ', alertEnabled: 'yes' as never })).toEqual({})
  })

  it('returns an empty update for an empty patch', () => {
    expect(savedSearchPatchToUpdate({})).toEqual({})
  })
})
