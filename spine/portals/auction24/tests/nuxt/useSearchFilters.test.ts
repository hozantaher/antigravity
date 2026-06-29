import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import type { SearchQuery, SearchSort } from '~/models'
import useSearchFilters from '~/features/demand/search/logic/useSearchFilters'

// useSearchFilters shares facet state via useState('search:facets') and mirrors it to the URL via
// router.replace. We mock useRoute/useRouter (harmless hooks for the Nuxt bootstrap) and capture
// replace() calls. The shared useState survives across tests in one Nuxt instance, so each test
// seeds it explicitly (simulating the URL-seeded state) via `seedFacets`.
const h0 = vi.hoisted(() => ({ replace: vi.fn() }))
mockNuxtImport('useRoute', () => () => ({ query: {} as Record<string, string> }))
mockNuxtImport('useRouter', () => () => ({
  replace: (arg: { query: Record<string, string> }) => h0.replace(arg),
  beforeResolve: () => () => {},
  beforeEach: () => () => {},
  afterEach: () => () => {},
  onError: () => () => {},
  push: () => Promise.resolve(),
  isReady: () => Promise.resolve(),
}))

const mountWith = async (setup: () => unknown) => {
  let captured: unknown
  await mountSuspended(
    defineComponent({
      setup() {
        captured = setup()
        return () => h('div')
      },
    }),
  )
  await flushPromises()
  return captured as ReturnType<typeof useSearchFilters>
}

// Seed the shared facet state (what the URL-seeded init would have produced).
const seedFacets = (facets: SearchQuery) => {
  useState<SearchQuery>('search:facets', () => ({})).value = { ...facets }
}

// Sort is shared via its own useState; reset it to the default between tests (it survives the
// shared Nuxt instance just like the facets).
const seedSort = (sort: SearchSort) => {
  useState<SearchSort>('search:sort', () => 'relevance').value = sort
}

beforeEach(() => {
  seedFacets({})
  seedSort('relevance')
  h0.replace.mockClear()
})

describe('useSearchFilters', () => {
  it('exposes the shared facet state', async () => {
    seedFacets({ fuelType: 'diesel', priceMin: 5000 })
    const sf = await mountWith(() => useSearchFilters())
    expect(sf.facets.value).toEqual({ fuelType: 'diesel', priceMin: 5000 })
  })

  it('folds the route term into the query() record fed to usePagedItems', async () => {
    seedFacets({ fuelType: 'diesel' })
    const sf = await mountWith(() => useSearchFilters({ q: () => 'octavia' }))
    expect(sf.query.value).toEqual({ q: 'octavia', fuelType: 'diesel' })
  })

  it('sets a facet immutably', async () => {
    const sf = await mountWith(() => useSearchFilters())
    const before = sf.facets.value
    sf.setFacet('fuelType', 'petrol')
    await nextTick()
    expect(sf.facets.value).not.toBe(before) // new object, not mutated in place
    expect(sf.facets.value).toEqual({ fuelType: 'petrol' })
  })

  it('clears a single facet, keeping the others', async () => {
    seedFacets({ fuelType: 'diesel', color: 'black' })
    const sf = await mountWith(() => useSearchFilters())
    sf.clearFacet('fuelType')
    await nextTick()
    expect(sf.facets.value).toEqual({ color: 'black' })
  })

  it('drops empty/undefined facet values instead of storing them', async () => {
    const sf = await mountWith(() => useSearchFilters())
    sf.setFacet('priceMin', undefined)
    sf.setFacet('categoryId', '')
    await nextTick()
    expect(sf.facets.value).toEqual({})
    expect(sf.query.value).toEqual({})
  })

  it('coerces a numeric facet via the model parse rules', async () => {
    const sf = await mountWith(() => useSearchFilters())
    sf.setFacet('priceMax', 20000)
    await nextTick()
    expect(sf.facets.value.priceMax).toBe(20000)
    expect(sf.query.value).toEqual({ priceMax: '20000' })
  })

  it('reset() clears every facet', async () => {
    seedFacets({ fuelType: 'diesel', color: 'black' })
    const sf = await mountWith(() => useSearchFilters())
    expect(Object.keys(sf.facets.value)).toHaveLength(2)
    sf.reset()
    await nextTick()
    expect(sf.facets.value).toEqual({})
  })

  it('mirrors a facet change into the URL query string (client)', async () => {
    const sf = await mountWith(() => useSearchFilters())
    sf.setFacet('fuelType', 'diesel')
    await nextTick()
    await flushPromises()
    expect(h0.replace).toHaveBeenCalledWith({ query: { fuelType: 'diesel' } })
  })

  it('reacts to a changing route term in query()', async () => {
    const term = ref('audi')
    const sf = await mountWith(() => useSearchFilters({ q: () => term.value }))
    expect(sf.query.value).toEqual({ q: 'audi' })
    term.value = 'bmw'
    await nextTick()
    expect(sf.query.value).toEqual({ q: 'bmw' })
  })

  it('combines the term and a set facet in query()', async () => {
    const sf = await mountWith(() => useSearchFilters({ q: () => 'audi' }))
    sf.setFacet('bodyType', 'suv')
    await nextTick()
    expect(sf.query.value).toEqual({ q: 'audi', bodyType: 'suv' })
  })
})

describe('useSearchFilters — sort', () => {
  it('seeds the default order (relevance) and elides it from query()', async () => {
    const sf = await mountWith(() => useSearchFilters({ q: () => 'audi' }))
    expect(sf.sort.value).toBe('relevance')
    expect(sf.query.value).toEqual({ q: 'audi' }) // no sort key while default → no ?sort sent
  })

  it('folds a non-default sort into the query() record fed to usePagedItems', async () => {
    const sf = await mountWith(() => useSearchFilters({ q: () => 'audi' }))
    sf.setSort('priceAsc')
    await nextTick()
    expect(sf.query.value).toEqual({ q: 'audi', sort: 'priceAsc' })
  })

  it('mirrors a non-default sort into the URL, then drops it again on return to default', async () => {
    const sf = await mountWith(() => useSearchFilters())
    sf.setSort('newest')
    await nextTick()
    await flushPromises()
    expect(h0.replace).toHaveBeenCalledWith({ query: { sort: 'newest' } })

    sf.setSort('relevance')
    await nextTick()
    await flushPromises()
    expect(h0.replace).toHaveBeenLastCalledWith({ query: {} })
  })

  it('keeps the chosen sort when a facet changes', async () => {
    const sf = await mountWith(() => useSearchFilters())
    sf.setSort('priceDesc')
    await nextTick()
    sf.setFacet('fuelType', 'diesel')
    await nextTick()
    expect(sf.query.value).toEqual({ fuelType: 'diesel', sort: 'priceDesc' })
  })

  it('coerces an unknown sort back to the default', async () => {
    const sf = await mountWith(() => useSearchFilters())
    sf.setSort('bogus' as SearchSort)
    await nextTick()
    expect(sf.sort.value).toBe('relevance')
  })
})
