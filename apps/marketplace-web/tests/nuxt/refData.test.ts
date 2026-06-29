import { describe, expect, it, vi } from 'vitest'
import useCategories from '~/features/platform/reference-data/logic/useCategories'
import useCountries from '~/features/platform/reference-data/logic/useCountries'
import useCurrencies from '~/features/platform/reference-data/logic/useCurrencies'
import useLanguages from '~/features/platform/reference-data/logic/useLanguages'

describe('reference-data composables', () => {
  it('useCategories caches, force-refetches, and finds', async () => {
    const f = vi.fn().mockResolvedValue([{ id: 'car' }])
    vi.stubGlobal('$fetch', f)
    const c = useCategories()
    await c.fetchCategories(true) // force from any prior state → fetch
    expect(f).toHaveBeenCalledTimes(1)
    await c.fetchCategories() // cached — no second call
    expect(f).toHaveBeenCalledTimes(1)
    await c.fetchCategories(true) // force
    expect(f).toHaveBeenCalledTimes(2)
    expect(c.findCategory('car')).toEqual({ id: 'car' })
    expect(c.findCategory('nope')).toBeUndefined()

    const fp = vi.fn().mockResolvedValue([{ id: 1 }])
    vi.stubGlobal('$fetch', fp)
    await c.fetchCategoryParams(true)
    expect(fp).toHaveBeenCalledTimes(1)
    await c.fetchCategoryParams() // cached
    expect(fp).toHaveBeenCalledTimes(1)
    expect(c.findCategoryParam(1)).toEqual({ id: 1 })
    expect(c.findCategoryParam(999)).toBeUndefined()
  })

  it('useCategories shares state across instances', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([{ id: 'bike' }]))
    const a = useCategories()
    await a.fetchCategories(true)
    const b = useCategories() // separate call, shared useState key
    expect(b.findCategory('bike')).toEqual({ id: 'bike' })
  })

  it('useCountries caches, force-refetches, and finds by alpha-2 / alpha-3', async () => {
    const f = vi.fn().mockResolvedValue([{ code2: 'cz', code3: 'cze' }])
    vi.stubGlobal('$fetch', f)
    const c = useCountries()
    await c.fetchCountries(true)
    expect(f).toHaveBeenCalledTimes(1)
    await c.fetchCountries() // cached
    expect(f).toHaveBeenCalledTimes(1)
    expect(c.findCountryByCode2('cz')).toMatchObject({ code3: 'cze' })
    expect(c.findCountryByCode3('cze')).toMatchObject({ code2: 'cz' })
    expect(c.findCountryByCode2('xx')).toBeUndefined()
    expect(c.findCountryByCode3('xxx')).toBeUndefined()
  })

  it('useCurrencies caches, force-refetches, and finds by code', async () => {
    const f = vi.fn().mockResolvedValue([{ code: 'CZK' }])
    vi.stubGlobal('$fetch', f)
    const c = useCurrencies()
    await c.fetchCurrencies(true)
    expect(f).toHaveBeenCalledTimes(1)
    await c.fetchCurrencies() // cached
    expect(f).toHaveBeenCalledTimes(1)
    expect(c.findCurrency('CZK')).toEqual({ code: 'CZK' })
    expect(c.findCurrency('USD')).toBeUndefined()
  })

  it('useLanguages caches, force-refetches, and finds by code', async () => {
    const f = vi.fn().mockResolvedValue([{ code: 'cz' }])
    vi.stubGlobal('$fetch', f)
    const l = useLanguages()
    await l.fetchLanguages(true)
    expect(f).toHaveBeenCalledTimes(1)
    await l.fetchLanguages() // cached
    expect(f).toHaveBeenCalledTimes(1)
    expect(l.findLanguage('cz')).toEqual({ code: 'cz' })
    expect(l.findLanguage('en')).toBeUndefined()
  })

  it('fetchers handle empty responses by leaving finders empty', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue([]))
    const cur = useCurrencies()
    await cur.fetchCurrencies(true) // force overwrites with empty array
    expect(cur.findCurrency('CZK')).toBeUndefined()

    const lang = useLanguages()
    await lang.fetchLanguages(true)
    expect(lang.findLanguage('cz')).toBeUndefined()
  })
})
