import type { NewQuestion, Paginated, Question, QuestionStatus } from '~/models'
import { db } from '../utils/db'
import { questionToInsert, rowToQuestion } from './mappers'
import { paginate, type PageParams } from '../utils/pagination'

// New questions land as 'pending' (hidden) — moderated before they reach the public listing.
export const createQuestion = async (input: NewQuestion): Promise<Question> => {
  const row = await db
    .insertInto('itemQuestions')
    .values(questionToInsert(input))
    .returningAll()
    .executeTakeFirstOrThrow()
  return rowToQuestion(row)
}

// Answer a question: store the answer, stamp the answering admin + time, and auto-publish. The
// admin id comes from the session, never the request body. Scoped to itemId (defense-in-depth: the
// question must belong to the route item, so a crafted questionId can't reach across listings).
// Returns the updated Question, or undefined when no matching row was updated.
export const answerQuestion = async (
  questionId: string,
  itemId: string,
  answeredBy: string,
  answer: string,
): Promise<Question | undefined> => {
  // questionId is compared to a bigint PK; a non-numeric id (e.g. a crafted request body) would
  // throw a bigint cast error instead of a clean miss — guard so it resolves to undefined → 404.
  if (!/^\d+$/.test(questionId)) return undefined
  const row = await db
    .updateTable('itemQuestions')
    .set({ answer, answeredBy, answeredAt: new Date(), status: 'published' })
    .where('id', '=', questionId)
    .where('itemId', '=', itemId)
    .returningAll()
    .executeTakeFirst()
  return row ? rowToQuestion(row) : undefined
}

// Publish or hide a question without answering it (moderation). Scoped to itemId (defense-in-depth,
// same as answerQuestion). Returns the updated Question, or undefined when no matching row was
// updated.
export const setQuestionStatus = async (
  questionId: string,
  itemId: string,
  status: QuestionStatus,
): Promise<Question | undefined> => {
  if (!/^\d+$/.test(questionId)) return undefined
  const row = await db
    .updateTable('itemQuestions')
    .set({ status })
    .where('id', '=', questionId)
    .where('itemId', '=', itemId)
    .returningAll()
    .executeTakeFirst()
  return row ? rowToQuestion(row) : undefined
}

// Public thread: published questions for an item, newest first, paginated.
export const listQuestionsPage = (itemId: string, params: PageParams): Promise<Paginated<Question>> =>
  paginate(
    db.selectFrom('itemQuestions').where('itemId', '=', itemId).where('status', '=', 'published'),
    qb => qb.orderBy('created', 'desc').orderBy('id', 'desc'),
    rows => rows.map(rowToQuestion),
    params,
  )

// Admin moderation queue: every question (all statuses), newest first, paginated. Optionally
// scoped to one item (the editor's Questions tab moderates a single listing).
export const listAdminQuestionsPage = (
  params: PageParams,
  filter: { itemId?: string } = {},
): Promise<Paginated<Question>> =>
  paginate(
    filter.itemId ? db.selectFrom('itemQuestions').where('itemId', '=', filter.itemId) : db.selectFrom('itemQuestions'),
    qb => qb.orderBy('created', 'desc').orderBy('id', 'desc'),
    rows => rows.map(rowToQuestion),
    params,
  )
