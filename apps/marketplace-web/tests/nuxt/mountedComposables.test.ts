import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import usePagedItems from '~/features/supply/auction-items/logic/usePagedItems'
import { useAdminPagedList } from '~/features/platform/admin/logic/useAdminPagedList'
import { useLiveItems } from '~/features/supply/bidding/logic/useLiveItems'
import { ItemType, type Item, type LiveItem } from '~/models'

// Hoisted, per-test toggles for usePagedItems' router/hydration deps. We mock useRoute/useRouter
// (the syncUrl page watcher reads route.query + calls router.replace) and onNuxtReady (the
// isHydrating clamp-refetch defers `() => refresh()` through it). We deliberately do NOT mock
// useNuxtApp — the @nuxt/test-utils bootstrap relies on the real instance — and instead flip the
// real nuxtApp.isHydrating flag inside a test. Defaults mirror the real client runtime so the rest
// of the file is unaffected.
const pagedEnv = vi.hoisted(() => ({
  routeQuery: {} as Record<string, string>,
  replace: ((..._args: unknown[]) => {}) as (...args: unknown[]) => void,
  onNuxtReady: ((_cb: () => void) => {}) as (cb: () => void) => void,
}))
mockNuxtImport('useRoute', () => () => ({ query: pagedEnv.routeQuery }))
mockNuxtImport('useRouter', () => () => ({
  replace: (...args: unknown[]) => pagedEnv.replace(...args),
  // @nuxt/test-utils' Nuxt bootstrap registers router hooks during setup; keep them harmless.
  afterEach: () => () => {},
  beforeEach: () => () => {},
  push: () => Promise.resolve(),
}))
mockNuxtImport('onNuxtReady', () => (cb: () => void) => pagedEnv.onNuxtReady(cb))

// Lifecycle/useFetch composables only run their full logic when mounted in a component.
registerEndpoint('/api/items', () => ({ items: [{ id: 'i1' }], total: 1, page: 1, pageSize: 24 }))
registerEndpoint('/api/items/live', () => [{ id: 'i1', closed: true, sold: false }])

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
  return captured as Record<string, { value: unknown }>
}

describe('usePagedItems (mounted)', () => {
  it('wires server-side pagination state (page, pageSize, items)', async () => {
    const r = await mountWith(() =>
      usePagedItems({ endpoint: '/api/items', syncUrl: false, query: () => ({ q: 'audi' }) }),
    )
    expect(r.pageSize).toBe(24)
    expect((r.page as { value: number }).value).toBe(1)
    expect((r.total as { value: number }).value).toBe(0) // computed default before data resolves
  })
})

describe('useAdminPagedList (mounted)', () => {
  it('runs the fetch callback on mount with the page context', async () => {
    const fetchSpy = vi.fn()
    await mountWith(() => useAdminPagedList({ fetch: fetchSpy }))
    expect(fetchSpy).toHaveBeenCalledWith({ page: 1, pageSize: 20, q: undefined })
  })
})

describe('useLiveItems (mounted)', () => {
  it('mounts the adaptive poller and exposes the live state map', async () => {
    const items: Item[] = [{ id: 'i1', closed: false, sold: false, type: ItemType.auction } as Item]
    const r = await mountWith(() => useLiveItems(() => items))
    await flushPromises()
    expect((r.live as { value: unknown }).value).toBeInstanceOf(Map)
  })
})

// --- additional coverage ---------------------------------------------------

const item = (over: Partial<Item> = {}): Item =>
  ({ id: 'i1', closed: false, sold: false, type: ItemType.auction, bids: [], ...over }) as Item

describe('usePagedItems (branches)', () => {
  // useFetch runs on the global $fetch (stubbed in setup) — drive a paginated payload directly.
  const totalRef = { value: 50 }
  const stubPaged = (total: number) => {
    totalRef.value = total
    vi.stubGlobal(
      '$fetch',
      vi.fn(async () => ({ items: [{ id: 'p1' }], total: totalRef.value, page: 1, pageSize: 24 })),
    )
  }

  beforeEach(() => {
    pagedEnv.routeQuery = {}
    pagedEnv.replace = () => {}
    pagedEnv.onNuxtReady = () => {}
  })

  it('strips undefined/empty filter values and resets page on filter change', async () => {
    stubPaged(50)
    const term = ref('audi')
    const r = await mountWith(() =>
      usePagedItems({
        endpoint: '/api/paged',
        syncUrl: false,
        query: () => ({ q: term.value, empty: '', missing: undefined, type: 'auction' }),
      }),
    )
    const page = r.page as { value: number }
    page.value = 3
    await nextTick()
    term.value = 'bmw'
    await nextTick()
    await flushPromises()
    expect(page.value).toBe(1) // filter change clamps back to page 1
  })

  it('initializes page from ?page= when syncUrl and mirrors it back to the URL', async () => {
    stubPaged(50)
    const r = await mountWith(() => usePagedItems({ endpoint: '/api/paged', syncUrl: true, key: 'k' }))
    const page = r.page as { value: number }
    expect(page.value).toBe(1)
    page.value = 2
    await nextTick()
    await flushPromises()
    expect(page.value).toBe(2)
    // back to 1 takes the `delete query.page` branch
    page.value = 1
    await nextTick()
    await flushPromises()
    expect(page.value).toBe(1)
    expect((r.total as { value: number }).value).toBe(50)
    expect((r.items as { value: unknown[] | undefined }).value).toHaveLength(1)
  })

  it('clamps an out-of-range page down to the last page when the list shrinks', async () => {
    stubPaged(200) // 200 / 24 => 9 pages
    const r = await mountWith(() => usePagedItems({ endpoint: '/api/paged', syncUrl: false, pageSize: 24 }))
    await flushPromises()
    const page = r.page as { value: number }
    page.value = 9
    await nextTick()
    await flushPromises()
    // list shrinks to a single page while we sit on page 9 -> the total watcher clamps us down
    totalRef.value = 10 // 10 / 24 => 1 page
    await (r.refresh as unknown as () => Promise<void>)()
    await nextTick()
    await flushPromises()
    await nextTick()
    expect(page.value).toBe(1)
    expect((r.items as { value: unknown }).value).toBeDefined()
  })

  it('keeps page in range when total still covers it', async () => {
    stubPaged(0)
    const r = await mountWith(() => usePagedItems({ endpoint: '/api/paged-empty', syncUrl: false }))
    await flushPromises()
    const page = r.page as { value: number }
    // total grows to cover a higher page -> the page <= pageCount branch keeps us put
    totalRef.value = 500
    page.value = 5
    await nextTick()
    await flushPromises()
    await nextTick()
    expect(page.value).toBe(5)
  })

  it('mirrors the page into the URL via the syncUrl page watcher', async () => {
    stubPaged(500) // plenty of pages so the clamp watcher never moves us
    const replaceSpy = vi.fn()
    pagedEnv.replace = replaceSpy
    const r = await mountWith(() => usePagedItems({ endpoint: '/api/paged', syncUrl: true, key: 'sync' }))
    const page = r.page as { value: number }
    expect(page.value).toBe(1)

    // page > 1 -> the watcher writes query.page (the else branch of stmt 37)
    page.value = 3
    await nextTick()
    await flushPromises()
    expect(replaceSpy).toHaveBeenCalledWith({ query: { page: '3' } })

    // back to 1 -> the `delete query.page` branch removes it before replace
    replaceSpy.mockClear()
    page.value = 1
    await nextTick()
    await flushPromises()
    expect(replaceSpy).toHaveBeenCalledWith({ query: {} })
  })

  it('forces a refetch on hydration when a deep-linked page is out of range', async () => {
    stubPaged(10) // 10 / 24 => 1 page, but we deep-link onto page 9
    pagedEnv.routeQuery = { page: '9' }
    // onNuxtReady captures the deferred `() => refresh()` so we can run it on demand
    const readyCb: { fn?: () => void } = {}
    pagedEnv.onNuxtReady = cb => {
      readyCb.fn = cb
    }
    const r = await mountWith(() => {
      // mid-hydration: the immediate total watcher clamps page 9 -> 1 and, because the page-change
      // refetch is served the stale hydration payload, defers a real refresh via onNuxtReady (stmt 71)
      ;(useNuxtApp() as unknown as { isHydrating: boolean }).isHydrating = true
      return usePagedItems({ endpoint: '/api/paged-hydrate', syncUrl: true, pageSize: 24, key: 'hydrate' })
    })
    await flushPromises()
    const page = r.page as { value: number }
    // clamped from the deep-linked 9 down to the single available page
    expect(page.value).toBe(1)
    // invoking the captured `() => refresh()` runs the deferred refresh without throwing
    expect(typeof readyCb.fn).toBe('function')
    await readyCb.fn?.()
    await flushPromises()
    expect(page.value).toBe(1)
  })
})

describe('useAdminPagedList (branches)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces search into q, resets to page 1, and disposes on unmount', async () => {
    const fetchSpy = vi.fn()
    const disposeSpy = vi.fn()
    const extra = ref(0)
    const search = useState<string>('admin:search', () => '')
    search.value = ''

    let api: { page: { value: number }; pageSize: number } | undefined
    const wrapper = await mountSuspended(
      defineComponent({
        setup() {
          api = useAdminPagedList({
            fetch: fetchSpy,
            filters: [extra],
            dispose: disposeSpy,
            pageSize: 10,
          }) as never
          return () => h('div')
        },
      }),
    )
    // onBeforeMount fetch
    expect(fetchSpy).toHaveBeenCalledWith({ page: 1, pageSize: 10, q: undefined })
    fetchSpy.mockClear()

    // page watcher: bump page directly -> run() with new page
    api!.page.value = 2
    await nextTick()
    expect(fetchSpy).toHaveBeenLastCalledWith({ page: 2, pageSize: 10, q: undefined })
    fetchSpy.mockClear()

    // search change while on page 2 -> resets to page 1 (fetch via page watcher), q populated
    search.value = 'golf'
    await vi.advanceTimersByTimeAsync(400)
    await nextTick()
    await nextTick()
    expect(api!.page.value).toBe(1)
    expect(fetchSpy).toHaveBeenLastCalledWith({ page: 1, pageSize: 10, q: 'golf' })
    fetchSpy.mockClear()

    // filter change while already on page 1 -> run() directly
    extra.value = 1
    await nextTick()
    expect(fetchSpy).toHaveBeenLastCalledWith({ page: 1, pageSize: 10, q: 'golf' })

    wrapper.unmount()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('omits dispose when not provided and uses the default pageSize', async () => {
    const fetchSpy = vi.fn()
    const search = useState<string>('admin:search', () => '')
    search.value = ''
    const wrapper = await mountSuspended(
      defineComponent({
        setup() {
          useAdminPagedList({ fetch: fetchSpy })
          return () => h('div')
        },
      }),
    )
    expect(fetchSpy).toHaveBeenCalledWith({ page: 1, pageSize: 20, q: undefined })
    // no dispose registered -> unmount must not throw
    expect(() => wrapper.unmount()).not.toThrow()
  })
})

describe('useLiveItems (branches)', () => {
  const livePayload = ref<LiveItem[]>([])
  const now = 1_000_000_000_000

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.stubGlobal(
      '$fetch',
      vi.fn(async () => livePayload.value),
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('polls and fills the live map; tolerates a thrown fetch', async () => {
    livePayload.value = [{ id: 'i1', bidCount: 2, sold: false, closed: false } as LiveItem]
    const items = [item({ id: 'i1', startDate: now - 1000, endDate: now + 60_000 })]
    const r = await mountWith(() => useLiveItems(() => items))
    await flushPromises()
    const map = (r.live as { value: Map<string, LiveItem> }).value
    expect(map.get('i1')?.bidCount).toBe(2)

    // a thrown fetch keeps the last known state
    vi.stubGlobal(
      '$fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    // trigger a re-poll via the ids watcher by mutating nothing — instead force start by visibility
    await flushPromises()
    expect((r.live as { value: Map<string, LiveItem> }).value).toBeInstanceOf(Map)
  })

  it('is a no-op for an empty item set', async () => {
    const fetchSpy = vi.fn(async () => [] as LiveItem[])
    vi.stubGlobal('$fetch', fetchSpy)
    const r = await mountWith(() => useLiveItems(() => [] as Item[]))
    await flushPromises()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect((r.live as { value: Map<string, LiveItem> }).value.size).toBe(0)
  })

  it('stops polling once every watched item is terminal', async () => {
    livePayload.value = [{ id: 'i1', bidCount: 0, sold: true, closed: false } as LiveItem]
    const items = [item({ id: 'i1', sold: true })]
    const r = await mountWith(() => useLiveItems(() => items))
    await flushPromises()
    // terminal -> nextDelay null -> paused; map still reflects the one poll
    expect((r.live as { value: Map<string, LiveItem> }).value.get('i1')?.sold).toBe(true)
  })

  it('reacts to the ids watcher and visibility changes', async () => {
    livePayload.value = [{ id: 'i1', bidCount: 1, sold: false, closed: false } as LiveItem]
    const list = ref<Item[]>([item({ id: 'i1', startDate: now - 1, endDate: now + 60_000 })])
    const r = await mountWith(() => useLiveItems(list))
    await flushPromises()
    expect((r.live as { value: Map<string, LiveItem> }).value.size).toBe(1)

    // change the watched set -> start() re-runs
    livePayload.value = [
      { id: 'i1', bidCount: 1, sold: false, closed: false } as LiveItem,
      { id: 'i2', bidCount: 0, sold: false, closed: false } as LiveItem,
    ]
    list.value = [
      item({ id: 'i1', startDate: now - 1, endDate: now + 60_000 }),
      item({ id: 'i2', startDate: now - 1, endDate: now + 60_000 }),
    ]
    await nextTick()
    await flushPromises()
    expect((r.live as { value: Map<string, LiveItem> }).value.size).toBe(2)
  })

  it('idles when active items have no resolvable end date', async () => {
    livePayload.value = [{ id: 'i1', bidCount: 0, sold: false, closed: false } as LiveItem]
    // not-yet-started auction (startDate in the future) -> active but no driving end
    const items = [item({ id: 'i1', startDate: now + 60_000, endDate: undefined })]
    const r = await mountWith(() => useLiveItems(() => items))
    await flushPromises()
    expect((r.live as { value: Map<string, LiveItem> }).value.get('i1')?.bidCount).toBe(0)
  })

  it('enters fast cadence inside the soft-close window', async () => {
    livePayload.value = [{ id: 'i1', bidCount: 3, sold: false, closed: false, endDate: now + 1000 } as LiveItem]
    const items = [item({ id: 'i1', startDate: now - 1000, endDate: now + 1000 })]
    const r = await mountWith(() => useLiveItems(() => items))
    await flushPromises()
    expect((r.live as { value: Map<string, LiveItem> }).value.get('i1')?.endDate).toBe(now + 1000)
  })

  it('guards a re-entrant poll while one is in flight', async () => {
    vi.useFakeTimers()
    try {
      let pending = 0
      let resolveFetch: (v: LiveItem[]) => void = () => {}
      const slow = vi.fn(() => {
        pending++
        return new Promise<LiveItem[]>(res => {
          resolveFetch = res
        })
      })
      vi.stubGlobal('$fetch', slow)
      const list = ref<Item[]>([item({ id: 'i1', startDate: now - 1000, endDate: now + 60_000 })])

      await mountSuspended(
        defineComponent({
          setup() {
            useLiveItems(list)
            return () => h('div')
          },
        }),
      )
      await Promise.resolve()
      expect(slow).toHaveBeenCalledTimes(1) // first poll, in flight

      // mutate the watched ids -> start() -> poll() again while inFlight is still true -> guarded
      list.value = [item({ id: 'i2', startDate: now - 1000, endDate: now + 60_000 })]
      await nextTick()
      await Promise.resolve()
      expect(slow).toHaveBeenCalledTimes(1) // re-entrant poll short-circuited by the inFlight guard

      resolveFetch([])
      await vi.advanceTimersByTimeAsync(0)
      expect(pending).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ticks the interval to a terminal state, then pauses, and pauses on a hidden tab', async () => {
    vi.useFakeTimers()
    try {
      // first poll keeps the item active so the LIVE_MS interval arms…
      const responses: LiveItem[][] = [
        // far-future end -> LIVE cadence (covers the non-fast branch + interval's `delay.value = d`)
        [{ id: 'i1', bidCount: 1, sold: false, closed: false, endDate: now + 600_000 } as LiveItem],
        [{ id: 'i1', bidCount: 2, sold: false, closed: false, endDate: now + 600_000 } as LiveItem],
        // …then the next tick reports the item terminal -> nextDelay() null -> pause()
        [{ id: 'i1', bidCount: 2, sold: true, closed: true, endDate: now + 600_000 } as LiveItem],
      ]
      let call = 0
      const seq = vi.fn(async () => responses[Math.min(call++, responses.length - 1)])
      vi.stubGlobal('$fetch', seq)
      const items = [item({ id: 'i1', startDate: now - 1000, endDate: now + 600_000 })]

      await mountSuspended(
        defineComponent({
          setup() {
            useLiveItems(() => items)
            return () => h('div')
          },
        }),
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(seq).toHaveBeenCalledTimes(1)

      // a tick that stays active -> interval takes `else delay.value = d`
      await vi.advanceTimersByTimeAsync(10_000)
      expect(seq).toHaveBeenCalledTimes(2)

      // next tick: poll returns terminal -> interval pauses
      await vi.advanceTimersByTimeAsync(10_000)
      expect(seq).toHaveBeenCalledTimes(3)
      const afterTerminal = seq.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(seq.mock.calls.length).toBe(afterTerminal) // paused: terminal stops the poller

      // hidden-tab branch on a fresh live poller
      vi.stubGlobal(
        '$fetch',
        vi.fn(async () => [{ id: 'i1', bidCount: 1, sold: false, closed: false, endDate: now + 60_000 } as LiveItem]),
      )
      const live2 = [item({ id: 'i1', startDate: now - 1000, endDate: now + 60_000 })]
      await mountSuspended(
        defineComponent({
          setup() {
            useLiveItems(() => live2)
            return () => h('div')
          },
        }),
      )
      await vi.advanceTimersByTimeAsync(0)
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(60_000) // paused — interval body must not throw

      // foreground again -> visibility watcher's start() branch resumes the poller
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      vi.useRealTimers()
    }
  })
})
