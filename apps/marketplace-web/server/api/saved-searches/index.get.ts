import { listForUser } from '~/server/repos/savedSearchRepo'

// List the current user's saved searches, newest first, paginated. Session-scoped.
export default defineEventHandler(async event => {
  const user = await requireSession(event)
  return listForUser(user.id, parsePageParams(event))
})
