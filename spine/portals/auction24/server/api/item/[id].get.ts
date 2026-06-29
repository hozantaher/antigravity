import { UserRole } from '~/models'
import { getPublicDetail } from '~/server/repos/itemRepo'
import { getSessionUser } from '~/server/utils/session'

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  // Slim detail: every field but only the last bid + bidCount. The bid history is paginated
  // separately via /api/item/:id/bids; the admin editor uses /api/admin/item/:id (full bids).
  const item = await getPublicDetail(id)
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Item not found' })
  // Hidden items are unpublished drafts. An admin may still preview a draft on the public page,
  // so don't 401 outright — but an anonymous/non-admin caller must not be able to read a draft
  // (VIN, photos, pricing, internalId) by guessing its id. Return 404.
  if (item.hidden) {
    const user = await getSessionUser(event)
    if (!user?.roles.includes(UserRole.admin)) throw createError({ statusCode: 404, statusMessage: 'Item not found' })
  }
  return item
})
