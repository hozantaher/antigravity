import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, type Ref } from 'vue'
import { useDetailTracking } from '~/features/platform/consent-tracking/logic/useDetailTracking'
import { RECO_CONFIG, type Item } from '~/models'

// useDetailTracking leans on useTracking (the event sink) plus a handful of VueUse auto-imports.
// We mock all of them so the dwell/scroll/bounce branches can be driven deterministically without
// real timers or a live document.visibilityState.
const { tracking, visibility, poll, scrollHandler } = vi.hoisted(() => ({
  tracking: {
    detailView: vi.fn(),
    dwell: vi.fn(),
    scrollDepth: vi.fn(),
    shortBounce: vi.fn(),
  },
  // a plain object holding the ref so the watch sees a stable reactive source
  visibility: { ref: null as Ref<string> | null },
  poll: { resume: vi.fn(), pause: vi.fn(), tick: null as (() => void) | null },
  scrollHandler: { fn: null as (() => void) | null },
}))

mockNuxtImport('useTracking', () => () => tracking)
mockNuxtImport('useDocumentVisibility', () => () => visibility.ref)
mockNuxtImport('useTimeoutPoll', () => (cb: () => void) => {
  poll.tick = cb
  return { resume: poll.resume, pause: poll.pause, isActive: ref(false) }
})
// run throttle synchronously so the scroll math executes immediately
mockNuxtImport('useThrottleFn', () => (fn: () => void) => fn)
mockNuxtImport('useEventListener', () => (_t: unknown, _e: string, handler: () => void) => {
  scrollHandler.fn = handler
})

const makeItem = (id: string, categoryId = 'cars'): Item =>
  ({ id, categoryId, type: 'auction', bids: [], specs: { manufacturer: 'BMW' }, bodyType: 'sedan' }) as unknown as Item

// Mount the composable inside a component so onScopeDispose + watch lifecycle run, returning the
// wrapper (for unmount) and the item ref so the test can drive navigations.
const mountTracking = async (item: Ref<Item | null | undefined>) => {
  const wrapper = await mountSuspended(
    defineComponent({
      setup() {
        useDetailTracking(item)
        return () => h('div')
      },
    }),
  )
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  visibility.ref = ref('visible')
  poll.tick = null
  scrollHandler.fn = null
})

describe('useDetailTracking', () => {
  it('emits detail_view immediately for the initial item and resumes the poll when visible', async () => {
    const item = ref<Item | null>(makeItem('i1'))
    await mountTracking(item)

    expect(tracking.detailView).toHaveBeenCalledTimes(1)
    expect(tracking.detailView).toHaveBeenCalledWith('i1', 'cars', expect.any(Object))
    expect(poll.resume).toHaveBeenCalledTimes(1)
  })

  it('does not resume the poll on the initial item while the tab is hidden', async () => {
    visibility.ref = ref('hidden')
    const item = ref<Item | null>(makeItem('i1'))
    await mountTracking(item)

    expect(tracking.detailView).toHaveBeenCalledTimes(1)
    expect(poll.resume).not.toHaveBeenCalled()
  })

  it('does nothing when the initial item is null (no id branch)', async () => {
    const item = ref<Item | null>(null)
    await mountTracking(item)

    expect(tracking.detailView).not.toHaveBeenCalled()
    expect(poll.resume).not.toHaveBeenCalled()
  })

  it('flushes the previous item (dwell + scroll + no bounce) when navigating with enough active time', async () => {
    const item = ref<Item | null>(makeItem('i1'))
    await mountTracking(item)

    // accumulate active seconds via the poll tick (>= 3 so no short bounce)
    poll.tick?.()
    poll.tick?.()
    poll.tick?.()
    // accumulate scroll depth
    Object.defineProperty(window, 'scrollY', { value: 100, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 1800, configurable: true })
    scrollHandler.fn?.()

    item.value = makeItem('i2')
    await flushPromises()

    expect(tracking.dwell).toHaveBeenCalledWith('i1', 3)
    expect(tracking.scrollDepth).toHaveBeenCalledWith('i1', 0.5)
    expect(tracking.shortBounce).not.toHaveBeenCalled()
    // second item recorded
    expect(tracking.detailView).toHaveBeenCalledWith('i2', 'cars', expect.any(Object))
  })

  it('emits a short bounce when active time is under 3 seconds on navigation', async () => {
    const item = ref<Item | null>(makeItem('i1'))
    await mountTracking(item)

    poll.tick?.() // active = 1 (<3)

    item.value = makeItem('i2')
    await flushPromises()

    expect(tracking.dwell).toHaveBeenCalledWith('i1', 1)
    expect(tracking.scrollDepth).not.toHaveBeenCalled() // maxDepth stayed 0
    expect(tracking.shortBounce).toHaveBeenCalledWith('i1')
  })

  it('clamps active dwell at the configured ceiling', async () => {
    const item = ref<Item | null>(makeItem('i1'))
    await mountTracking(item)

    for (let i = 0; i < RECO_CONFIG.dwellClampSec + 5; i++) poll.tick?.()

    item.value = makeItem('i2')
    await flushPromises()

    expect(tracking.dwell).toHaveBeenCalledWith('i1', RECO_CONFIG.dwellClampSec)
  })

  it('pauses and resumes the poll as visibility toggles', async () => {
    const item = ref<Item | null>(makeItem('i1'))
    await mountTracking(item)
    vi.clearAllMocks()

    visibility.ref!.value = 'hidden'
    await flushPromises()
    expect(poll.pause).toHaveBeenCalledTimes(1)
    expect(poll.resume).not.toHaveBeenCalled()

    visibility.ref!.value = 'visible'
    await flushPromises()
    expect(poll.resume).toHaveBeenCalledTimes(1)
  })

  it('flushes on scope dispose (component unmount)', async () => {
    const item = ref<Item | null>(makeItem('i1'))
    const wrapper = await mountTracking(item)

    poll.tick?.() // active = 1 → short bounce on dispose
    wrapper.unmount()

    expect(tracking.dwell).toHaveBeenCalledWith('i1', 1)
    expect(tracking.shortBounce).toHaveBeenCalledWith('i1')
  })

  it('does nothing on dispose when no item was ever tracked (flush guard)', async () => {
    const item = ref<Item | null>(null)
    const wrapper = await mountTracking(item)

    wrapper.unmount()

    expect(tracking.dwell).not.toHaveBeenCalled()
    expect(tracking.shortBounce).not.toHaveBeenCalled()
  })

  it('clamps scroll depth at 1 and guards a zero scrollHeight', async () => {
    const item = ref<Item | null>(makeItem('i1'))
    await mountTracking(item)

    // huge scroll position with a degenerate (0) scrollHeight → Math.max(1, 0) guard, clamped to 1
    Object.defineProperty(window, 'scrollY', { value: 5000, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true })
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 0, configurable: true })
    scrollHandler.fn?.()

    item.value = makeItem('i2')
    await flushPromises()

    expect(tracking.scrollDepth).toHaveBeenCalledWith('i1', 1)
  })
})
