import { planRefreshJobs } from '../lib/refreshPolicy.js'

/**
 * runAdaptiveRefreshCron — enqueue enrichment_jobs for stale (company, source) pairs.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runAdaptiveRefreshCron(pool) {
  console.log('[cron] runAdaptiveRefreshCron start')
  try {
    const t0 = Date.now()
    const { rows: sources } = await pool.query(
      `SELECT source, default_ttl_days FROM enrichment_sources
        WHERE enabled = TRUE AND source <> 'manual'`,
    )
    if (sources.length === 0) {
      console.log('[cron] runAdaptiveRefreshCron: no enabled sources')
      return
    }
    let totalEnqueued = 0
    for (const s of sources) {
      // Pull candidates: companies × this source, joined to latest fact (if any).
      // Cap to 5000 per source per tick — large rollout pacing.
      const { rows } = await pool.query(`
        SELECT c.id            AS company_id,
               c.score_tier    AS score_tier,
               (c.datum_zaniku IS NOT NULL OR COALESCE(c.v_likvidaci,false) OR COALESCE(c.v_insolvenci,false)) AS dead_entity,
               $1::text        AS source,
               $2::int         AS source_ttl_days,
               MAX(cf.fetched_at) AS last_fetched_at
          FROM companies c
          LEFT JOIN company_facts cf
            ON cf.company_id = c.id AND cf.source = $1
         WHERE c.exclusion_status = 'pass'
           AND (c.email IS NOT NULL OR c.website IS NOT NULL)
         GROUP BY c.id, c.score_tier, c.datum_zaniku, c.v_likvidaci, c.v_insolvenci
         LIMIT 5000
      `, [s.source, s.default_ttl_days])
      const jobs = planRefreshJobs(rows)
      if (jobs.length === 0) continue
      // Bulk upsert — uniq index on (company_id, source) WHERE status IN ('pending','running')
      // ensures we don't double-queue.
      const values = jobs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, now())`).join(',')
      const params = jobs.flatMap(j => [j.company_id, j.source])
      const { rowCount } = await pool.query(
        `INSERT INTO enrichment_jobs (company_id, source, scheduled_at) VALUES ${values}
         ON CONFLICT DO NOTHING`,
        params,
      )
      totalEnqueued += rowCount
      console.log(`[cron] runAdaptiveRefreshCron ${s.source}: planned ${jobs.length}, enqueued ${rowCount}`)
    }
    console.log(`[cron] runAdaptiveRefreshCron done — ${totalEnqueued} jobs in ${Date.now() - t0}ms`)
  } catch (e) {
    console.error('[cron] runAdaptiveRefreshCron error:', e.message)
  }
}
