// AV-F5-A — Prospect scoring cron.
//
// Walks unsent contacts (crm_client_id IS NULL) whose prospect_score_at is
// stale (NULL or > PROSPECT_SCORE_RECOMPUTE_INTERVAL_HOURS old) and writes
// a fresh prospect_score / prospect_score_at / prospect_score_factors row.
//
// Each tick:
//   1. SELECT up to PROSPECT_SCORE_TICK_MAX_ROWS candidates, JOINed against
//      companies for ICP tier + sector + fleet signals.
//   2. Process in batches of PROSPECT_SCORE_BATCH_SIZE — each batch issues
//      one UPDATE per row (parameterised), wrapped in a single transaction.
//   3. Stop early if the SELECT returns 0 rows (caught up) or once the tick
//      cap is reached.
//
// HARD rules:
//   - feedback_no_magic_thresholds T0 — all batch sizes / intervals named
//   - feedback_schema_verify_before_sql T0 — columns verified 2026-05-19
//     against PROD `\d contacts` + `\d companies` (see prospectScorer.js).
//   - feedback_audit_log_on_mutations T0 — operator_audit_log row per tick
//     (single aggregated row, not one per contact — score updates are
//     low-stakes recomputations, not state changes).

import { scoreProspect, SCORER_VERSION } from '../lib/prospectScorer.js'

// ── Named tuning constants (no magic numbers) ────────────────────────────────
export const PROSPECT_SCORE_BATCH_SIZE              = 500
export const PROSPECT_SCORE_TICK_MAX_ROWS           = 5000
export const PROSPECT_SCORE_RECOMPUTE_INTERVAL_HOURS = 24
export const PROSPECT_SCORE_CRON_INTERVAL_MS        = 6 * 60 * 60 * 1000  // 6h
export const PROSPECT_SCORE_LOG_EVERY_N_ROWS        = 1000

/**
 * Select a batch of contacts that need scoring.
 * @param {import('pg').Pool|import('pg').PoolClient} q
 * @param {number} limit
 * @returns {Promise<Array>}
 */
async function selectBatch(q, limit) {
  const { rows } = await q.query(
    `SELECT c.id,
            c.email,
            c.email_status,
            c.email_confidence,
            c.last_contacted,
            c.created_at,
            c.crm_client_id,
            c.ico,
            co.icp_tier,
            co.sector_primary,
            co.category_path,
            co.name AS company_name
       FROM contacts c
       LEFT JOIN companies co ON co.ico = c.ico
      WHERE c.crm_client_id IS NULL
        AND (c.prospect_score_at IS NULL
             OR c.prospect_score_at < NOW() - ($1 || ' hours')::interval)
      ORDER BY c.prospect_score_at NULLS FIRST, c.id
      LIMIT $2`,
    [String(PROSPECT_SCORE_RECOMPUTE_INTERVAL_HOURS), limit],
  )
  return rows
}

/**
 * Apply scoreProspect to one row and UPDATE.
 * @param {import('pg').PoolClient} client
 * @param {object} row
 * @param {Date} now
 */
async function scoreAndUpdate(client, row, now) {
  const contact = {
    crm_client_id: row.crm_client_id,
    email_status: row.email_status,
    email_confidence: row.email_confidence,
    last_contacted: row.last_contacted,
    created_at: row.created_at,
  }
  const company = row.icp_tier != null || row.sector_primary != null || row.company_name != null
    ? {
        icp_tier: row.icp_tier,
        sector_primary: row.sector_primary,
        category_path: row.category_path,
        name: row.company_name,
      }
    : null

  const result = scoreProspect(contact, company, { now })

  await client.query(
    `UPDATE contacts
        SET prospect_score         = $2,
            prospect_score_at      = NOW(),
            prospect_score_factors = $3::jsonb
      WHERE id = $1`,
    [row.id, result.score, JSON.stringify(result.factors)],
  )
}

/**
 * One tick of the prospect scoring cron. Caller is `timed(...)` in server.js.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{
 *   scored: number,
 *   batches: number,
 *   ticks_remaining: boolean,
 *   duration_ms: number
 * }>}
 */
export async function runProspectScoringCron(pool) {
  const t0 = Date.now()
  const now = new Date()
  let scored = 0
  let batches = 0
  let lastBatchSize = 0
  let ticksRemaining = true

  try {
    while (scored < PROSPECT_SCORE_TICK_MAX_ROWS) {
      const remaining = PROSPECT_SCORE_TICK_MAX_ROWS - scored
      const limit = Math.min(PROSPECT_SCORE_BATCH_SIZE, remaining)
      const rows = await selectBatch(pool, limit)
      lastBatchSize = rows.length
      if (rows.length === 0) {
        ticksRemaining = false
        break
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const row of rows) {
          await scoreAndUpdate(client, row, now)
          scored++
          if (scored % PROSPECT_SCORE_LOG_EVERY_N_ROWS === 0) {
            console.log(`[cron] runProspectScoringCron progress scored=${scored}`)
          }
        }
        await client.query('COMMIT')
      } catch (e) {
        try { await client.query('ROLLBACK') } catch { /* ignored */ }
        throw e
      } finally {
        client.release()
      }
      batches++

      // Caught up — last batch was smaller than the request, no more candidates.
      if (rows.length < limit) {
        ticksRemaining = false
        break
      }
    }

    // Aggregated audit row — one per tick, not per contact (low-stakes
    // recompute, not a state change). Skip when tick was empty.
    if (scored > 0) {
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('prospect_score_batch', 'cron:runProspectScoringCron', 'contacts', NULL, $1::jsonb)`,
        [JSON.stringify({
          scored,
          batches,
          last_batch_size: lastBatchSize,
          scorer_version: SCORER_VERSION,
          recompute_interval_hours: PROSPECT_SCORE_RECOMPUTE_INTERVAL_HOURS,
          tick_max_rows: PROSPECT_SCORE_TICK_MAX_ROWS,
          batch_size: PROSPECT_SCORE_BATCH_SIZE,
        })],
      )
    }
  } catch (e) {
    console.error(`[cron] runProspectScoringCron error: ${e.message}`)
  }

  const duration_ms = Date.now() - t0
  console.log(
    `[cron] runProspectScoringCron done duration_ms=${duration_ms} ` +
      `scored=${scored} batches=${batches} ticks_remaining=${ticksRemaining}`,
  )

  return { scored, batches, ticks_remaining: ticksRemaining, duration_ms }
}
