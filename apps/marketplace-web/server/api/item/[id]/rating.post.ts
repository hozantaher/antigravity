import { ratingInputError } from '~/models'
import { findRatingEligibility, ratingExistsForInvoice, createRating } from '~/server/repos/ratingRepo'

// Post a seller rating for a listing. Earned, not given: only the buyer of a SETTLED sale may rate,
// and only once (the settled invoice is the uniqueness key). Score + optional comment come from the
// body; the rater, seller and invoice are all server-derived from the settled sale.
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const user = await requireSession(event)
  enforceRateLimit(event, { bucket: 'item-rating', limit: 10, windowMs: 60_000, key: user.id })

  const body = await readBody(event).catch(() => ({}))
  const err = ratingInputError(body?.score, body?.comment)
  if (err) throw createError({ statusCode: err.status, statusMessage: err.message })

  const eligibility = await findRatingEligibility(user.id, id)
  if (!eligibility) throw createError({ statusCode: 403, statusMessage: 'Rating requires a completed purchase' })
  if (await ratingExistsForInvoice(eligibility.invoiceId)) {
    throw createError({ statusCode: 409, statusMessage: 'This sale is already rated' })
  }

  try {
    return await createRating({
      itemId: id,
      sellerId: eligibility.sellerId,
      raterId: user.id,
      invoiceId: eligibility.invoiceId,
      score: body.score as number,
      comment: typeof body?.comment === 'string' ? body.comment.trim() : undefined,
    })
  } catch (e: unknown) {
    // Race-loser of a concurrent double-submit: UNIQUE(invoice_id) fired. Same 409 as the pre-check.
    if ((e as { code?: string }).code === '23505') {
      throw createError({ statusCode: 409, statusMessage: 'This sale is already rated' })
    }
    throw e
  }
})
