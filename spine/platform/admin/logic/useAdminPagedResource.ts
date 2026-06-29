import type { Paginated } from '~/models'

export interface PagedParams {
  page: number
  pageSize: number
  q?: string
}

// Per-resource monotonic counter that drops stale responses from superseded page/search changes.
// Admin is client-only (routeRules ssr:false), so a module-level map is safe. Keyed so distinct
// resources don't share a counter — sharing one would let resource A's fetch invalidate B's response.
const seqs = new Map<string, number>()

// Shared list state + seq-guarded fetch for the admin data tables (items, users, API tokens).
// `key` namespaces the useState entries; `endpoint` is the paginated GET. Domain-specific
// mutations (delete, visibility, create…) wrap the returned `refresh` in the per-resource composable.
export const useAdminPagedResource = <T, P extends PagedParams>(key: string, endpoint: string) => {
  const items = useState<T[] | undefined>(`${key}:items`, () => undefined)
  const total = useState<number>(`${key}:total`, () => 0)
  const loading = useState<boolean>(`${key}:loading`, () => false)
  const last = useState<P | null>(`${key}:params`, () => null)
  const localePath = useLocalePath()

  const fetchPage = async (params: P) => {
    last.value = params
    const seq = (seqs.get(key) ?? 0) + 1
    seqs.set(key, seq)
    loading.value = true
    try {
      const res = await $fetch<Paginated<T>>(endpoint, { query: { ...params } })
      if (seq !== seqs.get(key)) return
      items.value = res.items
      total.value = res.total
    } catch (e) {
      if (seq !== seqs.get(key)) return
      // A failed admin fetch must never crash the page into a 500. A 401 means the session
      // isn't (or is no longer) an admin — bounce home like the route guard does instead of
      // letting the rejection bubble out of onBeforeMount; other errors degrade to an empty list.
      if ((e as { statusCode?: number })?.statusCode === 401) {
        await navigateTo(localePath('/'))
        return
      }
      items.value = []
      total.value = 0
      console.error(`[admin] failed to load ${endpoint}`, e)
    } finally {
      if (seq === seqs.get(key)) loading.value = false
    }
  }

  const refresh = () => (last.value ? fetchPage(last.value) : Promise.resolve())

  return { items, total, loading, last, fetchPage, refresh }
}
