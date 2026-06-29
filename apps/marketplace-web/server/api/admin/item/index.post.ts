import { createItem } from '~/server/repos/itemRepo'

export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  const body = await readBody(event)
  return createItem(body ?? {}, admin.id)
})
