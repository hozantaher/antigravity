import { toggleFavorite } from '~/server/repos/userRepo'

export default defineEventHandler(async event => {
  const user = await requireSession(event)
  const body = await readBody(event).catch(() => null)
  const id = body?.id
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing item id' })
  const favoriteIds = await toggleFavorite(user.id, id)
  return { favoriteIds }
})
