import type { Notification, Paginated } from '~/models'

// Surfaces the (already complete) notifications backend in the FE: a shared list + unread count for
// the header bell, plus mark-read mutations. State is a useState singleton so the bell badge and the
// feed drawer read one source. SSR is anonymous, so the first fetch runs client-side once the bearer
// token attaches (parity with the reco rails / saved searches).
interface NotificationPage extends Paginated<Notification> {
  unread: number
}

const PAGE_SIZE = 20

export default function useNotifications() {
  const items = useState<Notification[]>('notifications:items', () => [])
  const total = useState<number>('notifications:total', () => 0)
  const page = useState<number>('notifications:page', () => 1)
  const unread = useState<number>('notifications:unread', () => 0)
  const loading = useState<boolean>('notifications:loading', () => false)
  const loaded = useState<boolean>('notifications:loaded', () => false)

  // p === 1 replaces the list (a poll/refresh); p > 1 appends (the feed's "load more").
  const fetchPage = async (p = 1): Promise<void> => {
    loading.value = true
    try {
      const res = await $fetch<NotificationPage>('/api/notifications', { query: { page: p, pageSize: PAGE_SIZE } })
      items.value = p > 1 ? [...items.value, ...res.items] : res.items
      total.value = res.total
      page.value = res.page
      unread.value = res.unread
      loaded.value = true
    } catch {
      // Best-effort: a failed poll must never throw an error toast over browsing. The badge keeps its
      // last value until the next refresh succeeds.
    } finally {
      loading.value = false
    }
  }

  const refresh = (): Promise<void> => fetchPage(1)
  const loadMore = (): Promise<void> => fetchPage(page.value + 1)
  const hasMore = computed((): boolean => items.value.length < total.value)

  // Optimistic: flip the row + drop the badge immediately, then persist. A failed call leaves the
  // server row unread and the next refresh reconciles — acceptable for a read flag.
  const markRead = async (id: string): Promise<void> => {
    const target = items.value.find(n => n.id === id)
    if (!target || target.readAt != null) return
    items.value = items.value.map(n => (n.id === id ? { ...n, readAt: Date.now() } : n))
    unread.value = Math.max(0, unread.value - 1)
    try {
      await $fetch(`/api/notifications/${id}/read`, { method: 'POST' })
    } catch {
      // next refresh reconciles
    }
  }

  const markAllRead = async (): Promise<void> => {
    if (unread.value === 0) return
    const now = Date.now()
    items.value = items.value.map(n => (n.readAt == null ? { ...n, readAt: now } : n))
    unread.value = 0
    try {
      await $fetch('/api/notifications/read-all', { method: 'POST' })
    } catch {
      // next refresh reconciles
    }
  }

  // Clears local state on sign-out so a re-login as another user never flashes the previous list.
  const reset = (): void => {
    items.value = []
    total.value = 0
    page.value = 1
    unread.value = 0
    loaded.value = false
  }

  return { items, total, unread, loading, loaded, hasMore, fetchPage, refresh, loadMore, markRead, markAllRead, reset }
}
