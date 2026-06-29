import type { Item, Paginated } from '~/models'

type QueryRecord = Record<string, string | number | boolean | undefined>

interface PagedItemsOptions {
  endpoint: string
  // Reactive filter (search term, category, type…) — excludes page/pageSize.
  query?: () => QueryRecord
  pageSize?: number
  // SSR fetch (public pages). Set false for authed lists (token is client-only).
  server?: boolean
  // Mirror the current page into ?page= (router.replace) for deep-linking / shareable URLs.
  syncUrl?: boolean
  key?: string
}

// Server-side paged item lists. Pairs with <ItemsListing> / <BasePagination>.
export default function usePagedItems(options: PagedItemsOptions) {
  const { endpoint, pageSize = 24, server = true, syncUrl = true } = options
  const route = useRoute()
  const router = useRouter()

  const page = ref(syncUrl ? Math.max(1, Number(route.query.page) || 1) : 1)

  const filter = computed<QueryRecord>(() => {
    const raw = options.query?.() ?? {}
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''))
  })

  // A new filter (search term, category) restarts at page 1.
  watch(filter, () => {
    page.value = 1
  })

  if (syncUrl) {
    watch(page, p => {
      if (!import.meta.client) return
      const query = { ...route.query }
      if (p <= 1) delete query.page
      else query.page = String(p)
      router.replace({ query })
    })
  }

  // Param-driven pages (search/[q], category/[id]) remount on each navigation; a static
  // key makes the remounted component rebind to the first query's already-resolved
  // asyncData and skip refetching. Fold the filter in so each distinct query is its own
  // entry. Page stays out of the key — pagination still rides the watch below.
  const fetchKey = computed(() => `${options.key ?? endpoint}:${JSON.stringify(filter.value)}`)

  const { data, pending, error, refresh } = useFetch<Paginated<Item>>(endpoint, {
    key: fetchKey,
    server,
    query: computed(() => ({ ...filter.value, page: page.value, pageSize })),
    watch: [filter, page],
  })

  // Clamp an out-of-range page back into bounds (client-side). A stale deep link (?page=9 on a
  // 1-page list) or a list that shrank in place (unfavorite/delete the last row on the last
  // page) would otherwise render empty with the pager hidden, stranding the user.
  const nuxtApp = useNuxtApp()
  watch(
    () => data.value?.total,
    total => {
      if (!import.meta.client || total == null) return
      const pageCount = Math.max(1, Math.ceil(total / pageSize))
      if (page.value <= pageCount) return
      page.value = pageCount
      // On a full-page load the page-change refetch is served the stale out-of-range payload
      // from the hydration cache, so the clamped page renders empty — force a fetch once hydrated.
      if (nuxtApp.isHydrating) onNuxtReady(() => refresh())
    },
    { immediate: true },
  )

  return {
    items: computed(() => data.value?.items),
    total: computed(() => data.value?.total ?? 0),
    page,
    pageSize,
    pending,
    error,
    refresh,
  }
}
