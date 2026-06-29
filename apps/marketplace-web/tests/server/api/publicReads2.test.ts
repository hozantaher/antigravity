import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from '../../setup/server'

import bidsHandler from '~/server/api/item/[id]/bids.get'
import soldHandler from '~/server/api/items/sold.get'
import searchHandler from '~/server/api/search.get'
import { listBidsPage, listSoldPage, searchPage } from '~/server/repos/itemRepo'

vi.mock('~/server/repos/itemRepo', () => ({ listBidsPage: vi.fn(), listSoldPage: vi.fn(), searchPage: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('public paginated reads', () => {
  it('GET /api/item/[id]/bids — newest first, pageSize 20', async () => {
    vi.mocked(listBidsPage).mockResolvedValue({ items: [] } as never)
    await bidsHandler(makeEvent({ params: { id: 'i1' } }) as never)
    expect(listBidsPage).toHaveBeenCalledWith('i1', expect.objectContaining({ pageSize: 20 }))
  })

  it('GET /api/items/sold', async () => {
    vi.mocked(listSoldPage).mockResolvedValue({ items: [] } as never)
    await soldHandler(makeEvent({ query: { page: '2' } }) as never)
    expect(listSoldPage).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }))
  })

  it('GET /api/search — parses q into a SearchQuery, omits an empty term', async () => {
    vi.mocked(searchPage).mockResolvedValue({ items: [] } as never)
    await searchHandler(makeEvent({ query: { q: 'audi' } }) as never)
    // 3rd arg is the parsed sort — defaults to 'relevance' (the shared listing order) when absent.
    expect(searchPage).toHaveBeenCalledWith({ q: 'audi' }, expect.anything(), 'relevance')
    await searchHandler(makeEvent() as never)
    expect(searchPage).toHaveBeenLastCalledWith({}, expect.anything(), 'relevance')
  })

  it('GET /api/search — forwards a valid sort and falls back to relevance for junk', async () => {
    vi.mocked(searchPage).mockResolvedValue({ items: [] } as never)
    await searchHandler(makeEvent({ query: { q: 'audi', sort: 'priceAsc' } }) as never)
    expect(searchPage).toHaveBeenLastCalledWith({ q: 'audi' }, expect.anything(), 'priceAsc')
    await searchHandler(makeEvent({ query: { q: 'audi', sort: 'cheapest' } }) as never)
    expect(searchPage).toHaveBeenLastCalledWith({ q: 'audi' }, expect.anything(), 'relevance')
  })

  it('GET /api/search — forwards structured facet params + paging to searchPage', async () => {
    vi.mocked(searchPage).mockResolvedValue({ items: [] } as never)
    await searchHandler(
      makeEvent({
        query: {
          q: 'octavia',
          type: 'auction',
          fuelType: 'diesel',
          priceMin: '5000',
          priceMax: '20000',
          yearFrom: '2015',
          page: '2',
          pageSize: '12',
          // unknown enum value is dropped, never forwarded
          bodyType: 'spaceship',
        },
      }) as never,
    )
    expect(searchPage).toHaveBeenCalledWith(
      { q: 'octavia', type: 'auction', fuelType: 'diesel', priceMin: 5000, priceMax: 20000, yearFrom: 2015 },
      expect.objectContaining({ page: 2, pageSize: 12 }),
      'relevance',
    )
  })
})
