import { questionInputError } from '~/models'
import type { Item, Question } from '~/models'
import { COMPANY } from '~/utils/company'
import { createQuestion } from '~/server/repos/questionRepo'
import { getById } from '~/server/repos/itemRepo'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { buildContactNotification } from '~/server/email/internal'
import { captureServerError } from '~/server/utils/observability'

// Best-effort: the question is already persisted, so an ops-notification failure (no recipient,
// Redis/SendGrid down) must never fail the request — it's logged and swallowed. Mirrors
// contact.post's notifyOps. Uses the question-specific template (no empty name/e-mail/phone rows).
const notifyOps = async (question: Question, item: Item): Promise<void> => {
  const config = useRuntimeConfig()
  const recipient = config.contactNotifyEmail || COMPANY.email
  if (!recipient) return
  try {
    const rendered = await buildContactNotification({
      kind: 'question',
      message: question.body,
      itemTitle: item.title,
      itemUrl: `${config.public.baseUrl}/item/${item.id}`,
    })
    await enqueueEmail({ recipient, rendered, label: 'question:new' }, { dedupKey: `question:${question.id}` })
  } catch (e) {
    captureServerError(e, { area: 'question.notify', tags: { id: question.id } })
  }
}

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const user = await requireSession(event)
  // Keyed on user.id (not IP): a signed-in user shouldn't be able to flood the public Q&A surface.
  enforceRateLimit(event, { bucket: 'question', limit: 10, windowMs: 60_000, key: user.id })

  const body = await readBody(event).catch(() => ({}))
  const err = questionInputError(body?.body)
  if (err) throw createError({ statusCode: err.status, statusMessage: err.message })

  const item = await getById(id)
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Item not found' })

  // userId comes from the session, never the client body.
  const saved = await createQuestion({ itemId: id, userId: user.id, body: (body.body as string).trim() })
  await notifyOps(saved, item)
  return { ok: true, id: saved.id }
})
