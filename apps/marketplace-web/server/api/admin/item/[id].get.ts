import { getById } from '~/server/repos/itemRepo'

// Admin item-editor load: the full item including the complete bid history (the editor paginates
// bids in-memory) and hidden drafts. requireAdmin gates it, unlike the slim public /api/item/:id.
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const item = await getById(id)
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Item not found' })
  return item
})
