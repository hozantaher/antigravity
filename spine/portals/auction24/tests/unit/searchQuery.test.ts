import { describe, expect, it } from 'vitest'
import { parseSearchQuery, searchQueryToRecord, isEmptySearch, normalizeYearRange, type SearchQuery } from '~/models'

describe('parseSearchQuery', () => {
  it('coerces price/year strings to numbers and passes enums through', () => {
    const q = parseSearchQuery({
      q: 'octavia',
      type: 'auction',
      categoryId: 'cars',
      priceMin: '5000',
      priceMax: '20000',
      fuelType: 'diesel',
      bodyType: 'wagon',
      transmission: 'automatic',
      driveType: 'awd',
      color: 'black',
      yearFrom: '2015',
      yearTo: '2022',
    })
    expect(q).toEqual({
      q: 'octavia',
      type: 'auction',
      categoryId: 'cars',
      priceMin: 5000,
      priceMax: 20000,
      fuelType: 'diesel',
      bodyType: 'wagon',
      transmission: 'automatic',
      driveType: 'awd',
      color: 'black',
      yearFrom: 2015,
      yearTo: 2022,
    })
  })

  it('drops unknown enum values', () => {
    expect(parseSearchQuery({ fuelType: 'plasma', bodyType: 'spaceship', type: 'lease' })).toEqual({})
  })

  it('drops blank, junk, and negative numeric facets', () => {
    expect(parseSearchQuery({ priceMin: '', priceMax: 'abc', yearFrom: '-5' })).toEqual({})
  })

  it('trims the free-text term and elides an empty one', () => {
    expect(parseSearchQuery({ q: '  audi  ' })).toEqual({ q: 'audi' })
    expect(parseSearchQuery({ q: '   ' })).toEqual({})
  })

  it('takes the first value of a repeated (array) param', () => {
    expect(parseSearchQuery({ fuelType: ['diesel', 'petrol'] })).toEqual({ fuelType: 'diesel' })
  })

  it('returns an empty query for null/undefined input', () => {
    expect(parseSearchQuery(null)).toEqual({})
    expect(parseSearchQuery(undefined)).toEqual({})
  })

  it('leaves an injection-y term untouched (escaping is the repo job)', () => {
    expect(parseSearchQuery({ q: "100% OFF';--" })).toEqual({ q: "100% OFF';--" })
  })

  it('normalizes inverted year bounds during parse', () => {
    expect(parseSearchQuery({ yearFrom: '2022', yearTo: '2015' })).toEqual({ yearFrom: 2015, yearTo: 2022 })
  })
})

describe('searchQueryToRecord', () => {
  it('serializes set facets to strings and omits empty ones', () => {
    const record = searchQueryToRecord({ q: 'audi', priceMin: 5000, fuelType: 'diesel' })
    expect(record).toEqual({ q: 'audi', priceMin: '5000', fuelType: 'diesel' })
  })

  it('omits undefined facets entirely', () => {
    expect(searchQueryToRecord({ q: 'audi', priceMin: undefined })).toEqual({ q: 'audi' })
  })

  it('round-trips: parse∘serialize is the identity for a valid query', () => {
    const original: SearchQuery = {
      q: 'octavia',
      type: 'auction',
      categoryId: 'cars',
      priceMin: 5000,
      priceMax: 20000,
      fuelType: 'diesel',
      yearFrom: 2015,
      yearTo: 2022,
    }
    expect(parseSearchQuery(searchQueryToRecord(original))).toEqual(original)
  })
})

describe('isEmptySearch', () => {
  it('is true for an empty query and an all-undefined query', () => {
    expect(isEmptySearch({})).toBe(true)
    expect(isEmptySearch({ priceMin: undefined, q: undefined })).toBe(true)
  })

  it('is false when any term or facet is set', () => {
    expect(isEmptySearch({ q: 'audi' })).toBe(false)
    expect(isEmptySearch({ fuelType: 'diesel' })).toBe(false)
    expect(isEmptySearch({ priceMin: 0 })).toBe(false)
  })
})

describe('normalizeYearRange', () => {
  it('swaps inverted bounds', () => {
    expect(normalizeYearRange({ yearFrom: 2022, yearTo: 2015 })).toEqual({ yearFrom: 2015, yearTo: 2022 })
  })

  it('leaves a well-formed or partial range untouched', () => {
    expect(normalizeYearRange({ yearFrom: 2015, yearTo: 2022 })).toEqual({ yearFrom: 2015, yearTo: 2022 })
    expect(normalizeYearRange({ yearFrom: 2015 })).toEqual({ yearFrom: 2015 })
    expect(normalizeYearRange({ yearTo: 2022 })).toEqual({ yearTo: 2022 })
  })
})
