import { getById, removeItem } from '~/server/repos/itemRepo'
import { writeAudit } from '~/server/repos/auditRepo'
import { ipFromEvent } from '~/server/utils/rateLimit'

export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  // Snapshot before delete so the audit trail keeps a record of what was removed.
  const before = await getById(id)
  await removeItem(id)
  await writeAudit({
    actorId: admin.id,
    action: 'item.delete',
    entity: 'item',
    entityId: id,
    before: before ? { title: before.title, internalId: before.internalId, userId: before.userId } : null,
    ip: ipFromEvent(event),
  })
  return { ok: true }
})
