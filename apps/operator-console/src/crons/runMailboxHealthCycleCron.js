import { evaluateMailboxAutoResume } from '../lib/automation.js'

/**
 * runMailboxHealthCycleCron — trigger full-check on degraded mailboxes + auto-unpause recovered ones.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.logHealing — server.js-local async helper
 */
export async function runMailboxHealthCycleCron(pool, { logHealing }) {
  console.log('[cron] runMailboxHealthCycleCron start')
  try {
    const { rows } = await pool.query(`
      SELECT id FROM outreach_mailboxes
      WHERE status IN ('active', 'paused')
        AND (last_score < 50 OR auth_fail_count > 0 OR consecutive_bounces > 2)
        AND (last_score_at IS NULL OR last_score_at < now() - interval '1 hour')
    `)
    if (rows.length === 0) {
      console.log('[cron] runMailboxHealthCycleCron done — no degraded mailboxes')
      return
    }
    const base = `http://localhost:${process.env.PORT || 18001}`
    for (const row of rows) {
      try {
        await fetch(`${base}/api/mailboxes/${row.id}/full-check?force=1`)
      } catch (e) {
        console.error(`[healthCycle] full-check ${row.id}:`, e.message)
      }
    }

    // After checks have run, evaluate recovered mailboxes for auto-unpause.
    //
    // BF-A3 — fail-open hardening:
    //   1. Pure-fn evaluateMailboxAutoResume() encapsulates the rule. Tests
    //      cover misconfiguration, stale scores, manual-reason guards.
    //   2. UPDATE WHERE clause re-asserts status='paused' AND status_reason
    //      LIKE 'auto:%'. If an operator manually re-paused between SELECT
    //      and UPDATE, we must NOT silently overwrite their reason.
    //   3. Per-iteration try/catch. Earlier code wrapped the whole loop;
    //      one bad row now no longer aborts the rest.
    try {
      const { rows: candidates } = await pool.query(`
        SELECT id, status, status_reason, last_score, last_score_at
        FROM outreach_mailboxes
        WHERE status = 'paused'
          AND status_reason LIKE 'auto:%'
      `)
      for (const mb of candidates) {
        try {
          const decision = evaluateMailboxAutoResume(mb)
          if (decision.action !== 'resume') {
            // Quiet: noisy under normal load. Re-enable with debug flag if needed.
            continue
          }
          const upd = await pool.query(
            `UPDATE outreach_mailboxes
                SET status='active', status_reason=NULL
              WHERE id=$1
                AND status='paused'
                AND status_reason LIKE 'auto:%'
              RETURNING id`,
            [mb.id]
          )
          if (upd.rowCount === 0) {
            // Operator changed status_reason between SELECT and UPDATE — respect it.
            console.log(`[healthCycle] mailbox ${mb.id} auto-resume aborted: status changed mid-cycle`)
            continue
          }
          await logHealing('mailbox', mb.id, String(mb.id), 'auto_resume',
            `health cycle: ${decision.reason}, auto-unpaused`)
          console.log(`[healthCycle] mailbox ${mb.id} unpaused — ${decision.reason}`)
        } catch (e) {
          console.error(`[healthCycle] unpause ${mb.id}:`, e.message)
        }
      }
    } catch (e) {
      console.error('[healthCycle] unpause evaluation error:', e.message)
    }

    console.log(`[cron] runMailboxHealthCycleCron done — triggered ${rows.length} full-checks`)
  } catch (e) {
    console.error('[cron] runMailboxHealthCycleCron error:', e.message)
  }
}
