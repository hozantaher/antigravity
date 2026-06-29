import { listContactMessagesPage } from '~/server/repos/contactRepo'

export default defineEventHandler(async event => {
  await requireAdmin(event)
  return listContactMessagesPage(parsePageParams(event, { defaultPageSize: 20 }))
})
