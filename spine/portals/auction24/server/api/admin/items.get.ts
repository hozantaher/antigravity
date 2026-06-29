import { listAdminItemsPage } from '~/server/repos/itemRepo'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const q = getQuery(event)
  const visibility = q.visibility === 'hidden' || q.visibility === 'all' ? q.visibility : 'visible'
  return listAdminItemsPage(
    { q: typeof q.q === 'string' ? q.q : undefined, visibility },
    parsePageParams(event, { defaultPageSize: 20 }),
  )
})
