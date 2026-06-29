import { listAdminUsersPage } from '~/server/repos/userRepo'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const q = getQuery(event)
  return listAdminUsersPage(
    { q: typeof q.q === 'string' ? q.q : undefined },
    parsePageParams(event, { defaultPageSize: 20 }),
  )
})
