import type { Bid } from '~/models'

// In-memory pagination of the item's embedded bid history. getById already returns every bid
// in the detail payload, so a separate /bids request would just re-download data we have. The
// admin editor paginates its in-memory bids the same way. Newest first.
export default function useItemBids(bidsSource: MaybeRefOrGetter<Bid[] | undefined>) {
  const page = ref(1)
  const pageSize = 10

  // Embedded bids are date-ascending; reverse so the newest bid is page 1, row 1.
  const ordered = computed(() => [...(toValue(bidsSource) ?? [])].reverse())
  const total = computed(() => ordered.value.length)
  const bids = computed(() => ordered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

  const refresh = () => {
    page.value = 1
  }

  return { bids, total, page, pageSize, refresh }
}
