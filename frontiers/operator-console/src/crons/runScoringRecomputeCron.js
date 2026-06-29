/**
 * runScoringRecomputeCron — batch-recompute composite scores for stale companies.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.getScoringWeights       — server.js-local async helper
 *   @param {Function} deps.loadSectorEngagementPriors — server.js-local async helper
 *   @param {Function} deps.recomputeScoreForIco    — server.js-local async helper
 *   @param {number}   deps.SCORING_BATCH_SIZE
 */
export async function runScoringRecomputeCron(pool, { getScoringWeights, loadSectorEngagementPriors, recomputeScoreForIco, SCORING_BATCH_SIZE }) {
  try {
    const weights = await getScoringWeights()
    const sectorPriors = await loadSectorEngagementPriors()
    const { rows } = await pool.query(`
      SELECT ico FROM companies
      WHERE datum_zaniku IS NULL
        AND (scored_at IS NULL OR scored_at < now() - INTERVAL '24 hours')
      LIMIT $1
    `, [SCORING_BATCH_SIZE])
    let ok = 0, err = 0
    for (const r of rows) {
      try { await recomputeScoreForIco(r.ico, weights, sectorPriors); ok++ }
      catch { err++ }
    }
    if (rows.length) console.log(`[cron] scoring: ${ok} scored, ${err} errors (batch ${rows.length})`)
  } catch (e) { console.error('[cron] scoring error:', e.message) }
}
