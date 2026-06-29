import { listAdminRatingsPage } from '~/server/repos/ratingRepo'

// Admin moderation list: every rating across all sellers (all statuses), newest first, paginated.
export default defineEventHandler(async event => {
  await requireAdmin(event)
  return listAdminRatingsPage(parsePageParams(event, { defaultPageSize: 20 }))
})
