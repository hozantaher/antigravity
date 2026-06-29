import { listForUser, unreadCount } from '~/server/repos/notificationRepo'

// The session user's in-app notifications (newest first, paginated) plus the unread count for the
// badge. SSR is anonymous, so this resolves client-side once the bearer token is attached.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  const [page, unread] = await Promise.all([
    listForUser(user.id, parsePageParams(event, { defaultPageSize: 20 })),
    unreadCount(user.id),
  ])
  return { ...page, unread }
})
