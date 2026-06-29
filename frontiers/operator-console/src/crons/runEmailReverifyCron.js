import { computeReverifyBudget } from '../lib/automation.js'

/**
 * runEmailReverifyCron — re-verify companies with valid/catch_all email older than 30d.
 *
 * Module-scoped in-flight flag prevents overlapping invocations.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.runVerifyAndPersist — server.js-local async helper
 */

// BF-A5 — in-flight guard prevents overlapping invocations
// (Railway redeploy can fire two cron schedulers briefly).
let _reverifyInFlight = false

export async function runEmailReverifyCron(pool, { runVerifyAndPersist }) {
  if (_reverifyInFlight) {
    console.log('[cron] runEmailReverifyCron skipped — previous run still in flight')
    return
  }
  _reverifyInFlight = true
  console.log('[cron] runEmailReverifyCron start')
  try {
    // Daily-already-done count (UTC day boundary; safer than local TZ
    // because the email_verification_log INSERT always uses now()).
    const { rows: [today] } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM email_verification_log
       WHERE trigger='cron'
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
    `).catch(() => ({ rows: [{ n: 0 }] }))

    const { rows: [staleAgg] } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM companies
       WHERE email IS NOT NULL
         AND email_status IN ('valid','catch_all')
         AND email_verified_at < now() - interval '30 days'
    `).catch(() => ({ rows: [{ n: 0 }] }))

    const defaultBatch = Number(process.env.EMAIL_REVERIFY_BATCH_SIZE) || 200
    const dailyMax = Number(process.env.EMAIL_REVERIFY_DAILY_MAX) || 1000
    const decision = computeReverifyBudget(
      { stale: staleAgg?.n ?? 0, alreadyToday: today?.n ?? 0 },
      { defaultBatch, dailyMax }
    )
    if (decision.batch === 0) {
      console.log(`[cron] runEmailReverifyCron noop — ${decision.reason}`)
      return
    }

    const { rows } = await pool.query(
      `SELECT DISTINCT ON (lower(split_part(email,'@',2))) ico, email
         FROM companies
        WHERE email IS NOT NULL
          AND email_status IN ('valid','catch_all')
          AND email_verified_at < now() - interval '30 days'
        ORDER BY lower(split_part(email,'@',2)), email_verified_at ASC
        LIMIT $1`,
      [decision.batch]
    )
    let ok = 0, changed = 0
    for (const co of rows) {
      try {
        const before = await pool.query(`SELECT email_status FROM companies WHERE ico=$1`, [co.ico])
        const r = await runVerifyAndPersist(co.ico, co.email, 'cron')
        ok++
        if (before.rows[0]?.email_status !== r.status) changed++
      } catch (e) {
        console.error(`[cron] reverify ${co.ico}:`, e.message)
      }
    }
    console.log(`[cron] runEmailReverifyCron done — ${ok}/${rows.length} reverified (budget ${decision.batch}), ${changed} status changed`)
  } catch (e) {
    console.error('[cron] runEmailReverifyCron error:', e.message)
  } finally {
    _reverifyInFlight = false
  }
}
