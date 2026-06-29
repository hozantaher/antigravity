// Campaign-contact machinery-priority sync cron (2026-06-26).
//
// WHY: campaign_contacts.priority (migration 111, drives the send-batch
// ORDER BY priority DESC = "highest machinery-fit first") had no committed
// writer. New enrollments (categoryTree.js / campaignSegmentExpansion.js
// INSERT without a priority → DEFAULT 0) landed at priority 0 = E-tier =
// bottom of the queue, and a historical ad-hoc PROD backfill had silently
// overwritten ~50k rows with the 0-100 prospect_score (mixed-scale corruption
// repaired by migration 178). This cron makes the score self-healing: it is
// the single recurring authority that keeps priority = the canonical
// compute_machinery_score(contacts.category_path) on the 0-1 scale.
//
// SCOPE: only rows with priority IS NULL OR priority = 0 (unscored). The
// scorer never returns 0 (min branch is 0.10), so 0/NULL unambiguously means
// "never scored" — already-scored rows are left untouched, making each tick
// near-zero-write in steady state. The INNER JOIN to contacts means orphan
// campaign_contacts (deleted contact) are never selected → the loop always
// converges (it cannot re-select a row it just lifted off 0).
//
// HARD rules:
//   - feedback_no_magic_thresholds T0 — all batch sizes / intervals named.
//   - feedback_schema_verify_before_sql T0 — campaign_contacts(priority REAL,
//     contact_id), contacts(id, category_path), compute_machinery_score()
//     verified in PROD 2026-06-26 (migration 178).
//   - feedback_audit_log_on_mutations T0 — one aggregated operator_audit_log
//     row per tick (low-stakes recompute, not a per-contact state change).

// ── Named tuning constants (no magic numbers) ────────────────────────────────
export const PRIORITY_SYNC_BATCH_SIZE      = 2000
export const PRIORITY_SYNC_TICK_MAX_ROWS   = 20000
export const PRIORITY_SYNC_CRON_INTERVAL_MS = 6 * 60 * 60 * 1000  // 6h
export const PRIORITY_SYNC_LOG_EVERY_N_ROWS = 2000

/**
 * Reprice one batch of unscored campaign_contacts. compute_machinery_score is
 * evaluated once per selected row inside the CTE.
 * @param {import('pg').Pool|import('pg').PoolClient} q
 * @param {number} limit
 * @returns {Promise<number>} rows updated in this batch
 */
async function syncBatch(q, limit) {
  const { rowCount } = await q.query(
    `WITH batch AS (
       SELECT cc.id AS cc_id, compute_machinery_score(c.category_path) AS m
         FROM campaign_contacts cc
         JOIN contacts c ON c.id = cc.contact_id
        WHERE cc.priority IS NULL OR cc.priority = 0
        ORDER BY cc.id
        LIMIT $1
     )
     UPDATE campaign_contacts cc
        SET priority = b.m, updated_at = NOW()
       FROM batch b
      WHERE cc.id = b.cc_id`,
    [limit],
  )
  return rowCount
}

/**
 * One tick. Caller wraps in `timed(...)` in server.js.
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ synced: number, batches: number, ticks_remaining: boolean, duration_ms: number }>}
 */
export async function runCampaignContactPriorityCron(pool) {
  const t0 = Date.now()
  let synced = 0
  let batches = 0
  let ticksRemaining = true

  try {
    while (synced < PRIORITY_SYNC_TICK_MAX_ROWS) {
      const remaining = PRIORITY_SYNC_TICK_MAX_ROWS - synced
      const limit = Math.min(PRIORITY_SYNC_BATCH_SIZE, remaining)
      const updated = await syncBatch(pool, limit)
      if (updated === 0) {
        ticksRemaining = false
        break
      }
      synced += updated
      batches++
      if (synced % PRIORITY_SYNC_LOG_EVERY_N_ROWS < limit) {
        console.log(`[cron] runCampaignContactPriorityCron progress synced=${synced}`)
      }
      // Caught up — this batch was smaller than requested, no more unscored rows.
      if (updated < limit) {
        ticksRemaining = false
        break
      }
    }

    if (synced > 0) {
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_priority_sync', 'cron:runCampaignContactPriorityCron', 'campaign_contacts', NULL, $1::jsonb)`,
        [JSON.stringify({
          synced,
          batches,
          batch_size: PRIORITY_SYNC_BATCH_SIZE,
          tick_max_rows: PRIORITY_SYNC_TICK_MAX_ROWS,
        })],
      )
    }
  } catch (e) {
    console.error(`[cron] runCampaignContactPriorityCron error: ${e.message}`)
  }

  const duration_ms = Date.now() - t0
  console.log(
    `[cron] runCampaignContactPriorityCron done duration_ms=${duration_ms} ` +
      `synced=${synced} batches=${batches} ticks_remaining=${ticksRemaining}`,
  )
  return { synced, batches, ticks_remaining: ticksRemaining, duration_ms }
}
