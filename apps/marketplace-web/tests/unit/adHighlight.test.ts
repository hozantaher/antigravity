import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { isLegacyParamCode, resolveHighlightLabel, selectPublicHighlights } from '~/models'

describe('isLegacyParamCode', () => {
  it('matches legacy cp* param codes (trimmed)', () => {
    expect(isLegacyParamCode('cpBrand')).toBe(true)
    expect(isLegacyParamCode('cpVIN')).toBe(true)
    expect(isLegacyParamCode(' cpMileage ')).toBe(true)
  })

  it('rejects localized free-text and non-codes', () => {
    expect(isLegacyParamCode('Rok výroby')).toBe(false)
    expect(isLegacyParamCode('CPU')).toBe(false)
    expect(isLegacyParamCode('cpu')).toBe(false)
    expect(isLegacyParamCode('')).toBe(false)
  })
})

describe('selectPublicHighlights', () => {
  const cz = [{ title: 'cpBrand', value: 'Scania' }]
  const en = [{ title: 'cpBrand', value: 'Scania-EN' }]

  it('prefers the active locale, then falls back cz → en → first non-empty', () => {
    expect(selectPublicHighlights({ cz, en }, 'en')).toEqual(en)
    expect(selectPublicHighlights({ cz }, 'de')).toEqual(cz)
    expect(selectPublicHighlights({ en }, 'de')).toEqual(en)
    expect(selectPublicHighlights({ pl: [{ title: 'x', value: 'y' }] }, 'de')).toEqual([{ title: 'x', value: 'y' }])
  })

  it('drops blank-label rows (the empty highlight)', () => {
    const rows = [
      { title: '', value: '' },
      { title: 'cpBrand', value: 'Scania' },
    ]
    expect(selectPublicHighlights({ cz: rows }, 'cz')).toEqual([{ title: 'cpBrand', value: 'Scania' }])
  })

  it('returns [] for null / undefined / empty maps', () => {
    expect(selectPublicHighlights(null, 'cz')).toEqual([])
    expect(selectPublicHighlights(undefined, 'cz')).toEqual([])
    expect(selectPublicHighlights({}, 'cz')).toEqual([])
    expect(selectPublicHighlights({ cz: [] }, 'cz')).toEqual([])
  })

  it('honors the caller-resolved rs → srb locale key', () => {
    expect(selectPublicHighlights({ srb: cz }, 'srb')).toEqual(cz)
  })
})

describe('resolveHighlightLabel', () => {
  const i18n = {
    has: (k: string) => k === 'cpBrand' || k === 'cpMileage',
    translate: (k: string) => ({ cpBrand: 'Značka', cpMileage: 'Kilometry' })[k] ?? k,
  }

  it('translates legacy codes that have a translation', () => {
    expect(resolveHighlightLabel('cpBrand', i18n)).toBe('Značka')
    expect(resolveHighlightLabel('cpMileage', i18n)).toBe('Kilometry')
  })

  it('passes already-localized titles through untouched', () => {
    expect(resolveHighlightLabel('Rok výroby', i18n)).toBe('Rok výroby')
  })

  it('passes legacy-shaped codes with no translation through (no echo of a missing key)', () => {
    expect(resolveHighlightLabel('cpUnknownXyz', i18n)).toBe('cpUnknownXyz')
  })

  it('resolves real cz.yml param codes end-to-end', () => {
    const cz = parse(readFileSync(join(process.cwd(), 'features/platform/i18n/locales/cz.yml'), 'utf8')) as Record<
      string,
      unknown
    >
    const real = {
      has: (k: string) => typeof cz[k] === 'string',
      translate: (k: string) => String(cz[k]),
    }
    expect(resolveHighlightLabel('cpBrand', real)).toBe('Značka')
    expect(resolveHighlightLabel('cpMileage', real)).toBe('Kilometry')
    expect(resolveHighlightLabel('cpTransmission', real)).toBe('Převodovka')
    expect(resolveHighlightLabel('Scania', real)).toBe('Scania') // a value, not a key → unchanged
  })
})
