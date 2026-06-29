import { markRead } from '~/server/repos/notificationRepo'

// Mark one notification read, scoped to the session user (a crafted id can't read-flag another user's
// row — markRead's WHERE user_id is the guard). 404 when no row matched.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  const id = getRouterParam(event, 'id')!
  const updated = await markRead(id, user.id)
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Notification not found' })
  return updated
})
