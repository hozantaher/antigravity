import { describe, it, expect } from 'vitest'
import type { Item } from '~/models'
import { itemNeedsEnrichment, pickSourceLocale } from '~/server/utils/enrich'

// itemNeedsEnrichment only reads vin / specs.manufacturer / description, so a partial cast is enough.
const asItem = (over: Partial<Item>): Item => over as Item

describe('itemNeedsEnrichment', () => {
  it('flags a VIN with empty specs (VIN decode pending)', () => {
    expect(itemNeedsEnrichment(asItem({ vin: 'WAUZZZ8K9BA123456', specs: {}, description: {} }))).toBe(true)
  })

  it('does not flag when specs are already populated', () => {
    expect(
      itemNeedsEnrichment(asItem({ vin: 'WAUZZZ8K9BA123456', specs: { manufacturer: 'Audi' }, description: {} })),
    ).toBe(false)
  })

  it('flags a description that has an empty enrichable locale (translation pending)', () => {
    expect(itemNeedsEnrichment(asItem({ description: { cz: 'Popis vozu' } }))).toBe(true)
  })

  it('does not flag when every enrichable locale is filled', () => {
    const full = Object.fromEntries(['cz', 'de', 'en', 'fr', 'nl', 'pl', 'ru', 'ua'].map(l => [l, 'text']))
    expect(itemNeedsEnrichment(asItem({ description: full }))).toBe(false)
  })

  it('does not flag an empty item with no VIN and no description', () => {
    expect(itemNeedsEnrichment(asItem({ description: {} }))).toBe(false)
  })

  it('flags highlights with empty enrichable locales (translation pending)', () => {
    expect(itemNeedsEnrichment(asItem({ highlights: { cz: [{ title: 'Stav', value: 'Nové' }] } }))).toBe(true)
  })

  it('does not flag when both description and highlights are complete in every enrichable locale', () => {
    const locales = ['cz', 'de', 'en', 'fr', 'nl', 'pl', 'ru', 'ua']
    const fullDesc = Object.fromEntries(locales.map(l => [l, 'text']))
    const fullHl = Object.fromEntries(locales.map(l => [l, [{ title: 't', value: 'v' }]]))
    expect(itemNeedsEnrichment(asItem({ description: fullDesc, highlights: fullHl }))).toBe(false)
  })
})

describe('pickSourceLocale', () => {
  it('prefers cz, then en, then any enrichable locale', () => {
    expect(pickSourceLocale({ cz: 'a', en: 'b' })).toBe('cz')
    expect(pickSourceLocale({ en: 'b', de: 'c' })).toBe('en')
    expect(pickSourceLocale({ de: 'c' })).toBe('de')
  })

  it('returns undefined for an empty/blank description', () => {
    expect(pickSourceLocale({})).toBeUndefined()
    expect(pickSourceLocale({ cz: '   ' })).toBeUndefined()
    expect(pickSourceLocale(null)).toBeUndefined()
  })

  it('works for array-valued maps (highlights): non-empty array is filled, empty is not', () => {
    expect(pickSourceLocale({ cz: [{ title: 't', value: 'v' }] })).toBe('cz')
    expect(pickSourceLocale({ cz: [] })).toBeUndefined()
  })
})
