import type { SearchQuery, SearchSort } from '~/models'
import { isDefaultSearchSort, parseSearchQuery, parseSearchSort, searchQueryToRecord } from '~/models'

// Facet keys the composable mutates (everything in SearchQuery except `q`, which on the search
// route is the path param, not a facet control).
type Facet = Exclude<keyof SearchQuery, 'q'>

interface UseSearchFiltersOptions {
  // The free-text term, owned by the route (/search/:q). Reactive so a new term re-seeds.
  q?: MaybeRefOrGetter<string | undefined>
}

const FACET_KEYS: Facet[] = [
  'type',
  'categoryId',
  'priceMin',
  'priceMax',
  'fuelType',
  'bodyType',
  'transmission',
  'driveType',
  'color',
  'yearFrom',
  'yearTo',
]

// Client facet state for search. Shared via useState so the two consumers (<SearchFilters> controls,
// <SearchResults> fetch) bind the SAME facets — they call useSearchFilters independently. Seeds once
// from the URL query string (SSR-safe) and mirrors changes back to the URL (router.replace) so a
// faceted search is shareable and back-button-safe. The pure shape lives in models/SearchQuery so it
// stays serializable for a future saved-search domain. The term `q` is the route path param, folded
// into the derived query() record; page-1-reset on a facet change rides usePagedItems' filter watch.
export default function useSearchFilters(options: UseSearchFiltersOptions = {}) {
  const route = useRoute()
  const router = useRouter()

  // Seed from the URL once (ignore q/page — q is the path param, page is usePagedItems').
  const facets = useState<SearchQuery>('search:facets', () => parseSearchQuery(route.query as Record<string, unknown>))

  // Result order. Separate from facets (presentation, not "what matches") and shared via useState so
  // the control and the fetch agree. Seeded from ?sort (lenient — junk falls back to 'relevance').
  const sort = useState<SearchSort>('search:sort', () => parseSearchSort(route.query.sort))
  const setSort = (value: SearchSort): void => {
    sort.value = parseSearchSort(value)
  }

  const setFacet = <K extends Facet>(key: K, value: SearchQuery[K] | undefined): void => {
    // Immutable update; an undefined/empty value clears the facet.
    const next: SearchQuery = { ...facets.value }
    if (value === undefined || value === null || (value as unknown) === '') delete next[key]
    else next[key] = value
    facets.value = parseSearchQuery(searchQueryToRecord(next))
  }

  const clearFacet = (key: Facet): void => setFacet(key, undefined)

  const reset = (): void => {
    facets.value = {}
  }

  // The free-text term as a clean SearchQuery fragment.
  const term = computed<SearchQuery>(() => {
    const q = String(toValue(options.q) ?? '').trim()
    return q ? { q } : {}
  })

  // Full query (term + facets). `query` is the flat record usePagedItems consumes (term + facets +
  // sort). A default sort is elided so a sort-free search hits /api/search with no ?sort and gets
  // the shared listing order — only an explicit choice adds the param.
  const searchQuery = computed<SearchQuery>(() => ({ ...term.value, ...facets.value }))
  const query = computed<Record<string, string>>(() => {
    const record = searchQueryToRecord(searchQuery.value)
    return isDefaultSearchSort(sort.value) ? record : { ...record, sort: sort.value }
  })

  // Mirror the facets + sort into the URL query string (client-only), preserving non-facet keys
  // (e.g. ?page, which usePagedItems owns) so a faceted, ordered search is shareable and
  // back-button-safe. A default sort drops ?sort entirely (clean URL = listing order).
  if (import.meta.client) {
    watch(
      [() => searchQueryToRecord(facets.value), () => sort.value],
      ([record, currentSort]) => {
        const preserved = { ...route.query }
        for (const key of FACET_KEYS) delete preserved[key]
        delete preserved.sort
        const sortParam = isDefaultSearchSort(currentSort) ? {} : { sort: currentSort }
        router.replace({ query: { ...preserved, ...record, ...sortParam } })
      },
      { deep: true },
    )
  }

  return { facets, sort, searchQuery, query, setFacet, clearFacet, reset, setSort }
}
