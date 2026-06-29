import { requireAdmin } from '../../utils/session'
import { listLatestJobRunPerJob, listRecentJobRuns } from '../../repos/jobRunRepo'

// Per-job staleness budget (ms): the latest run older than this counts as stale. Fio + auction
// close run ~5 min, recommendations ~10–15 min, alerts daily, newsletter every 2 days. A stale or
// failed latest run surfaces a silently-broken job (e.g. an expired Fio token stops settling).
const STALE_MS: Record<string, number> = {
  'fio-payments': 30 * 60_000,
  'close-auctions': 30 * 60_000,
  'build-recommendations': 60 * 60_000,
  'enrich-listings': 60 * 60_000,
  'saved-search-alerts': 2 * 24 * 60 * 60_000,
  newsletter: 3 * 24 * 60 * 60_000,
}

export default defineEventHandler(async event => {
  await requireAdmin(event)
  const now = Date.now()
  const latest = await listLatestJobRunPerJob()
  const health = latest.map(r => {
    const ref = r.finishedAt ?? r.startedAt
    const stale = now - ref > (STALE_MS[r.job] ?? 60 * 60_000)
    return { ...r, stale, healthy: r.ok === true && !stale }
  })
  const recent = await listRecentJobRuns(50)
  return { health, recent }
})
