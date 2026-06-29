import { reviewDispute } from '~/server/repos/disputeRepo'

// Ops: move an open case into review. The repo's WHERE status='open' enforces the state machine — a
// resolved case can't be dragged back. 404 when no open case matched.
export default defineEventHandler(async event => {
  await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const updated = await reviewDispute(id)
  if (!updated) throw createError({ statusCode: 404, statusMessage: 'Open case not found' })
  return updated
})
