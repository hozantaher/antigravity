import { normalizeSavedSearchQuery, savedSearchFilterCount } from '~/models'
import type { SearchQuery } from '~/models'

// Powers a "Save this search" button on the listing/search page: reads the current SearchQuery (the
// same shape useSearchFilters builds) and persists it via useSavedSearches().create. Normalizes the
// query so only the meaningful facets/term are stored (pagination is never part of SearchQuery).
export default function useSaveCurrentSearch(querySource: MaybeRefOrGetter<SearchQuery>) {
  const { create } = useSavedSearches()

  // The clean query to persist (empty/blank facets elided), and whether it carries anything.
  const query = computed<SearchQuery>(() => normalizeSavedSearchQuery(toValue(querySource)))
  const filterCount = computed(() => savedSearchFilterCount(query.value))
  const canSave = computed(() => filterCount.value > 0)

  const saveCurrent = (name: string) => create(name, query.value)

  return { query, filterCount, canSave, saveCurrent }
}
