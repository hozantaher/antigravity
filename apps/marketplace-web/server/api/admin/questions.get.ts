import { listAdminQuestionsPage } from '~/server/repos/questionRepo'

// Admin moderation list: every question across all statuses, newest first, paginated. Optional
// ?itemId scopes the list to a single listing (the editor's Questions tab).
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const { itemId } = getQuery(event)
  const itemIdParam = typeof itemId === 'string' ? itemId : undefined
  return listAdminQuestionsPage(parsePageParams(event, { defaultPageSize: 20 }), { itemId: itemIdParam })
})
