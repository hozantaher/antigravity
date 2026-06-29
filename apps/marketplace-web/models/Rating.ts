// A buyer's rating of a seller, earned by a completed (settled) sale. One paid sale invoice → at
// most one rating (the invoiceId carries the uniqueness), so reputation can't be faked by anyone
// who never bought. Dates are epoch-ms numbers (the FE/mapper contract). See features/ratings-reviews.
export interface Rating {
  id: string
  itemId: string
  sellerId: string
  raterId: string
  invoiceId: string
  score: number // 1..5
  comment?: string
  created: number // epoch millis
}

// Repo input — the rater + the settled invoice come from the server (session + eligibility check),
// never from the client body. Only score + optional comment are user-supplied.
export interface NewRating {
  itemId: string
  sellerId: string
  raterId: string
  invoiceId: string
  score: number
  comment?: string
}

export const RATING_MIN = 1
export const RATING_MAX = 5
export const RATING_COMMENT_MAX = 2000

// Validate a submitted score + comment. Pure (no DB) so the endpoint and any client form share one
// rule. Returns null when OK, else a {status,message} the endpoint throws as a 4xx. Score must be an
// integer 1..5; over-length comment is rejected, never truncated (parity with the question form).
export const ratingInputError = (score: unknown, comment?: unknown): { status: number; message: string } | null => {
  if (typeof score !== 'number' || !Number.isInteger(score) || score < RATING_MIN || score > RATING_MAX) {
    return { status: 422, message: `Score must be an integer ${RATING_MIN}–${RATING_MAX}` }
  }
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== 'string') return { status: 422, message: 'Comment must be text' }
    if (comment.trim().length > RATING_COMMENT_MAX) return { status: 422, message: 'Comment is too long' }
  }
  return null
}

// Aggregated seller reputation — what the seller card and their vehicles show. Count is the number of
// ratings; average is rounded to one decimal (display-ready) or null when there are no ratings yet.
export interface SellerReputation {
  sellerId: string
  count: number
  average: number | null
}

// Single source of truth for reputation rounding/empty-handling: average to one decimal,
// null (not a misleading 0) when there are no ratings. Shared by aggregateReputation (FE/tests)
// and the SQL path in ratingRepo, so the repo computes count/avg in Postgres without pulling rows.
export const reputationFromStats = (sellerId: string, count: number, average: number | null): SellerReputation =>
  count === 0 || average === null
    ? { sellerId, count: 0, average: null }
    : { sellerId, count, average: Math.round(average * 10) / 10 }

// Aggregate raw scores into a reputation. Pure so it's unit-testable and shared by the repo's
// projection and the FE. Empty → average null (no reputation yet), never a misleading 0.
export const aggregateReputation = (sellerId: string, scores: readonly number[]): SellerReputation => {
  if (scores.length === 0) return { sellerId, count: 0, average: null }
  const sum = scores.reduce((a, s) => a + s, 0)
  return reputationFromStats(sellerId, scores.length, sum / scores.length)
}
