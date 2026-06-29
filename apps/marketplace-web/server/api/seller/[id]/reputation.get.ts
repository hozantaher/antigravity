import { sellerReputation } from '~/server/repos/ratingRepo'

// Public aggregated reputation for a seller (average + count), surfaced on the seller and their
// vehicle cards. Empty → average null, count 0 (no reputation yet), never a fake zero score.
export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  enforceRateLimit(event, { bucket: 'seller-reputation', limit: 200, windowMs: 60_000 })
  return sellerReputation(id)
})
