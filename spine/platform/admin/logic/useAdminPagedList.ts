import type { WatchSource } from 'vue'

export interface AdminPageContext {
  page: number
  pageSize: number
  q: string | undefined
}

export interface AdminPagedListOptions {
  // Fetch one page; receives the current page, pageSize, and debounced search term.
  fetch: (ctx: AdminPageContext) => void | Promise<void>
  // Extra reactive filters (besides search) that reset paging back to page 1.
  filters?: WatchSource[]
  dispose?: () => void
  pageSize?: number
}

// Shared wiring for the admin data tables: owns the page ref, the debounced search
// term, and the fetch-on-change lifecycle so each page only declares its own filters.
export const useAdminPagedList = (options: AdminPagedListOptions) => {
  const { fetch, filters = [], dispose, pageSize = 20 } = options
  const page = ref(1)
  const { search } = useAdminSearch()
  const debouncedSearch = refDebounced(search, 400)

  const run = () => fetch({ page: page.value, pageSize, q: debouncedSearch.value || undefined })

  watch(page, run)
  // A new search term or filter restarts at page 1 (which fetches via the page
  // watcher); when already on page 1, fetch directly.
  watch([debouncedSearch, ...filters], () => {
    if (page.value !== 1) page.value = 1
    else run()
  })

  onBeforeMount(run)
  if (dispose) onUnmounted(dispose)

  return { page, pageSize }
}
