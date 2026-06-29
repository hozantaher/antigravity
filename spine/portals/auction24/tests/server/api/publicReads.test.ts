import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, setSessionUser } from '../../setup/server'

import itemsHandler from '~/server/api/items.get'
import liveHandler from '~/server/api/items/live.get'
import favoritesHandler from '~/server/api/favorites.get'
import invoicesHandler from '~/server/api/invoices.get'
import itemDetailHandler from '~/server/api/item/[id].get'
import { getPublicDetail, listFavoritesPage, listItemsPage, loadLiveItems } from '~/server/repos/itemRepo'
import { listForUserPage } from '~/server/repos/invoiceRepo'

vi.mock('~/server/repos/itemRepo', () => ({
  listItemsPage: vi.fn(),
  loadLiveItems: vi.fn(),
  listFavoritesPage: vi.fn(),
  getPublicDetail: vi.fn(),
}))
vi.mock('~/server/repos/invoiceRepo', () => ({ listForUserPage: vi.fn() }))

const live = liveHandler as (e: unknown) => Promise<unknown[]>

beforeEach(() => vi.clearAllMocks())

describe('GET /api/items', () => {
  it('parses filters and pagination', async () => {
    vi.mocked(listItemsPage).mockResolvedValue({ items: [], total: 0 } as never)
    await itemsHandler(makeEvent({ query: { type: 'auction', live: '1', categoryId: 'car' } }) as never)
    expect(listItemsPage).toHaveBeenCalledWith(
      { type: 'auction', live: true, categoryId: 'car' },
      expect.objectContaining({ page: 1, pageSize: 24 }),
    )
  })

  it('clamps an unknown type and falsy live/categoryId', async () => {
    vi.mocked(listItemsPage).mockResolvedValue({ items: [] } as never)
    await itemsHandler(makeEvent({ query: { type: 'spaceship', live: 'no' } }) as never)
    expect(listItemsPage).toHaveBeenCalledWith(
      { type: undefined, live: false, categoryId: undefined },
      expect.anything(),
    )
  })
})

describe('GET /api/items/live', () => {
  it('parses, trims and dedupes empty comma-separated ids', async () => {
    vi.mocked(loadLiveItems).mockResolvedValue([] as never)
    await live(makeEvent({ query: { ids: ' a , b ,, c ' } }))
    expect(loadLiveItems).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  it('caps at 50 ids and handles no ids', async () => {
    vi.mocked(loadLiveItems).mockResolvedValue([] as never)
    await live(makeEvent({ query: { ids: Array.from({ length: 60 }, (_, i) => `i${i}`).join(',') } }))
    expect(vi.mocked(loadLiveItems).mock.calls[0]![0]).toHaveLength(50)
    await live(makeEvent({ query: {} }))
    expect(loadLiveItems).toHaveBeenLastCalledWith([])
  })

  it('treats a non-string ids query as no ids', async () => {
    vi.mocked(loadLiveItems).mockResolvedValue([] as never)
    await live(makeEvent({ query: { ids: ['a', 'b'] as unknown as string } }))
    expect(loadLiveItems).toHaveBeenLastCalledWith([])
  })

  it('builds a normalized shared cache key (getKey) matching the handler', async () => {
    // The test harness unwraps defineCachedEventHandler to the bare handler, dropping the options
    // object — so getKey is never reached via the exported handler. Re-import the module with a
    // capturing stub to exercise it and the maxAge/swr options.
    const g = globalThis as Record<string, unknown>
    const original = g.defineCachedEventHandler
    let captured: { getKey: (e: unknown) => string; maxAge: number; swr: boolean } | undefined
    g.defineCachedEventHandler = (_fn: unknown, opts: typeof captured) => {
      captured = opts
      return _fn
    }
    try {
      vi.resetModules()
      await import('~/server/api/items/live.get')
    } finally {
      g.defineCachedEventHandler = original
    }
    expect(captured?.maxAge).toBe(2)
    expect(captured?.swr).toBe(true)
    expect(captured?.getKey(makeEvent({ query: { ids: ' b , a ,, b ' } }))).toBe('b,a,b')
    expect(captured?.getKey(makeEvent({ query: {} }))).toBe('')
  })
})

describe('GET /api/favorites', () => {
  it('returns an empty page for anonymous users', async () => {
    setSessionUser(null)
    const res = await favoritesHandler(makeEvent({ query: { page: '2' } }) as never)
    expect(res).toEqual({ items: [], total: 0, page: 2, pageSize: 24 })
    expect(listFavoritesPage).not.toHaveBeenCalled()
  })

  it('lists the favorites of a logged-in user', async () => {
    setSessionUser({ id: 'u1', favoriteIds: ['a', 'b'] })
    vi.mocked(listFavoritesPage).mockResolvedValue({ items: [], total: 0 } as never)
    await favoritesHandler(makeEvent() as never)
    expect(listFavoritesPage).toHaveBeenCalledWith(['a', 'b'], expect.anything())
  })
})

describe('GET /api/invoices', () => {
  it('returns an empty page (pageSize 10) for anonymous users', async () => {
    setSessionUser(null)
    expect(await invoicesHandler(makeEvent() as never)).toEqual({ items: [], total: 0, page: 1, pageSize: 10 })
  })

  it('lists invoices for the user', async () => {
    setSessionUser({ id: 'u1' })
    vi.mocked(listForUserPage).mockResolvedValue({ items: [] } as never)
    await invoicesHandler(makeEvent() as never)
    expect(listForUserPage).toHaveBeenCalledWith('u1', expect.objectContaining({ pageSize: 10 }))
  })
})

describe('GET /api/item/[id]', () => {
  it('returns the item', async () => {
    vi.mocked(getPublicDetail).mockResolvedValue({ id: 'x' } as never)
    await expect(itemDetailHandler(makeEvent({ params: { id: 'x' } }) as never)).resolves.toEqual({ id: 'x' })
  })

  it('404s when the item is missing', async () => {
    vi.mocked(getPublicDetail).mockResolvedValue(undefined as never)
    await expect(itemDetailHandler(makeEvent({ params: { id: 'x' } }) as never)).rejects.toMatchObject({
      statusCode: 404,
    })
  })
})
