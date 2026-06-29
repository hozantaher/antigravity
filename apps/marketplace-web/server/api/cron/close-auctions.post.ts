import { requireCronSecret } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { closeEndedAuctions } from '../../utils/auctionCloser'
import { withJobRun } from '../../repos/jobRunRepo'

// Finalizes ended auctions (winner + e-mail). Triggered by Google Cloud Scheduler
// every ~5 minutes; authenticates with a shared secret (no Firebase user, HTTPS in
// transit). Idempotent — the underlying passes are guarded, so an overlapping retry
// is harmless.
export default defineEventHandler(async event => {
  requireCronSecret(event)

  // Cloud Scheduler retries on 5xx; cap accidental rapid-fire (per-instance, best effort).
  enforceRateLimit(event, { bucket: 'cron-close-auctions', limit: 6, windowMs: 60_000, key: 'scheduler' })

  return await withJobRun('close-auctions', () => closeEndedAuctions())
})
