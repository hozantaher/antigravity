import { UserRole } from '~/models'
import { getById, grantRole, revokeRole } from '~/server/repos/userRepo'
import { writeAudit } from '~/server/repos/auditRepo'
import { ipFromEvent } from '~/server/utils/rateLimit'

// Grant or revoke the admin role from the UI (replaces the CLI-only grant:admin). Guards against an
// admin revoking their own role (lock-out). requireInteractiveAdmin blocks API-token callers so a
// leaked token can't escalate accounts.
export default defineEventHandler(async event => {
  const admin = await requireInteractiveAdmin(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ grant?: boolean }>(event)
  const grant = body?.grant === true
  if (!grant && id === admin.id) {
    throw createError({ statusCode: 400, statusMessage: 'You cannot revoke your own admin role' })
  }

  const ok = grant ? await grantRole(id, UserRole.admin) : await revokeRole(id, UserRole.admin)
  if (!ok) throw createError({ statusCode: 404, statusMessage: 'User not found' })

  await writeAudit({
    actorId: admin.id,
    action: grant ? 'user.grantAdmin' : 'user.revokeAdmin',
    entity: 'user',
    entityId: id,
    ip: ipFromEvent(event),
  })
  return await getById(id)
})
