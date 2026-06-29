import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

import { useTracking } from '~/features/platform/consent-tracking/logic/useTracking'
import { VID_COOKIE } from '~/models'

// useCookieConsent is mocked so a single ref controls the consent gate across the whole suite.
// The composable reads consent.value lazily inside enqueue(), so flipping this ref between tests
// exercises both the gated (no-op) and accepted (collect) branches.
const { consent } = vi.hoisted(() => ({ consent: { value: true } }))
mockNuxtImport('useCookieConsent', () => () => ({ accepted: consent }))

// useTracking keeps module-level singletons (buffer/seen/enabled/sessionId). Tests run in file
// order, so the first block asserts the pre-enable() behavior, then enable() latches `enabled`.
beforeEach(() => {
  consent.value = true
  vi.stubGlobal('$fetch', vi.fn())
})

describe('useTracking — before enable()', () => {
  it('enqueue is a no-op while disabled (enabled guard)', () => {
    const t = useTracking()
    t.enqueue({
      type: 'impression',
      itemId: 'x',
      categoryId: null,
      value: null,
      surface: null,
      position: null,
      propensity: null,
      meta: null,
    })
    t.flush()
    expect($fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('flush returns early on an empty buffer', () => {
    useTracking().flush()
    expect($fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })
})

describe('useTracking — enable()', () => {
  it('mints a vid cookie + session id on the first enable() and is idempotent thereafter', () => {
    // Clear any prior vid so enable() takes the `if (!vid.value)` (mint) branch on this first run.
    useCookie<string | null>(VID_COOKIE).value = null

    const t = useTracking()
    expect(() => t.enable()).not.toThrow()

    // Now that the singleton has latched `enabled`, a signed event flushes — proving sessionId is set.
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', fetchMock)
    t.emit('share', { itemId: 'a' })
    t.flush()
    expect(typeof fetchMock.mock.calls[0]![1].body.sessionId).toBe('string')

    // Second enable() hits `if (enabled) return` — no throw, no re-mint.
    expect(() => t.enable()).not.toThrow()
  })
})

describe('useTracking — enqueue / flush', () => {
  it('respects the consent gate even when enabled', () => {
    consent.value = false
    useTracking().emit('share', { itemId: 'a' })
    useTracking().flush()
    expect($fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('buffers an event and flushes it via $fetch keepalive', () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    t.emit('share', { itemId: 'a' })
    t.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, opts] = fetchMock.mock.calls[0]!
    expect(path).toBe('/api/track')
    expect(opts.method).toBe('POST')
    expect(opts.keepalive).toBe(true)
    expect(opts.body.events).toHaveLength(1)
    expect(opts.body.events[0]).toMatchObject({ type: 'share', itemId: 'a' })
    expect(opts.body.events[0].id).toBeTruthy()
    expect(typeof opts.body.events[0].occurredAt).toBe('number')
    expect(typeof opts.body.sessionId).toBe('string')
  })

  it('swallows a rejected $fetch (catch path)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network'))
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    t.emit('share', { itemId: 'a' })
    expect(() => t.flush()).not.toThrow()
    // Let the rejected promise settle so the .catch(() => {}) handler runs.
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('accumulates session attrs from event meta and exposes them via sessionAttrs()', () => {
    const t = useTracking()
    t.emit('impression', { itemId: 'a', meta: { make: 'BMW', bodyType: 'suv', priceBand: 'b2' } })
    // meta with only some fields exercises the per-field optional-chain guards independently.
    t.emit('impression', { itemId: 'b', meta: { make: 'Audi' } })
    t.emit('impression', { itemId: 'c', meta: null })

    const seen = t.sessionAttrs()
    expect(seen.makes).toContain('BMW')
    expect(seen.makes).toContain('Audi')
    expect(seen.bodyTypes).toContain('suv')
    expect(seen.priceBands).toContain('b2')
  })

  it('auto-flushes once the buffer reaches the FLUSH_AT threshold', () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    for (let i = 0; i < 20; i++) t.emit('impression', { itemId: `i${i}` })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1].body.events).toHaveLength(20)
  })

  it('uses navigator.sendBeacon on unload flush', () => {
    const beacon = vi.fn().mockReturnValue(true)
    const original = navigator.sendBeacon
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })
    const fetchMock = vi.fn()
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    t.emit('share', { itemId: 'a' })
    t.flush(true)

    expect(beacon).toHaveBeenCalledTimes(1)
    const [url, blob] = beacon.mock.calls[0]!
    expect(url).toBe('/api/track')
    expect(blob).toBeInstanceOf(Blob)
    expect(fetchMock).not.toHaveBeenCalled()

    if (original) Object.defineProperty(navigator, 'sendBeacon', { value: original, configurable: true })
    else delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon
  })

  it('falls back to $fetch when unload is requested but sendBeacon is unavailable', () => {
    const original = navigator.sendBeacon
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true })
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    t.emit('share', { itemId: 'a' })
    t.flush(true)

    expect(fetchMock).toHaveBeenCalledTimes(1)

    if (original) Object.defineProperty(navigator, 'sendBeacon', { value: original, configurable: true })
    else delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon
  })
})

describe('useTracking — emit defaults and typed signal helpers', () => {
  it('emit applies all the ?? null defaults for an empty opts object', () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    t.emit('share')
    t.flush()
    expect(fetchMock.mock.calls[0]![1].body.events[0]).toMatchObject({
      type: 'share',
      itemId: null,
      categoryId: null,
      value: null,
      surface: null,
      position: null,
      propensity: null,
      meta: null,
    })
  })

  it('emit preserves explicitly provided opts (non-default branch of each ??)', () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    t.emit('card_hover_dwell', {
      itemId: 'a',
      categoryId: 'cat',
      value: 5,
      surface: 'home',
      position: 3,
      propensity: 0.5,
      meta: { make: 'BMW' },
    })
    t.flush()
    expect(fetchMock.mock.calls[0]![1].body.events[0]).toMatchObject({
      type: 'card_hover_dwell',
      itemId: 'a',
      categoryId: 'cat',
      value: 5,
      surface: 'home',
      position: 3,
      propensity: 0.5,
      meta: { make: 'BMW' },
    })
  })

  it('every typed helper emits the right event shape', () => {
    const fetchMock = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('$fetch', fetchMock)

    const t = useTracking()
    t.detailView('i1', 'c1', { make: 'BMW' })
    t.detailView('i1b') // optional categoryId/meta omitted
    t.dwell('i2', 12)
    t.scrollDepth('i3', 80)
    t.shortBounce('i4')
    t.photoView('i5', 3, { make: 'Audi' })
    t.photoView('i5b', 2) // optional meta omitted
    t.photoZoom('i6', 4)
    t.pano('i7', 1)
    t.videoPlay('i8')
    t.share('i9')
    t.compareAdd('i10')
    t.categoryView('c2')
    t.cardHover('i11', 200, 'detail', 0, { make: 'VW' })
    t.cardHover('i11b', 100, 'detail', 1) // optional meta omitted
    t.cardViewport('i12', 3, 'home', 2, { make: 'Skoda' })
    t.cardViewport('i12b', 2, 'home', 3) // optional meta omitted
    t.impression('i13', 'detail', 0, { make: 'Seat' })
    t.impression('i13b', 'detail', 1) // optional meta omitted

    // 19 events; FLUSH_AT is 20 so nothing auto-flushed yet.
    t.flush()
    const events = fetchMock.mock.calls[0]![1].body.events
    const byType = (type: string) => events.filter((e: { type: string }) => e.type === type)

    expect(byType('detail_view')).toHaveLength(2)
    expect(events.find((e: { type: string }) => e.type === 'detail_view')).toMatchObject({
      itemId: 'i1',
      categoryId: 'c1',
      surface: 'detail',
      meta: { make: 'BMW' },
    })
    expect(byType('dwell_active')[0]).toMatchObject({ itemId: 'i2', value: 12, surface: 'detail' })
    expect(byType('scroll_depth')[0]).toMatchObject({ itemId: 'i3', value: 80, surface: 'detail' })
    expect(byType('short_dwell_bounce')[0]).toMatchObject({ itemId: 'i4', surface: 'detail' })
    expect(byType('photo_view')[0]).toMatchObject({ itemId: 'i5', value: 3, meta: { make: 'Audi' } })
    expect(byType('photo_zoom')[0]).toMatchObject({ itemId: 'i6', value: 4 })
    expect(byType('pano_360_interact')[0]).toMatchObject({ itemId: 'i7', value: 1 })
    expect(byType('video_play')[0]).toMatchObject({ itemId: 'i8' })
    expect(byType('share')[0]).toMatchObject({ itemId: 'i9' })
    expect(byType('compare_add')[0]).toMatchObject({ itemId: 'i10' })
    expect(byType('category_view')[0]).toMatchObject({ categoryId: 'c2' })
    expect(byType('card_hover_dwell')[0]).toMatchObject({
      itemId: 'i11',
      value: 200,
      surface: 'detail',
      position: 0,
      meta: { make: 'VW' },
    })
    expect(byType('card_viewport_dwell')[0]).toMatchObject({
      itemId: 'i12',
      value: 3,
      surface: 'home',
      position: 2,
      meta: { make: 'Skoda' },
    })
    expect(byType('impression')[0]).toMatchObject({
      itemId: 'i13',
      surface: 'detail',
      position: 0,
      propensity: 1,
      meta: { make: 'Seat' },
    })
  })
})
