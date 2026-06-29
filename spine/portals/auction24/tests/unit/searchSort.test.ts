import { describe, expect, it } from 'vitest'
import { DEFAULT_SEARCH_SORT, SEARCH_SORTS, isDefaultSearchSort, parseSearchSort } from '~/models'
import { searchOrderKey } from '~/server/utils/search'

describe('parseSearchSort', () => {
  it('passes every known sort through unchanged', () => {
    for (const s of SEARCH_SORTS) expect(parseSearchSort(s)).toBe(s)
  })

  it('defaults unknown / blank / null / undefined / non-string input to relevance', () => {
    expect(parseSearchSort('cheapest')).toBe('relevance')
    expect(parseSearchSort('')).toBe('relevance')
    expect(parseSearchSort('   ')).toBe('relevance')
    expect(parseSearchSort(null)).toBe('relevance')
    expect(parseSearchSort(undefined)).toBe('relevance')
    expect(parseSearchSort(123)).toBe('relevance')
  })

  it('trims and takes the first value of a repeated (array) param', () => {
    expect(parseSearchSort('  newest ')).toBe('newest')
    expect(parseSearchSort(['priceAsc', 'newest'])).toBe('priceAsc')
  })

  it('DEFAULT_SEARCH_SORT is relevance', () => {
    expect(DEFAULT_SEARCH_SORT).toBe('relevance')
  })
})

describe('isDefaultSearchSort', () => {
  it('is true only for the default order', () => {
    expect(isDefaultSearchSort('relevance')).toBe(true)
    expect(isDefaultSearchSort('newest')).toBe(false)
    expect(isDefaultSearchSort('priceAsc')).toBe(false)
    expect(isDefaultSearchSort('priceDesc')).toBe(false)
  })
})

describe('searchOrderKey', () => {
  it('maps the default order (relevance / undefined) to null — the shared listing order', () => {
    expect(searchOrderKey('relevance')).toBeNull()
    expect(searchOrderKey(undefined)).toBeNull()
  })

  it('maps each explicit sort to its dedicated order key', () => {
    expect(searchOrderKey('newest')).toBe('newest')
    expect(searchOrderKey('priceAsc')).toBe('priceAsc')
    expect(searchOrderKey('priceDesc')).toBe('priceDesc')
  })
})
