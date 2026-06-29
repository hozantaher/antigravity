import { beforeEach, describe, expect, it, vi } from 'vitest'
import useAdminQuestions from '~/features/demand/messaging/logic/useAdminQuestions'
import type { Question } from '~/models'

const q = (over: Partial<Question> = {}): Question =>
  ({ id: 'q1', itemId: 'itm1', userId: 'u1', body: 'Hi?', status: 'pending', created: 0, ...over }) as Question

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the shared useState buckets between tests so state doesn't leak across cases.
  useAdminQuestions().dispose()
})

describe('useAdminQuestions', () => {
  // ADMINHOOK-1 — load() fetches the all-statuses admin list for one item (pageSize 100).
  it('loads the moderation list for an item', async () => {
    const f = vi.fn().mockResolvedValue({ items: [q(), q({ id: 'q2', status: 'hidden' })], total: 2 })
    vi.stubGlobal('$fetch', f)

    const api = useAdminQuestions()
    await api.load('itm1')

    expect(f).toHaveBeenCalledWith('/api/admin/questions', { query: { itemId: 'itm1', pageSize: 100 } })
    expect(api.questions.value.map(x => x.id)).toEqual(['q1', 'q2'])
    expect(api.loading.value).toBe(false)
  })

  // ADMINHOOK-2 — load(undefined) clears state and never hits the network.
  it('clears state and skips the fetch when no itemId', async () => {
    const f = vi.fn()
    vi.stubGlobal('$fetch', f)

    const api = useAdminQuestions()
    api.questions.value = [q()]
    await api.load(undefined)

    expect(f).not.toHaveBeenCalled()
    expect(api.questions.value).toEqual([])
  })

  // ADMINHOOK-3 — answerQuestion POSTs to the item-scoped admin endpoint and swaps the returned row.
  it('answers a question and replaces the row in local state', async () => {
    const answered = q({ status: 'published', answer: 'Yes.' })
    const f = vi.fn().mockResolvedValue(answered)
    vi.stubGlobal('$fetch', f)

    const api = useAdminQuestions()
    api.questions.value = [q()] // seeded so itemId can be resolved
    await api.answerQuestion('q1', 'Yes.')

    expect(f).toHaveBeenCalledWith('/api/admin/item/itm1/question', {
      method: 'POST',
      body: { questionId: 'q1', answer: 'Yes.' },
    })
    expect(api.questions.value[0]).toMatchObject({ status: 'published', answer: 'Yes.' })
  })

  // ADMINHOOK-4 — setQuestionStatus POSTs a status change and swaps the returned row.
  it('hides a question and replaces the row in local state', async () => {
    const hidden = q({ status: 'hidden' })
    const f = vi.fn().mockResolvedValue(hidden)
    vi.stubGlobal('$fetch', f)

    const api = useAdminQuestions()
    api.questions.value = [q({ status: 'published' })]
    await api.setQuestionStatus('q1', 'hidden')

    expect(f).toHaveBeenCalledWith('/api/admin/item/itm1/question', {
      method: 'POST',
      body: { questionId: 'q1', status: 'hidden' },
    })
    expect(api.questions.value[0]?.status).toBe('hidden')
  })

  // ADMINHOOK-5 — persisting a question not in local state is a no-op (no itemId to address).
  it('does not POST when the question id is not in local state', async () => {
    const f = vi.fn()
    vi.stubGlobal('$fetch', f)

    const api = useAdminQuestions()
    api.questions.value = [q({ id: 'q1' })]
    await api.setQuestionStatus('unknown', 'hidden')

    expect(f).not.toHaveBeenCalled()
  })

  // ADMINHOOK-6 — dispose clears the shared state.
  it('dispose empties the list', () => {
    const api = useAdminQuestions()
    api.questions.value = [q()]
    api.dispose()
    expect(api.questions.value).toEqual([])
  })
})
