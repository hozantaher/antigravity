import { listForUserPage } from '~/server/repos/invoiceRepo'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  return listForUserPage(id, parsePageParams(event, { defaultPageSize: 10 }))
})
