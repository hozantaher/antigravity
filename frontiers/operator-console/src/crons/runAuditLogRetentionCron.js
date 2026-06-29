/**
 * runAuditLogRetentionCron — BF-D2: prune operator_audit_log rows older than AUDIT_LOG_RETENTION_DAYS.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runAuditLogRetentionCron(pool) {
  console.log('[cron] runAuditLogRetentionCron start')
  const days = Number(process.env.AUDIT_LOG_RETENTION_DAYS || 1825)
  if (!Number.isFinite(days) || days < 30) {
    console.error(`[cron] runAuditLogRetentionCron: refusing — AUDIT_LOG_RETENTION_DAYS=${days} unreasonable (min 30)`)
    return
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM operator_audit_log WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(days)]
    )
    if (rowCount > 0) {
      // Log the prune itself — but don't infinite-loop (the prune row has
      // recent created_at so it won't be deleted by next pass). Audit
      // metadata only counts, not entity ids, since deleted rows are gone.
      await pool.query(
        `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
         VALUES('audit_log_pruned', 'cron', 'table', 'operator_audit_log', $1::jsonb)`,
        [JSON.stringify({ rows_deleted: rowCount, retention_days: days, run_at: new Date().toISOString() })]
      ).catch(() => {})
    }
    console.log(`[cron] runAuditLogRetentionCron done — pruned ${rowCount || 0} rows older than ${days} days`)
  } catch (e) {
    console.error('[cron] runAuditLogRetentionCron error:', e.message)
  }
}
