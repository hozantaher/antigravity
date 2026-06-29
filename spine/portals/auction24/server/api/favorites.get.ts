import { listFavoritesPage } from '~/server/repos/itemRepo'

export default defineEventHandler(async event => {
  const params = parsePageParams(event)
  const user = await getSessionUser(event)
  if (!user) return { items: [], total: 0, page: params.page, pageSize: params.pageSize }
  return listFavoritesPage(user.favoriteIds, params)
})
