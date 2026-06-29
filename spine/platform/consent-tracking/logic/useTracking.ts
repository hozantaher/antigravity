import {
  type RecoEventType,
  type RecoSurface,
  type SessionSeen,
  type TrackEvent,
  type TrackEventMeta,
  VID_COOKIE,
} from '~/models'

// Non-blocking, consent-gated client event stream (§3.6). enqueue() never awaits; the buffer
// flushes on an interval, on tab-hide and on unload. Module-level singleton so every component
// shares one buffer + the session attribute accumulator the within-session re-rank reads (§14).
const buffer: TrackEvent[] = []
const seen: SessionSeen = { makes: new Set(), bodyTypes: new Set(), priceBands: new Set() }
let enabled = false
let sessionId = ''
const FLUSH_AT = 20

export const useTracking = () => {
  const consent = useCookieConsent().accepted

  // Called once from plugins/tracking.client.ts after consent — mints the vid cookie (rides SSR)
  // and the per-tab session id. No collection happens before this (privacy gate, §10.9).
  const enable = (): void => {
    if (enabled) return
    enabled = true
    const vid = useCookie<string | null>(VID_COOKIE, {
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      secure: !import.meta.dev,
      path: '/',
    })
    if (!vid.value) vid.value = crypto.randomUUID()
    sessionId = useSessionStorage<string>('a24_sid', () => crypto.randomUUID()).value
  }

  // Unload → sendBeacon (most reliable, but can't attach the bearer). Otherwise → $fetch keepalive,
  // which the api.client plugin auto-authenticates on /api, so a signed-in user's events carry
  // their userId (merge-on-login, §4.6). Fire-and-forget either way.
  const flush = (unload = false): void => {
    if (buffer.length === 0) return
    const events = buffer.splice(0, buffer.length)
    const body = { sessionId, events }
    if (unload && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([JSON.stringify(body)], { type: 'application/json' }))
      return
    }
    $fetch('/api/track', { method: 'POST', keepalive: true, body }).catch(() => {})
  }

  const enqueue = (e: Omit<TrackEvent, 'id' | 'occurredAt'>): void => {
    if (!enabled || !consent.value) return
    if (e.meta?.make) seen.makes.add(e.meta.make)
    if (e.meta?.bodyType) seen.bodyTypes.add(e.meta.bodyType)
    if (e.meta?.priceBand) seen.priceBands.add(e.meta.priceBand)
    buffer.push({ ...e, id: crypto.randomUUID(), occurredAt: Date.now() })
    if (buffer.length >= FLUSH_AT) flush()
  }

  const sessionAttrs = (): SessionSeen => seen

  interface EmitOpts {
    itemId?: string | null
    categoryId?: string | null
    value?: number | null
    surface?: RecoSurface
    position?: number | null
    propensity?: number | null
    meta?: TrackEventMeta | null
  }
  const emit = (type: RecoEventType, o: EmitOpts = {}): void =>
    enqueue({
      type,
      itemId: o.itemId ?? null,
      categoryId: o.categoryId ?? null,
      value: o.value ?? null,
      surface: o.surface ?? null,
      position: o.position ?? null,
      propensity: o.propensity ?? null,
      meta: o.meta ?? null,
    })

  return {
    enable,
    flush,
    enqueue,
    emit,
    sessionAttrs,
    // Detail-page signals
    detailView: (itemId: string, categoryId?: string, meta?: TrackEventMeta) =>
      emit('detail_view', { itemId, categoryId, meta, surface: 'detail' }),
    dwell: (itemId: string, seconds: number) => emit('dwell_active', { itemId, value: seconds, surface: 'detail' }),
    scrollDepth: (itemId: string, depth: number) => emit('scroll_depth', { itemId, value: depth, surface: 'detail' }),
    shortBounce: (itemId: string) => emit('short_dwell_bounce', { itemId, surface: 'detail' }),
    photoView: (itemId: string, count: number, meta?: TrackEventMeta) =>
      emit('photo_view', { itemId, value: count, meta }),
    photoZoom: (itemId: string, count: number) => emit('photo_zoom', { itemId, value: count }),
    pano: (itemId: string, count: number) => emit('pano_360_interact', { itemId, value: count }),
    videoPlay: (itemId: string) => emit('video_play', { itemId }),
    share: (itemId: string) => emit('share', { itemId }),
    compareAdd: (itemId: string) => emit('compare_add', { itemId }),
    categoryView: (categoryId: string) => emit('category_view', { categoryId }),
    // Card signals (carry slot position + a propensity prior for later IPS debiasing)
    cardHover: (itemId: string, ms: number, surface: RecoSurface, position: number, meta?: TrackEventMeta) =>
      emit('card_hover_dwell', { itemId, value: ms, surface, position, meta }),
    cardViewport: (itemId: string, seconds: number, surface: RecoSurface, position: number, meta?: TrackEventMeta) =>
      emit('card_viewport_dwell', { itemId, value: seconds, surface, position, meta }),
    impression: (itemId: string, surface: RecoSurface, position: number, meta?: TrackEventMeta) =>
      emit('impression', { itemId, surface, position, propensity: 1, meta }),
  }
}
