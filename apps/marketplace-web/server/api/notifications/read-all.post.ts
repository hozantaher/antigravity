import { markAllRead } from '~/server/repos/notificationRepo'

// Mark every unread notification read for the session user; returns how many were flipped. Scoped to
// the user by markAllRead's WHERE user_id, so it can only clear the caller's own badge.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  const updated = await markAllRead(user.id)
  return { updated }
})
