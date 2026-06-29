import type { Bid, Paginated } from '~/models'

// Public bid history for an item. Owns the fetch (client-only, lazy — mirrors useItemQuestions) so
// the main detail content paints first and the history hydrates after. Real server-side pagination:
// the page ref drives a re-fetch (watch), not in-memory slicing — getPublicDetail no longer embeds
// the full history (only the last bid), so a long auction never bloats the detail payload. Newest
// first (the endpoint orders). The admin editor keeps its own in-memory pager over the full item.
export default function useItemBids(itemId: MaybeRefOrGetter<string | undefined>) {
  const page = ref(1)
  const pageSize = 20

  const { data, refresh } = useAsyncData(
    () => `bids:item:${toValue(itemId) ?? ''}`,
    () =>
      $fetch<Paginated<Bid>>(`/api/item/${toValue(itemId)}/bids`, {
        query: { page: page.value, pageSize },
      }),
    {
      server: false,
      lazy: true,
      watch: [page, () => toValue(itemId)],
      default: () => ({ items: [], total: 0, page: 1, pageSize }) as Paginated<Bid>,
    },
  )

  const bids = computed(() => data.value?.items ?? [])
  const total = computed(() => data.value?.total ?? 0)

  return { bids, total, page, pageSize, refresh }
}
