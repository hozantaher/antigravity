import type { Paginated, Question, QuestionStatus } from '~/models'

// Admin Q&A moderation for the item editor's Questions tab. Loads every question for the current
// item (all statuses) and answers/publishes/hides them through the admin endpoint, swapping the
// returned row into local state — the in-memory-then-persist model the editor uses for bids.
export default function useAdminQuestions() {
  const questions = useState<Question[]>('admin:questions', () => [])
  const loading = useState('admin:questionsLoading', () => false)

  const load = async (itemId?: string) => {
    if (!itemId) {
      questions.value = []
      return
    }
    loading.value = true
    try {
      const page = await $fetch<Paginated<Question>>('/api/admin/questions', {
        query: { itemId, pageSize: 100 },
      })
      questions.value = page.items
    } finally {
      loading.value = false
    }
  }

  // Swap the updated row into local state (immutable replace) so the list reflects the change.
  const replace = (updated: Question) => {
    questions.value = questions.value.map(q => (q.id === updated.id ? updated : q))
  }

  const persist = async (body: { questionId: string; answer?: string; status?: QuestionStatus }) => {
    const itemId = questions.value.find(q => q.id === body.questionId)?.itemId
    if (!itemId) return
    const updated = await $fetch<Question>(`/api/admin/item/${itemId}/question`, { method: 'POST', body })
    replace(updated)
  }

  const answerQuestion = (questionId: string, answer: string) => persist({ questionId, answer })
  const setQuestionStatus = (questionId: string, status: QuestionStatus) => persist({ questionId, status })

  const dispose = () => {
    questions.value = []
  }

  return { questions, loading, load, answerQuestion, setQuestionStatus, dispose }
}
