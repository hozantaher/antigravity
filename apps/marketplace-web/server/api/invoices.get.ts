import { listForUserPage } from '~/server/repos/invoiceRepo'

export default defineEventHandler(async event => {
  const params = parsePageParams(event, { defaultPageSize: 10 })
  const user = await getSessionUser(event)
  if (!user) return { items: [], total: 0, page: params.page, pageSize: params.pageSize }
  return listForUserPage(user.id, params)
})
