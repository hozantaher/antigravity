import { useToast } from 'vue-toastification'
import type { Paginated, SavedSearch, SearchQuery } from '~/models'

// Manage the current user's saved searches: a paginated list plus create/delete/toggle mutations over
// the /api/saved-searches CRUD. State is shared via useState (the profile panel + the save button see
// one list), so mutations refresh once and every consumer updates. Mirrors useApiTokens' shape
// ({ items, total, loading, fetchPage, refresh, create, remove, toggleAlert, dispose }).
export default function useSavedSearches() {
  const { t } = useI18n()
  const toast = useToast()

  const items = useState<SavedSearch[]>('savedSearch:items', () => [])
  const total = useState<number>('savedSearch:total', () => 0)
  const page = useState<number>('savedSearch:page', () => 1)
  const loading = useState<boolean>('savedSearch:loading', () => false)
  const pageSize = 10

  const fetchPage = async (p = page.value): Promise<void> => {
    loading.value = true
    try {
      const res = await $fetch<Paginated<SavedSearch>>('/api/saved-searches', { query: { page: p, pageSize } })
      items.value = res.items
      total.value = res.total
      page.value = res.page
    } catch (e) {
      toast.error(apiErrorMessage(e))
    } finally {
      loading.value = false
    }
  }

  const refresh = (): Promise<void> => fetchPage(page.value)

  // Returns the created saved search (or null on failure) so a caller can react (e.g. close a dialog).
  const create = async (name: string, query: SearchQuery, alertEnabled = true): Promise<SavedSearch | null> => {
    try {
      const created = await $fetch<SavedSearch>('/api/saved-searches', {
        method: 'POST',
        body: { name, query, alertEnabled },
      })
      toast.success(t('savedSearch.created'))
      await refresh()
      return created
    } catch (e) {
      toast.error(apiErrorMessage(e))
      return null
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await $fetch(`/api/saved-searches/${id}`, { method: 'DELETE' })
      toast.success(t('savedSearch.removed'))
      await refresh()
    } catch (e) {
      toast.error(apiErrorMessage(e))
    }
  }

  const toggleAlert = async (id: string, alertEnabled: boolean): Promise<void> => {
    try {
      const updated = await $fetch<SavedSearch>(`/api/saved-searches/${id}`, {
        method: 'PATCH',
        body: { alertEnabled },
      })
      // Patch in place so the toggle reflects immediately without a full refetch.
      items.value = items.value.map(s => (s.id === id ? updated : s))
    } catch (e) {
      toast.error(apiErrorMessage(e))
    }
  }

  // Reset the shared useState buckets (used by tests to isolate cases; harmless in app teardown).
  const dispose = (): void => {
    items.value = []
    total.value = 0
    page.value = 1
    loading.value = false
  }

  return { items, total, page, pageSize, loading, fetchPage, refresh, create, remove, toggleAlert, dispose }
}
