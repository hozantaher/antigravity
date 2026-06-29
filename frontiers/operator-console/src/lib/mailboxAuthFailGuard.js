// mailboxAuthFailGuard.js — Sprint AP6
// Auth-fail auto-quarantine: 3 fails of the SAME op_type in 1h → status='auth_locked' (24h cooldown)
//
// AP6 fix (2026-05-08): fail count is now per-op_type (Strategy A — split).
// Rationale: a network outage that triggers both IMAP and SMTP failures simultaneously
// was creating false-positive quarantines (2 IMAP + 1 SMTP = 3 combined → lock).
// Per-op_type splitting means each probe class must independently accumulate 3 fails.
// Memory: feedback_mailbox_passwords_via_db (no env vars), feedback_extreme_testing

const AUTH_FAIL_THRESHOLD = 3
const AUTH_FAIL_WINDOW_SEC = 3600  // 1 hour
const QUARANTINE_COOLDOWN_HOURS = 24

/**
 * recordAuthFail — INSERT auth fail row + check if per-op_type threshold exceeded.
 * Quarantine fires when ANY single op_type accumulates ≥3 fails in the 1h window.
 * Mixed-type fails (e.g. 2 IMAP + 2 SMTP) do NOT trigger quarantine.
 * Returns { quarantined: bool, fails_in_window: int }.
 *
 * @param {import('pg').Pool} pool
 * @param {number} mailboxId
 * @param {string} opType  e.g. 'smtp_probe', 'imap_poll', 'imap_inbox_fetch', 'full_check'
 * @param {string|null} errorMsg
 * @param {string} observer
 * @returns {Promise<{ quarantined: boolean, fails_in_window: number }>}
 */
async function recordAuthFail(pool, mailboxId, opType, errorMsg, observer = 'bff') {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO mailbox_auth_fails (mailbox_id, op_type, error_msg, observer, observed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
      [mailboxId, opType, errorMsg ?? null, observer]
    )
    // AP6 split: count fails per op_type independently to avoid false-positive
    // quarantine when a network outage hits multiple probe types simultaneously.
    const { rows } = await client.query(
      `SELECT op_type, count(*)::int AS cnt
         FROM mailbox_auth_fails
        WHERE mailbox_id = $1
          AND observed_at > NOW() - INTERVAL '1 hour'
        GROUP BY op_type
       HAVING count(*) >= $2`,
      [mailboxId, AUTH_FAIL_THRESHOLD]
    )
    // Any op_type that independently hit the threshold triggers quarantine
    const exceededOpType = rows.length > 0 ? rows[0] : null
    const failsInWindow = exceededOpType?.cnt ?? 0
    let quarantined = false
    if (exceededOpType) {
      const { rowCount } = await client.query(
        `UPDATE outreach_mailboxes
            SET status                  = 'auth_locked',
                auth_locked_at          = NOW(),
                auth_locked_reason      = $2,
                auth_locked_by_observer = $3
          WHERE id     = $1
            AND status NOT IN ('auth_locked', 'retired')`,
        [mailboxId, `${failsInWindow} ${exceededOpType.op_type} auth-fails in 1h window`, observer]
      )
      quarantined = rowCount > 0
    }
    await client.query('COMMIT')
    return { quarantined, fails_in_window: failsInWindow }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * canUnlock — check if 24h cooldown has elapsed since auth_locked_at.
 *
 * @param {import('pg').Pool} pool
 * @param {number} mailboxId
 * @returns {Promise<{ exists: boolean, locked_at?: Date|null, cooldown_passed?: boolean, hours_remaining?: number }>}
 */
async function canUnlock(pool, mailboxId) {
  const { rows } = await pool.query(
    `SELECT auth_locked_at,
            (NOW() - auth_locked_at >= INTERVAL '24 hours') AS cooldown_passed
       FROM outreach_mailboxes
      WHERE id = $1`,
    [mailboxId]
  )
  if (!rows.length) return { exists: false }
  const lockedAt = rows[0].auth_locked_at
  return {
    exists: true,
    locked_at: lockedAt,
    cooldown_passed: rows[0].cooldown_passed,
    hours_remaining: lockedAt
      ? Math.max(0, 24 - Math.floor((Date.now() - new Date(lockedAt).getTime()) / 3600000))
      : 0,
  }
}

export {
  recordAuthFail,
  canUnlock,
  AUTH_FAIL_THRESHOLD,
  AUTH_FAIL_WINDOW_SEC,
  QUARANTINE_COOLDOWN_HOURS,
}
