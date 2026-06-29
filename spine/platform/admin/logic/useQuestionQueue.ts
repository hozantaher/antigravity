import { useToast } from 'vue-toastification'
import type { Question, QuestionStatus } from '~/models'

// Cross-item Q&A moderation queue. Server-paginated over GET /api/admin/questions (omitting itemId
// returns every question across all listings) and mutated through the existing per-item answer
// endpoint, refreshing the page after each change. Distinct from useAdminQuestions, which is the
// editor's single-item, client-sliced variant.
export default function useQuestionQueue() {
  const {
    items: questions,
    total,
    loading,
    fetchPage,
    refresh,
  } = useAdminPagedResource<Question, { page: number; pageSize: number; q?: string }>(
    'admin:questionQueue',
    '/api/admin/questions',
  )

  const mutate = async (q: Question, body: { answer?: string; status?: QuestionStatus }) => {
    try {
      await $fetch(`/api/admin/item/${q.itemId}/question`, { method: 'POST', body: { questionId: q.id, ...body } })
      useToast().success('Saved')
      await refresh()
    } catch (e) {
      useToast().error(apiErrorMessage(e))
    }
  }

  const answer = (q: Question, text: string) => mutate(q, { answer: text })
  const setStatus = (q: Question, status: QuestionStatus) => mutate(q, { status })

  return { questions, total, loading, fetchPage, answer, setStatus, dispose: () => {} }
}
