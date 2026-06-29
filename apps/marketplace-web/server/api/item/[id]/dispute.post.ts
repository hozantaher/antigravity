import { disputeReasonError } from '~/models'
import { findDisputeEligibility, disputeExistsForInvoice, openDispute } from '~/server/repos/disputeRepo'

// Open a complaint against a completed sale. Earned, not given: only the buyer of a SETTLED sale may
// open a case, bound to that settled invoice, and only once. The case starts in 'open' and is moved
// by ops from there.
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'dispute-open', limit: 5, windowMs: 60_000, key: user.id })

  const body = await readBody(event).catch(() => ({}))
  const err = disputeReasonError(body?.reason)
  if (err) throw createError({ statusCode: err.status, statusMessage: err.message })

  const eligibility = await findDisputeEligibility(user.id, id)
  if (!eligibility) throw createError({ statusCode: 403, statusMessage: 'A dispute requires a completed purchase' })
  if (await disputeExistsForInvoice(eligibility.invoiceId)) {
    throw createError({ statusCode: 409, statusMessage: 'A case is already open for this sale' })
  }

  return openDispute({
    itemId: id,
    invoiceId: eligibility.invoiceId,
    openerId: user.id,
    reason: (body.reason as string).trim(),
  })
})
