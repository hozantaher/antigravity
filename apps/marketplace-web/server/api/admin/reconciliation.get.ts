import { listUnmatchedFioPayments } from '~/server/repos/reconRepo'

// Reconciliation queue: Fio bank movements the cron could not match to an open invoice, paginated.
export default defineEventHandler(async event => {
  await requireAdmin(event)
  return listUnmatchedFioPayments(parsePageParams(event, { defaultPageSize: 20 }))
})
