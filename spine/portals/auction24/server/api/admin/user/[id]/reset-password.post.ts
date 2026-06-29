import { getById } from '~/server/repos/userRepo'
import { writeAudit } from '~/server/repos/auditRepo'
import { getAuthAdmin } from '~/server/utils/firebase'
import { enqueueEmail } from '~/server/utils/emailQueue'
import { ipFromEvent } from '~/server/utils/rateLimit'

// Admin-triggered password reset: generate a Firebase reset link and email it via the existing
// localized 'resetPassword' template. The link is the durable part; delivery rides the email queue.
export default defineEventHandler(async event => {
  const admin = await requireInteractiveAdmin(event)
  const id = getRouterParam(event, 'id')!
  const user = await getById(id)
  if (!user || !user.email) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  const resetUrl = await getAuthAdmin().generatePasswordResetLink(user.email)
  await enqueueEmail({
    recipient: user.email,
    templateKey: 'resetPassword',
    language: user.language?.code ?? 'cz',
    params: { resetUrl },
  })

  await writeAudit({
    actorId: admin.id,
    action: 'user.resetPassword',
    entity: 'user',
    entityId: id,
    ip: ipFromEvent(event),
  })
  return { ok: true }
})
