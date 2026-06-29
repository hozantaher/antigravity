import { QUESTION_ANSWER_MAX } from '~/models'
import type { QuestionStatus } from '~/models'
import { answerQuestion, setQuestionStatus } from '~/server/repos/questionRepo'
import { getById } from '~/server/repos/itemRepo'
import { notifyAnswer } from '~/server/utils/notify'

const STATUSES = new Set<QuestionStatus>(['pending', 'published', 'hidden'])

// Admin: answer a question (auto-publishes) or change its moderation status. The answering admin id
// comes from the session, never the request body. Body: { questionId, answer?, status? }. Scoped to
// the route item: the repo updates only when the question belongs to this item (404 otherwise), so a
// crafted questionId can't moderate a question on another listing (IDOR defense-in-depth).
export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  const itemId = getRouterParam(event, 'id')!
  const body = await readBody(event).catch(() => ({}))
  const questionId = typeof body?.questionId === 'string' ? body.questionId : ''
  if (!questionId) throw createError({ statusCode: 400, statusMessage: 'questionId is required' })

  if (typeof body?.answer === 'string') {
    const answer = body.answer.trim()
    if (!answer) throw createError({ statusCode: 400, statusMessage: 'Answer is required' })
    if (answer.length > QUESTION_ANSWER_MAX) throw createError({ statusCode: 400, statusMessage: 'Answer is too long' })
    const updated = await answerQuestion(questionId, itemId, admin.id, answer)
    if (!updated) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
    // Tell the asker in-app that their question now has an answer (best-effort; dedup'd per question).
    const item = await getById(itemId)
    await notifyAnswer(updated.id, updated.userId, itemId, item?.title ?? '')
    return updated
  }

  const status = body?.status as QuestionStatus | undefined
  if (!status || !STATUSES.has(status)) {
    throw createError({ statusCode: 400, statusMessage: 'A non-empty answer or a valid status is required' })
  }
  const updated = await setQuestionStatus(questionId, itemId, status)
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Question not found' })
  return updated
})
