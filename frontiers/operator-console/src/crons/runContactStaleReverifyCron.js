/**
 * runContactStaleReverifyCron — re-enqueue contacts verified >90d ago into verifyLoop.
 *
 * Module-scoped in-flight flag prevents overlapping invocations.
 *
 * Named constants (tuneable via operator_settings fallback at runtime):
 *   CONTACT_REVERIFY_INTERVAL_DAYS — days before a verified contact is stale
 *   CONTACT_REVERIFY_BATCH_SIZE    — max contacts re-enqueued per cron run
 *   CONTACT_REVERIFY_JITTER_S      — max jitter in seconds (0-3600) added to next_at
 *
 * Hard rules honoured:
 *   - feedback_no_magic_thresholds : named constants, not magic literals
 *   - feedback_audit_log_on_mutations : UPDATE + audit row in same tx
 *   - feedback_external_io_backoff   : scheduleDaily handles timing; no I/O here
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */

export const CONTACT_REVERIFY_INTERVAL_DAYS = 90   // days before a verified contact is stale
export const CONTACT_REVERIFY_BATCH_SIZE    = 500  // max contacts re-enqueued per cron run
export const CONTACT_REVERIFY_JITTER_S      = 3600 // max jitter in seconds (0-3600) added to next_at

// Terminal statuses are excluded — no point re-verifying known-bad addresses
const CONTACT_REVERIFY_EXCLUDED_STATUSES = ['bounce_hold', 'spamtrap', 'invalid']

let _contactStaleReverifyInFlight = false

export async function runContactStaleReverifyCron(pool) {
  if (_contactStaleReverifyInFlight) {
    console.log('[cron] runContactStaleReverifyCron skipped — previous run still in flight')
    return
  }
  _contactStaleReverifyInFlight = true
  console.log('[cron] runContactStaleReverifyCron start')

  const client = await pool.connect()
  try {
    // Resolve tuneable constants from operator_settings (DB-first, env fallback).
    const settingRows = await pool.query(
      `SELECT key, value FROM operator_settings
        WHERE key IN ('contact_reverify_interval_days','contact_reverify_batch_size')`,
    ).then(r => r.rows).catch(() => [])
    const settingsMap = Object.fromEntries(settingRows.map(r => [r.key, r.value]))

    const intervalDays = Number(settingsMap['contact_reverify_interval_days'] ?? CONTACT_REVERIFY_INTERVAL_DAYS)
    const batchSize    = Number(settingsMap['contact_reverify_batch_size']    ?? CONTACT_REVERIFY_BATCH_SIZE)

    const excludedList = CONTACT_REVERIFY_EXCLUDED_STATUSES.map(s => `'${s}'`).join(',')

    // Fetch stale contacts — those verified more than intervalDays ago that are
    // not in a terminal state and have not already been re-enqueued.
    const { rows } = await pool.query(
      `SELECT id, email
         FROM contacts
        WHERE email IS NOT NULL
          AND email_verified_at IS NOT NULL
          AND email_verified_at < NOW() - ($1 || ' days')::INTERVAL
          AND email_status NOT IN (${excludedList})
          AND (email_verify_next_at IS NULL OR email_verify_next_at < NOW())
        ORDER BY email_verified_at ASC
        LIMIT $2`,
      [intervalDays, batchSize],
    )

    if (rows.length === 0) {
      console.log('[cron] runContactStaleReverifyCron noop — no stale contacts found')
      return
    }

    // Re-enqueue each contact: set email_verify_next_at = NOW() + jitter.
    // Jitter spreads the reverify load across the next hour so the verifyLoop
    // does not spike when a large batch becomes due simultaneously.
    let enqueued = 0
    for (const row of rows) {
      const jitterSec = Math.floor(Math.random() * CONTACT_REVERIFY_JITTER_S)
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE contacts
              SET email_verify_next_at = NOW() + ($1 || ' seconds')::INTERVAL
            WHERE id = $2`,
          [jitterSec, row.id],
        )
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('contact_stale_reverify_enqueue', 'cron', 'contact', $1, $2)`,
          [String(row.id), JSON.stringify({ email: row.email, jitter_sec: jitterSec, interval_days: intervalDays })],
        )
        await client.query('COMMIT')
        enqueued++
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        console.error(`[cron] runContactStaleReverifyCron contact ${row.id} error:`, e.message)
      }
    }

    console.log(`[cron] runContactStaleReverifyCron processed=${enqueued}/${rows.length} re-enqueued`)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[cron] runContactStaleReverifyCron error:', e.message)
  } finally {
    client.release()
    _contactStaleReverifyInFlight = false
  }
}
