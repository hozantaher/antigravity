import { getById, softDeleteUser } from '~/server/repos/userRepo'
import { writeAudit } from '~/server/repos/auditRepo'
import { getAuthAdmin } from '~/server/utils/firebase'
import { ipFromEvent } from '~/server/utils/rateLimit'
import { captureServerError } from '~/server/utils/observability'

// Hard admin action: anonymize + soft-delete the DB row, then best-effort remove the Firebase
// identity. requireInteractiveAdmin blocks API-token callers; a Firebase outage must not leave the
// row un-anonymized, so the DB delete is durable and the Firebase delete is best-effort.
export default defineEventHandler(async event => {
  const admin = await requireInteractiveAdmin(event)
  const id = getRouterParam(event, 'id')!
  if (id === admin.id) throw createError({ statusCode: 400, statusMessage: 'You cannot delete your own account' })
  const before = await getById(id)
  if (!before) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  await softDeleteUser(id)
  try {
    await getAuthAdmin().deleteUser(id)
  } catch (e) {
    captureServerError(e, { area: 'user.delete.firebase', tags: { id } })
  }

  await writeAudit({
    actorId: admin.id,
    action: 'user.delete',
    entity: 'user',
    entityId: id,
    before: { email: before.email, fullName: before.fullName },
    ip: ipFromEvent(event),
  })
  return { ok: true }
})
