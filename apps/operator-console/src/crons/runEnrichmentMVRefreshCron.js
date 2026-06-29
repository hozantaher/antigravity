/**
 * runEnrichmentMVRefreshCron — REFRESH MATERIALIZED VIEW CONCURRENTLY company_current_facts.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.refreshCompanyCurrentFactsMV — server.js-local async helper
 */
export async function runEnrichmentMVRefreshCron(pool, { refreshCompanyCurrentFactsMV }) {
  console.log('[cron] runEnrichmentMVRefreshCron start')
  try {
    const t0 = Date.now()
    await refreshCompanyCurrentFactsMV()
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM company_current_facts`)
    console.log(`[cron] runEnrichmentMVRefreshCron done — ${n} rows in ${Date.now() - t0}ms`)
  } catch (e) {
    console.error('[cron] runEnrichmentMVRefreshCron error:', e.message)
  }
}
