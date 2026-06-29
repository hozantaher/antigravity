import { remove } from '~/server/repos/savedSearchRepo'

// Delete the caller's own saved search. Owner-scoped: the repo delete only matches the caller's row,
// so a cross-user (or already-gone) id removes nothing → 404. Returns 204 on success.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'saved-search-delete', limit: 30, windowMs: 60_000, key: user.id })

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing id' })

  const removed = await remove(id, user.id)
  if (!removed) throw createError({ statusCode: 404, statusMessage: 'Saved search not found' })
  setResponseStatus(event, 204)
  return null
})
