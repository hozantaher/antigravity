import { listBidsPage } from '~/server/repos/itemRepo'

// Public: the item detail page shows bid history. Newest first, paginated.
export default defineEventHandler(event => {
  const id = getRouterParam(event, 'id')!
  return listBidsPage(id, parsePageParams(event, { defaultPageSize: 20 }))
})
