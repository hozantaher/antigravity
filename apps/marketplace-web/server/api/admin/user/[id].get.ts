import { getById } from '~/server/repos/userRepo'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const user = await getById(id)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'User not found' })
  return user
})
