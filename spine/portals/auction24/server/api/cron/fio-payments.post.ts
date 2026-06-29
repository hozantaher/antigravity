import { requireCronSecret } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { processFioPayments } from '../../utils/deposit'
import { withJobRun } from '../../repos/jobRunRepo'

// Pulls incoming movements from both Fio accounts (CZK + EUR) and settles matching
// deposit invoices. Triggered by Google Cloud Scheduler every ~5 minutes;
// authenticates with a shared secret. Idempotent — movements are deduped by
// (account, fio_id), settlement is a CAS update, so an overlapping retry is harmless.
export default defineEventHandler(async event => {
  requireCronSecret(event)

  // Cloud Scheduler retries on 5xx; cap accidental rapid-fire (per-instance, best effort).
  enforceRateLimit(event, { bucket: 'cron-fio-payments', limit: 6, windowMs: 60_000, key: 'scheduler' })

  return await withJobRun('fio-payments', () => processFioPayments())
})
