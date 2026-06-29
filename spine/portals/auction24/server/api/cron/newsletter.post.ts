import { requireCronSecret } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { isRecoEnabled } from '../../utils/reco'
import { sendDueNewsletters } from '../../utils/newsletterBuilder'
import { withJobRun } from '../../repos/jobRunRepo'

// Sends the recommendations newsletter to due subscribers (§12). Google Cloud Scheduler
// triggers it every 2 days; per-user weekly due-gating lives in the builder, so runs stagger
// users naturally. ?dryRun=1 computes selection without claiming/sending. Shared-secret auth.
export default defineEventHandler(async event => {
  requireCronSecret(event)
  enforceRateLimit(event, { bucket: 'cron-newsletter', limit: 6, windowMs: 60_000, key: 'scheduler' })

  if (!isRecoEnabled()) return { skipped: 'reco-disabled' as const }
  const dryRun = getQuery(event).dryRun === '1'
  // A real send needs SendGrid; a dry run renders selection only, so it works without it.
  if (!dryRun && !process.env.SENDGRID_API_KEY) return { skipped: 'no-sendgrid' as const }

  return await withJobRun('newsletter', () => sendDueNewsletters({ dryRun }))
})
