import { useToast } from 'vue-toastification'
import type { Rating } from '~/models'

export type AdminRating = Rating & { status: 'visible' | 'hidden' }

// Admin ratings moderation list + hide/restore. Hiding excludes a rating from seller reputation
// (server-side); the row is kept, so the action is reversible.
export default function useRatingList() {
  const {
    items: ratings,
    total,
    loading,
    fetchPage,
    refresh,
  } = useAdminPagedResource<AdminRating, { page: number; pageSize: number; q?: string }>(
    'admin:ratingList',
    '/api/admin/ratings',
  )

  const setStatus = async (rating: AdminRating, status: 'visible' | 'hidden') => {
    try {
      await $fetch(`/api/admin/rating/${rating.id}/status`, { method: 'POST', body: { status } })
      useToast().success(status === 'hidden' ? 'Rating hidden' : 'Rating restored')
      await refresh()
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  return { ratings, total, loading, fetchPage, setStatus, dispose: () => {} }
}
