import { listApiTokens } from '~/server/repos/apiTokenRepo'

export default defineEventHandler(async event => {
  await requireInteractiveAdmin(event)
  return listApiTokens(parsePageParams(event, { defaultPageSize: 20 }))
})
