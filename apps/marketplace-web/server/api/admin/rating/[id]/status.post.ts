import { setRatingStatus, type RatingStatus } from '~/server/repos/ratingRepo'
import { writeAudit } from '~/server/repos/auditRepo'
import { ipFromEvent } from '~/server/utils/rateLimit'

// Hide or unhide a rating (moderation). Hidden ratings drop out of seller reputation; the row is
// kept (no delete) so the audit trail and the UNIQUE(invoice_id) anti-refake guard stay intact.
export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody<{ status?: string }>(event)
  const status = body?.status
  if (status !== 'visible' && status !== 'hidden') {
    throw createError({ statusCode: 422, statusMessage: 'status must be "visible" or "hidden"' })
  }
  const updated = await setRatingStatus(id, status as RatingStatus)
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Rating not found' })
  await writeAudit({
    actorId: admin.id,
    action: `rating.${status}`,
    entity: 'rating',
    entityId: id,
    after: { status },
    ip: ipFromEvent(event),
  })
  return updated
})
