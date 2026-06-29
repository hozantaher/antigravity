import { updateItem } from '~/server/repos/itemRepo'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event)
  const item = await updateItem(id, body ?? {})
  if (!item) throw createError({ statusCode: 404, statusMessage: 'Item not found' })
  return item
})
