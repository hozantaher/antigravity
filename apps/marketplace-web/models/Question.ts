// A public question on a listing, plus its optional admin answer. Dates are epoch-ms numbers and
// the asker is always a signed-in user (the FE/admin contract). Moderated: a question is hidden
// from the public until an admin publishes it (answering auto-publishes). See features/messaging.
export type QuestionStatus = 'pending' | 'published' | 'hidden'

export interface Question {
  id: string
  itemId: string
  userId: string
  body: string
  answer?: string
  answeredBy?: string
  status: QuestionStatus
  created: number // epoch millis
  answeredAt?: number // epoch millis
}

// Repo input — flat (mirrors the columns), built by the ask endpoint after validation. The
// asker (userId) comes from the session, never the client body.
export interface NewQuestion {
  itemId: string
  userId: string
  body: string
}

// Public projection of a question: the subset the public thread is allowed to see. The asker's
// userId and the answering admin's id (answeredBy) are intentionally dropped so a public read can
// never leak who asked or who answered. Admin endpoints keep the full Question.
export interface PublicQuestion {
  id: string
  itemId: string
  body: string
  answer?: string
  status: QuestionStatus
  created: number
  answeredAt?: number
}

export const toPublicQuestion = (q: Question): PublicQuestion => ({
  id: q.id,
  itemId: q.itemId,
  body: q.body,
  answer: q.answer,
  status: q.status,
  created: q.created,
  answeredAt: q.answeredAt,
})

// Max question/answer lengths (storage bound / anti-abuse). Over-limit input is a 400 at the
// endpoint, never silently truncated — same policy as the contact form.
export const QUESTION_BODY_MAX = 2000
export const QUESTION_ANSWER_MAX = 5000

// A question is visible to the public only once published (answering auto-publishes). Pure so it
// can be unit-tested and shared by the repo's published-only reads and the FE.
export const isQuestionVisible = (q: Pick<Question, 'status'>): boolean => q.status === 'published'

// Validate a question body: trim, reject empty, reject over-length. Pure (no DB) so it can be
// unit-tested. Returns null when the body is OK. Mirrors contact.post's text() policy as a 400.
export const questionInputError = (body: unknown): { status: number; message: string } | null => {
  if (typeof body !== 'string') return { status: 400, message: 'Question body is required' }
  const trimmed = body.trim()
  if (!trimmed) return { status: 400, message: 'Question body is required' }
  if (trimmed.length > QUESTION_BODY_MAX) return { status: 400, message: 'Question is too long' }
  return null
}
