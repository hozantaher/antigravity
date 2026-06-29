import { requireCronSecret } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { buildRecommendations } from '../../utils/recommendation/build'
import { withJobRun } from '../../repos/jobRunRepo'

// Rebuilds the recommendation precompute (profiles, item features, popularity, attribute
// affinity). Google Cloud Scheduler triggers it ~every 10–15 min; the heavy profile/affinity
// pass self-gates hourly. Shared-secret auth, idempotent, crash-safe by window (no pointer).
export default defineEventHandler(async event => {
  requireCronSecret(event)
  enforceRateLimit(event, { bucket: 'cron-build-recommendations', limit: 6, windowMs: 60_000, key: 'scheduler' })
  return await withJobRun('build-recommendations', () => buildRecommendations())
})
