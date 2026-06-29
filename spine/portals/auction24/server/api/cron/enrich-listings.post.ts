import { requireCronSecret } from '../../utils/session'
import { enforceRateLimit } from '../../utils/rateLimit'
import { isEnrichEnabled } from '../../utils/enrich'
import { enrichListings } from '../../utils/enrichListings'
import { withJobRun } from '../../repos/jobRunRepo'

// Deterministic listing enrichment: decodes pending VINs (durable cache → free repeats) and fills
// empty DeepL locales. Google Cloud Scheduler triggers it ~every 10 min. Shared-secret auth;
// claim-CAS + per-item try/catch make it idempotent and crash-safe. Opt-in via ENRICH_ENABLED.
export default defineEventHandler(async event => {
  requireCronSecret(event)
  enforceRateLimit(event, { bucket: 'cron-enrich', limit: 6, windowMs: 60_000, key: 'scheduler' })

  if (!isEnrichEnabled()) return { skipped: 'enrich-disabled' as const }

  return await withJobRun('enrich-listings', () => enrichListings())
})
