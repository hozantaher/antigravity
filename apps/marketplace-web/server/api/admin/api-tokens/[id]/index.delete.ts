import { deleteApiToken } from '~/server/repos/apiTokenRepo'

export default defineEventHandler(async event => {
  await requireInteractiveAdmin(event)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing token id' })
  const deleted = await deleteApiToken(id)
  if (!deleted) throw createError({ statusCode: 404, statusMessage: 'Token not found' })
  return { ok: true }
})
