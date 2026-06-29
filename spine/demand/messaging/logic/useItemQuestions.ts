import type { Paginated, PublicQuestion } from '~/models'

// Public Q&A thread for an item. Owns the fetch (client-only, lazy — mirrors SimilarItems) so the
// main detail content paints first and the thread panel hydrates after. Real server-side pagination:
// the page ref drives a re-fetch (watch), not in-memory slicing. Newest first (the endpoint orders).
export default function useItemQuestions(itemId: MaybeRefOrGetter<string | undefined>) {
  const page = ref(1)
  const pageSize = 10

  const { data, refresh } = useAsyncData(
    () => `questions:item:${toValue(itemId) ?? ''}`,
    () =>
      $fetch<Paginated<PublicQuestion>>(`/api/item/${toValue(itemId)}/questions`, {
        query: { page: page.value, pageSize },
      }),
    {
      server: false,
      lazy: true,
      watch: [page, () => toValue(itemId)],
      default: () => ({ items: [], total: 0, page: 1, pageSize }) as Paginated<PublicQuestion>,
    },
  )

  const questions = computed(() => data.value?.items ?? [])
  const total = computed(() => data.value?.total ?? 0)

  return { questions, total, page, pageSize, refresh }
}
