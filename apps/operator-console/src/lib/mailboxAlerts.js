// Mailbox alert dedup + re-fire helper.
//
// Problem this solves:
//   The three INSERT INTO mailbox_alerts(...) call sites in server.js had only
//   IMPLICIT dedup (via status-flip side effects). That left two bugs:
//
//     1. score_drop fired on every probe once delta <= -20 (spam).
//     2. If an operator resolved an alert (UPDATE … SET resolved_at=now()) and
//        the underlying condition persisted, the next probe's side-effect gate
//        (e.g. status === 'active') no longer matched cleanly, so the operator
//        never saw a fresh alert — the problem became invisible.
//
// Contract of createMailboxAlert():
//   - If an UNRESOLVED alert for (mailbox_id, type) already exists, do nothing
//     and return { created: false, id: <existing id> }.
//   - Otherwise insert a new row with fresh created_at and return
//     { created: true, id: <new id> }.
//
// Consequence:
//   - While the alert is open, duplicate inserts from re-probing are suppressed.
//   - Once the operator resolves it, the next probe that still matches the
//     condition WILL insert a new row — fresh created_at = fresh triggered_at.

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ id: number }> }> }} pool
 * @param {number} mailboxId
 * @param {string} type
 * @param {string} severity
 * @param {string} message
 * @returns {Promise<{ created: boolean, id: number | null }>}
 */
export async function createMailboxAlert(pool, mailboxId, type, severity, message) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createMailboxAlert: pool with .query() required')
  }
  if (!Number.isInteger(mailboxId) || mailboxId <= 0) {
    throw new TypeError('createMailboxAlert: mailboxId must be positive integer')
  }
  if (typeof type !== 'string' || !type) {
    throw new TypeError('createMailboxAlert: type required')
  }

  const existing = await pool.query(
    `SELECT id FROM mailbox_alerts
     WHERE mailbox_id=$1 AND type=$2 AND resolved_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [mailboxId, type]
  )
  if (existing.rows && existing.rows.length > 0) {
    return { created: false, id: existing.rows[0].id }
  }

  const inserted = await pool.query(
    `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message)
     VALUES($1, $2, $3, $4)
     RETURNING id`,
    [mailboxId, type, severity, message]
  )
  const id = inserted.rows?.[0]?.id ?? null
  return { created: true, id }
}
