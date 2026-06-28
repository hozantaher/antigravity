// crmBackfill.js — iter62 (autonomous sync)
// ─────────────────────────────────────────────────────────────────────────────
// Shared contacts→crm_clients linkage used by BOTH the operator-initiated
// POST /api/crm/backfill-run endpoint AND the daily runCrmBackfillCron, so the
// link rule is defined in ONE place (the audit flagged two divergent copies).
//
// Rule (ordered, ICO is the stronger company-identity signal):
//   1. contacts.ico        = crm_clients.ico              (primary)
//   2. lower(contacts.email) = lower(crm_clients.email_primary)  (secondary)
//
// Only fills contacts.crm_client_id where currently NULL — never overwrites an
// existing link. Capped per run so a runaway can't lock the table. Audit-logged
// in the same transaction (feedback_audit_log_on_mutations T0). No magic
// numbers — caller passes the cap (feedback_no_magic_thresholds T0).

/** Default max contacts linked per invocation (caller may override). */
export const CRM_BACKFILL_MAX_ROWS_DEFAULT = 5000
/** Statement timeout guard for the linkage UPDATEs (ms). */
export const CRM_BACKFILL_STMT_TIMEOUT_MS = 30_000

/**
 * Link unlinked contacts to crm_clients by ICO then email_primary.
 * @param {import('pg').Pool} pool
 * @param {{ maxRows?: number, actor?: string }} [opts]
 * @returns {Promise<{ ico_matched: number, email_matched: number, total: number, duration_ms: number }>}
 */
export async function runCrmBackfill(pool, opts = {}) {
  const maxRows = Number.isInteger(opts.maxRows) && opts.maxRows > 0
    ? opts.maxRows
    : CRM_BACKFILL_MAX_ROWS_DEFAULT
  const actor = opts.actor || 'system'

  const client = await pool.connect()
  const t0 = Date.now()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL statement_timeout = ${CRM_BACKFILL_STMT_TIMEOUT_MS}`)

    // Path 1 — ICO match. NB: Postgres UPDATE has no LIMIT clause, so the cap
    // is applied in a SELECT CTE (DISTINCT ON picks the lowest crm id when a
    // contact's ICO matches multiple clients), then the UPDATE joins that set.
    const icoRes = await client.query(`
      WITH cand AS (
        SELECT DISTINCT ON (c.id) c.id AS cid, cl.id AS crmid
        FROM contacts c
        JOIN crm_clients cl ON cl.ico = c.ico
        WHERE c.crm_client_id IS NULL
          AND c.ico IS NOT NULL AND c.ico <> ''
          AND cl.ico IS NOT NULL AND cl.ico <> ''
        ORDER BY c.id, cl.id
        LIMIT $1
      ),
      upd AS (
        UPDATE contacts c
        SET crm_client_id = cand.crmid, updated_at = now()
        FROM cand WHERE c.id = cand.cid
        RETURNING c.id
      )
      SELECT COUNT(*)::int AS n FROM upd
    `, [maxRows])
    const icoMatched = icoRes.rows[0].n

    // Path 2 — email_primary match (remaining cap after ICO).
    let emailMatched = 0
    const emailCap = maxRows - icoMatched
    if (emailCap > 0) {
      const emailRes = await client.query(`
        WITH cand AS (
          SELECT DISTINCT ON (c.id) c.id AS cid, cl.id AS crmid
          FROM contacts c
          JOIN crm_clients cl ON lower(trim(cl.email_primary)) = lower(trim(c.email))
          WHERE c.crm_client_id IS NULL
            AND c.email IS NOT NULL AND c.email <> ''
            AND cl.email_primary IS NOT NULL AND cl.email_primary <> ''
          ORDER BY c.id, cl.id
          LIMIT $1
        ),
        upd AS (
          UPDATE contacts c
          SET crm_client_id = cand.crmid, updated_at = now()
          FROM cand WHERE c.id = cand.cid
          RETURNING c.id
        )
        SELECT COUNT(*)::int AS n FROM upd
      `, [emailCap])
      emailMatched = emailRes.rows[0].n
    }

    const total = icoMatched + emailMatched
    const durationMs = Date.now() - t0

    // Only write an audit row when something actually changed — avoids
    // flooding operator_audit_log with no-op daily ticks.
    if (total > 0) {
      await client.query(`
        INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
        VALUES ('crm_client_backfill', $1, 'contacts', NULL, $2, now())
      `, [actor, JSON.stringify({ ico_matched: icoMatched, email_matched: emailMatched, total, duration_ms: durationMs, max_rows: maxRows })])
    }

    await client.query('COMMIT')
    return { ico_matched: icoMatched, email_matched: emailMatched, total, duration_ms: durationMs }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
