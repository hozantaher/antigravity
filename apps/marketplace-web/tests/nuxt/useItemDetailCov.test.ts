import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

import useItemDetail from '~/features/supply/auction-items/logic/useItemDetail'
import { ItemType, type Item } from '~/models'

// Route id is driven per test through a hoisted ref so the load path can fetch a real id, the
// falsy-id branch, and re-fetch on navigation.
const { routeId, user } = vi.hoisted(() => ({
  routeId: { value: 'i1' as string | undefined },
  user: { value: { id: 'u1' } as { id: string } | undefined },
}))
mockNuxtImport('useRoute', () => () => ({ params: { itemId: routeId.value } }))
mockNuxtImport('useUser', () => () => ({ user: ref(user.value) }))

const mkItem = (over: Partial<Item> = {}): Item =>
  ({
    id: 'i1',
    type: ItemType.auction,
    bids: [],
    sold: false,
    closed: false,
    endDate: 1_000,
    ...over,
  }) as Item

// `liveState` lets a test flip the slim /api/items/live payload so liveItemChanged fires.
const liveState = {
  value: [{ id: 'i1', bidCount: 0, endDate: 1_000, sold: false, closed: false }] as Record<string, unknown>[],
}
let itemFetchCount = 0
registerEndpoint('/api/items/live', () => liveState.value)
registerEndpoint('/api/item/i1', () => {
  itemFetchCount += 1
  // Second fetch (the live-triggered refresh) returns the moved item so the change is observable.
  return mkItem({ bidCount: itemFetchCount > 1 ? 5 : 0 })
})

// Stale mounts keep a live useAsyncData effect on the shared 'itemDetail:fetch' key; a later
// clearNuxtData would re-trigger them and clobber the shared item. Unmount each one after its test.
const mounted: { unmount: () => void }[] = []

const mountWith = async (setup: () => unknown) => {
  let captured: unknown
  const wrapper = await mountSuspended(
    defineComponent({
      setup() {
        captured = setup()
        return () => h('div')
      },
    }),
  )
  mounted.push(wrapper)
  await flushPromises()
  return { api: captured as ReturnType<typeof useItemDetail>, wrapper }
}

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})

beforeEach(() => {
  routeId.value = 'i1'
  user.value = { id: 'u1' }
  itemFetchCount = 0
  liveState.value = [{ id: 'i1', bidCount: 0, endDate: 1_000, sold: false, closed: false }]
  vi.clearAllMocks()
})

describe('useItemDetail (reader, load=false)', () => {
  it('returns the shared item, refresh, placeBid, and a falsy ready', async () => {
    vi.stubGlobal('$fetch', vi.fn())
    const { api } = await mountWith(() => useItemDetail())
    expect(api.item.value).toBeUndefined()
    expect(api.ready).toBeUndefined()
    expect(typeof api.refresh).toBe('function')
    expect(typeof api.placeBid).toBe('function')
  })

  it('refresh is a no-op when there is no loaded item', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('$fetch', fetchSpy)
    const { api } = await mountWith(() => useItemDetail())
    await api.refresh()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refresh re-pulls the full item when one is loaded', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mkItem({ id: 'seeded', bidCount: 9 }))
    vi.stubGlobal('$fetch', fetchSpy)
    const { api } = await mountWith(() => {
      const detail = useItemDetail()
      // Seed shared state via the same useState key.
      useState<Item | undefined>('itemDetail', () => undefined).value = mkItem({ id: 'seeded' })
      return detail
    })
    await api.refresh()
    expect(fetchSpy).toHaveBeenCalledWith('/api/item/seeded')
    expect(api.item.value?.bidCount).toBe(9)
  })

  it('placeBid posts the amount with the current user id', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(mkItem({ id: 'seeded', bidCount: 1 }))
    vi.stubGlobal('$fetch', fetchSpy)
    const { api } = await mountWith(() => {
      const detail = useItemDetail()
      useState<Item | undefined>('itemDetail', () => undefined).value = mkItem({ id: 'seeded' })
      return detail
    })
    await api.placeBid(123)
    expect(fetchSpy).toHaveBeenCalledWith('/api/item/seeded/bid', {
      method: 'POST',
      body: { amount: 123, userId: 'u1' },
    })
  })

  it('placeBid sends userId undefined when there is no signed-in user (?? branch)', async () => {
    user.value = undefined
    const fetchSpy = vi.fn().mockResolvedValue(mkItem({ id: 'seeded' }))
    vi.stubGlobal('$fetch', fetchSpy)
    const { api } = await mountWith(() => {
      const detail = useItemDetail()
      useState<Item | undefined>('itemDetail', () => undefined).value = mkItem({ id: 'seeded' })
      return detail
    })
    await api.placeBid(5)
    expect(fetchSpy.mock.calls[0]![1].body.userId).toBeUndefined()
  })
})

// Settle outstanding microtasks across several ticks so the useAsyncData fetch AND the live
// watcher's follow-up refresh both resolve.
const settle = async (times = 5) => {
  for (let i = 0; i < times; i += 1) await flushPromises()
}

describe('useItemDetail (driver, load=true)', () => {
  // The shared setup stubs $fetch to a bare vi.fn(); restore the real (registerEndpoint-patched)
  // $fetch so useAsyncData / useLiveItems hit the mocked endpoints. The asyncData key is shared
  // across mounts, so drop the cached payload (and the shared item state) before each mount.
  beforeEach(() => {
    vi.unstubAllGlobals()
    clearNuxtData('itemDetail:fetch')
    useState<Item | undefined>('itemDetail', () => undefined).value = undefined
  })

  it('fetches the item by route id and exposes a settled ready promise', async () => {
    const { api } = await mountWith(() => useItemDetail(true))
    await settle()
    await expect(api.ready).resolves.toBeUndefined()
    expect(api.item.value?.id).toBe('i1')
  })

  it('leaves the item undefined when the route has no itemId (falsy id branch)', async () => {
    routeId.value = undefined
    const { api } = await mountWith(() => useItemDetail(true))
    await settle()
    await api.ready
    expect(api.item.value).toBeUndefined()
  })

  it('overlays the live state in place on a real change (no full refetch)', async () => {
    // Live payload differs (bidCount 5 vs the loaded 0) so liveItemChanged -> applyLiveItem patches
    // the item in place; the heavy /api/item/:id refetch no longer fires on every live tick.
    liveState.value = [{ id: 'i1', bidCount: 5, endDate: 1_000, sold: false, closed: false }]
    const { api } = await mountWith(() => useItemDetail(true))
    await settle(8)
    expect(itemFetchCount).toBe(1) // only the initial load; the live change is applied without a refetch
    expect(api.item.value?.bidCount).toBe(5)
  })

  it('does not refetch when the live poll matches the loaded item (no-change branch)', async () => {
    liveState.value = [{ id: 'i1', bidCount: 0, endDate: 1_000, sold: false, closed: false }]
    await mountWith(() => useItemDetail(true))
    await settle()
    // Only the initial useAsyncData fetch ran; the live probe matched so no refresh.
    expect(itemFetchCount).toBe(1)
  })

  it('skips the live layer for a non-auction (ad) item', async () => {
    registerEndpoint('/api/item/ad1', () => mkItem({ id: 'ad1', type: ItemType.ad }))
    routeId.value = 'ad1'
    const { api } = await mountWith(() => useItemDetail(true))
    await settle()
    expect(api.item.value?.type).toBe(ItemType.ad)
  })
})
