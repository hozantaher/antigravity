import { disputeResolutionError } from '~/models'
import { resolveDispute } from '~/server/repos/disputeRepo'

// Ops: the documented decision. status → resolved with a justification + the resolving admin, only
// from a non-terminal state (the repo's WHERE status IN open/review). A decision is made once and not
// re-made. 404 when there is no resolvable case.
export default defineEventHandler(async event => {
  const admin = await requireAdmin(event)
  const id = getRouterParam(event, 'id')!
  const body = await readBody(event).catch(() => ({}))
  const err = disputeResolutionError(body?.resolution)
  if (err) throw createError({ statusCode: err.status, statusMessage: err.message })

  const resolved = await resolveDispute(id, admin.id, (body.resolution as string).trim())
  if (!resolved) throw createError({ statusCode: 404, statusMessage: 'Resolvable case not found' })
  return resolved
})
