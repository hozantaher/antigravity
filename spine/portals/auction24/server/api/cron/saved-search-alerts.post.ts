import { requireCronSecret } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { isRecoEnabled } from '../../utils/reco'
import { sendDueSavedSearchAlerts } from '../../utils/savedSearchAlerts'
import { withJobRun } from '../../repos/jobRunRepo'

// Emails owners of due saved searches their newest matching listings. Google Cloud Scheduler
// triggers it on a fixed cadence (e.g. daily); the per-search weekly due-gating in the orchestrator
// staggers sends naturally. ?dryRun=1 computes matches without claiming/sending. Shared-secret auth.
export default defineEventHandler(async event => {
  requireCronSecret(event)
  enforceRateLimit(event, { bucket: 'cron-saved-search', limit: 6, windowMs: 60_000, key: 'scheduler' })

  if (!isRecoEnabled()) return { skipped: 'reco-disabled' as const }
  const dryRun = getQuery(event).dryRun === '1'
  // A real send needs SendGrid; a dry run computes matches only, so it works without it.
  if (!dryRun && !process.env.SENDGRID_API_KEY) return { skipped: 'no-sendgrid' as const }

  return await withJobRun('saved-search-alerts', () => sendDueSavedSearchAlerts({ dryRun }))
})
