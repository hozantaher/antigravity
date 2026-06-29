import type { Item } from '~/models'

// Item status derived off the single shared 1s ticker (one app-wide interval, see useSharedNow).
// The `void now.value` read is load-bearing — it's what makes `status` re-derive each tick — so a
// cached computed only re-renders when the status actually changes. `now` is returned so callers
// can hang their own per-tick computeds (e.g. a countdown) off the same dependency.
export const useLiveItemStatus = (item: MaybeRefOrGetter<Item>) => {
  const now = useSharedNow()
  const status = computed(() => {
    void now.value
    return itemStatus(toValue(item))
  })
  return { now, status }
}
