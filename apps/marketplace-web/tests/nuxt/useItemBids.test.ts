import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { ref, type Ref } from 'vue'

import useItemBids from '~/features/supply/bidding/logic/useItemBids'
import type { Bid, Paginated } from '~/models'

// The composable owns a lazy client-only useAsyncData fetch (mirrors useItemQuestions). Stub
// useAsyncData to (1) capture the key/fetcher/options so we can assert the real request shape and
// the lazy/no-SSR posture, and (2) hand back a controllable `data` ref so the bids/total
// derivation is deterministically testable (the real lazy+server:false fetch doesn't settle here).
interface Captured {
  key: unknown
  handler?: () => Promise<unknown>
  options?: Record<string, unknown>
  data: Ref<Paginated<Bid> | undefined>
  refresh: ReturnType<typeof vi.fn>
}

let captured: Captured

mockNuxtImport('useAsyncData', () => {
  return (key: unknown, handler: () => Promise<unknown>, options: Record<string, unknown>) => {
    captured.key = typeof key === 'function' ? (key as () => unknown)() : key
    captured.handler = handler
    captured.options = options
    const def = options?.default as undefined | (() => Paginated<Bid>)
    if (def && captured.data.value === undefined) captured.data.value = def()
    return { data: captured.data, refresh: captured.refresh }
  }
})

const mkBid = (amount: number): Bid => ({ amount }) as Bid
const page = (items: Bid[], total = items.length): Paginated<Bid> => ({ items, total, page: 1, pageSize: 20 })

beforeEach(() => {
  vi.clearAllMocks()
  captured = { key: undefined, handler: undefined, options: undefined, data: ref(undefined), refresh: vi.fn() }
})

describe('useItemBids', () => {
  it('fetches /api/item/:id/bids with the current page + pageSize', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('$fetch', fetchSpy)

    useItemBids('itm1')
    await captured.handler!()

    expect(fetchSpy).toHaveBeenCalledWith('/api/item/itm1/bids', { query: { page: 1, pageSize: 20 } })
  })

  it('is lazy + client-only and re-fetches on page change (real server-side pagination)', () => {
    const { page: pageRef } = useItemBids('itm1')
    expect(captured.options).toMatchObject({ server: false, lazy: true })
    // The page ref is in the watch list, so changing it triggers useAsyncData's re-run.
    const watched = captured.options!.watch as unknown[]
    expect(watched).toContain(pageRef)
  })

  it('derives bids + total from the fetched page (newest-first comes from the endpoint)', () => {
    const { bids, total } = useItemBids('itm1')
    captured.data.value = page([mkBid(1200), mkBid(1100)], 15)
    expect(bids.value.map(b => b.amount)).toEqual([1200, 1100])
    expect(total.value).toBe(15)
  })

  it('defaults to an empty page and exposes refresh', () => {
    const { bids, total, refresh, pageSize } = useItemBids('itm1')
    expect(bids.value).toEqual([])
    expect(total.value).toBe(0)
    expect(pageSize).toBe(20)
    refresh()
    expect(captured.refresh).toHaveBeenCalled()
  })

  it('tracks a reactive item id in the fetch key + url', async () => {
    const id = ref<string | undefined>(undefined)
    useItemBids(() => id.value)
    // Key reflects the (currently empty) id.
    expect(captured.key).toBe('bids:item:')

    id.value = 'itm9'
    const fetchSpy = vi.fn().mockResolvedValue(page([]))
    vi.stubGlobal('$fetch', fetchSpy)
    await captured.handler!()
    expect(fetchSpy).toHaveBeenCalledWith('/api/item/itm9/bids', { query: { page: 1, pageSize: 20 } })
  })
})
