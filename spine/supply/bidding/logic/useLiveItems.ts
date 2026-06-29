import { useIntervalFn, useDocumentVisibility } from '@vueuse/core'
import type { Item, LiveItem } from '~/models'

const SOFT_CLOSE_MS = 3 * 60 * 1000
// Cadence tiers: fast in the soft-close endgame (a bid extends the clock — viewers must see it),
// relaxed while an auction is live, slow when only not-yet-started / awaiting-close items remain.
const FAST_MS = 2000
const LIVE_MS = 10_000
const IDLE_MS = 30_000

// Polls the slim /api/items/live endpoint for the given items and exposes the latest state per id.
// Adaptive: speeds up near an auction's end, slows when nothing is imminent, pauses while the tab
// is hidden, and stops once every watched item is terminal (closed/sold). The returned map is
// reassigned on each poll, so consumers can depend on it from a plain computed/watch. Client-only;
// a no-op during SSR.
export const useLiveItems = (items: MaybeRefOrGetter<Item[]>) => {
  const live = ref(new Map<string, LiveItem>())
  let inFlight = false

  const poll = async () => {
    const list = toValue(items)
    if (list.length === 0 || inFlight) return
    inFlight = true
    try {
      const res = await $fetch<LiveItem[]>('/api/items/live', { query: { ids: list.map(i => i.id).join(',') } })
      const next = new Map<string, LiveItem>()
      for (const l of res) next.set(l.id, l)
      live.value = next
    } catch {
      // Transient failure (offline, 5xx): keep the last known state and retry next tick.
    } finally {
      inFlight = false
    }
  }

  // Next delay from the freshest known state (a live endDate overrides the item's). Only a
  // started, not-yet-ended auction drives the fast/live cadence; null = every watched item is
  // terminal, so stop polling.
  const nextDelay = (): number | null => {
    const now = Date.now()
    let active = false
    let soonestEnd = Infinity
    for (const it of toValue(items)) {
      const l = live.value.get(it.id)
      if ((l?.closed ?? it.closed) || (l?.sold ?? it.sold)) continue
      active = true
      const end = l?.endDate ?? it.endDate
      const started = it.startDate == null || it.startDate <= now
      if (started && end != null && end > now) soonestEnd = Math.min(soonestEnd, end)
    }
    if (!active) return null
    if (soonestEnd === Infinity) return IDLE_MS
    return soonestEnd - now < SOFT_CLOSE_MS ? FAST_MS : LIVE_MS
  }

  const delay = ref(LIVE_MS)
  const { pause, resume } = useIntervalFn(
    async () => {
      await poll()
      const d = nextDelay()
      if (d == null) pause()
      else delay.value = d
    },
    delay,
    { immediate: false },
  )

  // (Re)start: poll immediately to catch up, set the cadence, then arm the interval — unless
  // there's nothing left to watch.
  const start = async () => {
    if (toValue(items).length === 0) {
      pause()
      return
    }
    await poll()
    const d = nextDelay()
    if (d == null) {
      pause()
      return
    }
    delay.value = d
    resume()
  }

  if (import.meta.client) {
    const visibility = useDocumentVisibility()
    onMounted(start)
    // Re-target when the watched set changes (page change, item loaded/refetched).
    watch(
      () =>
        toValue(items)
          .map(i => i.id)
          .join(','),
      start,
    )
    // Don't poll a backgrounded tab; catch up the moment it's foregrounded again.
    watch(visibility, v => (v === 'hidden' ? pause() : start()))
  }

  return { live }
}
