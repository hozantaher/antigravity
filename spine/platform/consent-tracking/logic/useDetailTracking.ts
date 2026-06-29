import type { Ref } from 'vue'
import { itemSignalMeta, RECO_CONFIG, type Item } from '~/models'

// Detail-page signals (§3.3): detail_view, active-visible dwell (clamped, paused when the tab
// is hidden), scroll depth, and a derived short-dwell bounce. Flushes the previous item's
// counters when the page is reused for a different item (useItemDetail navigations).
export const useDetailTracking = (item: Ref<Item | null | undefined>): void => {
  // SSR guard — unreachable (hence uncovered) in the client-only test env
  if (import.meta.server) return
  const tracking = useTracking()
  const visibility = useDocumentVisibility()

  let currentId: string | null = null
  let active = 0
  let maxDepth = 0

  const flushCurrent = (): void => {
    if (!currentId) return
    if (active > 0) tracking.dwell(currentId, active)
    if (maxDepth > 0) tracking.scrollDepth(currentId, maxDepth)
    if (active < 3) tracking.shortBounce(currentId) // <3s active ≈ pogo-stick bounce
    active = 0
    maxDepth = 0
  }

  // Active-only heartbeat: only counts while the tab is visible (background tabs don't inflate).
  const poll = useTimeoutPoll(
    () => {
      active = Math.min(active + 1, RECO_CONFIG.dwellClampSec)
    },
    1000,
    { immediate: false },
  )
  watch(visibility, v => (v === 'visible' ? poll.resume() : poll.pause()))

  watch(
    () => item.value?.id,
    (id, prev) => {
      if (prev && prev !== id) flushCurrent()
      currentId = id ?? null
      if (id && item.value) {
        tracking.detailView(id, item.value.categoryId, itemSignalMeta(item.value))
        if (visibility.value === 'visible') poll.resume()
      }
    },
    { immediate: true },
  )

  useEventListener(
    window,
    'scroll',
    useThrottleFn(() => {
      const doc = document.documentElement
      maxDepth = Math.max(maxDepth, Math.min(1, (window.scrollY + window.innerHeight) / Math.max(1, doc.scrollHeight)))
    }, 500),
    { passive: true },
  )

  onScopeDispose(flushCurrent)
}
