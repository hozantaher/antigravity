/**
 * mailboxOpRateLimit.js — AP3 per-operation rate limits for mailbox operations.
 *
 * Prevents credential hammering by enforcing hard per-hour caps per mailbox
 * per operation type. Uses a DB log table (mailbox_op_rate_log, migration 072)
 * as the backing store. Single transaction: COUNT → refuse or INSERT+allow.
 *
 * Sprint AP3 — initiative #1110.
 */

/** @type {Record<string, { max: number, windowSec: number }>} */
const OP_RATE_CAPS = {
  imap_poll:        { max: 12, windowSec: 3600 },
  imap_inbox_fetch: { max: 6,  windowSec: 3600 },
  full_check:       { max: 2,  windowSec: 3600 },
  smtp_probe:       { max: 12, windowSec: 3600 },
  verify_email:     { max: 5,  windowSec: 3600 },
  // F3: per-mailbox live diagnose — max 1 call / 2 min (120s) per mailbox.
  diagnose:         { max: 1,  windowSec: 120 },
}

/**
 * checkAndRecord — atomic: count recent ops in window, refuse if >= max,
 * else INSERT log row + allow.
 *
 * @param {import('pg').Pool} pool
 * @param {number|string} mailboxId
 * @param {string} opType
 * @param {Record<string, unknown>} [metadata]
 * @returns {Promise<{ allowed: boolean, used: number, max: number, retryAfterSec: number }>}
 */
async function checkAndRecord(pool, mailboxId, opType, metadata = {}) {
  const cap = OP_RATE_CAPS[opType]
  if (!cap) throw new Error(`unknown op_type: ${opType}`)

  // Use single transaction for atomicity.
  // AP3 race fix: acquire row-level lock on outreach_mailboxes before counting,
  // preventing READ COMMITTED phantom: two parallel transactions both see
  // count=N-1, both pass, final count=N+1 (over cap).
  // FOR UPDATE serialises all concurrent checkAndRecord calls for the same mailbox.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Serialization lock — must be first query inside the transaction so the
    // lock is held for the full count+insert duration.  COMMIT releases it.
    const lockResult = await client.query(
      `SELECT 1 FROM outreach_mailboxes WHERE id=$1 FOR UPDATE`,
      [mailboxId]
    )
    // P2 FIX: check FOR UPDATE lock acquired row. If mailbox was deleted mid-flight,
    // rowCount=0 → lock acquired nothing → subsequent INSERT fails with FK violation.
    // Fail early with explicit error.
    if (lockResult.rowCount === 0) {
      await client.query('COMMIT')
      return { allowed: false, error: 'mailbox_not_found' }
    }
    const { rows } = await client.query(
      `SELECT count(*)::int AS used,
              MIN(occurred_at) AS oldest_in_window
         FROM mailbox_op_rate_log
        WHERE mailbox_id=$1
          AND op_type=$2
          AND occurred_at > NOW() - ($3 || ' seconds')::interval`,
      [mailboxId, opType, cap.windowSec]
    )
    const used = rows[0].used
    if (used >= cap.max) {
      const oldest = rows[0].oldest_in_window
      // Retry after = when oldest entry exits window
      const retryAfterSec = oldest
        ? Math.max(1, cap.windowSec - Math.floor((Date.now() - new Date(oldest).getTime()) / 1000))
        : cap.windowSec
      // COMMIT (not ROLLBACK) to release the FOR UPDATE row lock — no data
      // was inserted so this is a no-op commit that just frees the lock.
      await client.query('COMMIT')
      return { allowed: false, used, max: cap.max, retryAfterSec }
    }
    await client.query(
      `INSERT INTO mailbox_op_rate_log (mailbox_id, op_type, metadata) VALUES ($1, $2, $3::jsonb)`,
      [mailboxId, opType, JSON.stringify(metadata)]
    )
    await client.query('COMMIT')
    return { allowed: true, used: used + 1, max: cap.max, retryAfterSec: 0 }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export { checkAndRecord, OP_RATE_CAPS }
