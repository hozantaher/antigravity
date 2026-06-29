// ── Tuning constants (no magic-number thresholds) ─────────────────────────
// Part 1 (email_verify_queue): how long we "claim" a queue row by pushing its
// retry_at into the future while we verify it OUTSIDE the row lock. Matches the
// normal greylist retry cadence (enqueueGreylistRetry re-arms retry_at to
// now()+10min on a repeat tempfail), so a row whose verify errors out before
// enqueueGreylistRetry runs simply retries on the next normal window.
const GREYLIST_QUEUE_CLAIM_MINUTES = 10
// Part 2 (mailbox_alerts): the eligibility gate requires the alert to be at
// least this old; to SPACE the next retry we push created_at this far into the
// FUTURE, so a still-greylisted alert next re-qualifies ~2× later (≈1h). The
// previous `now() - 29 minutes` made it re-qualify after ~1 minute (≈6× more
// SMTP probes against a greylisting host).
const MAILBOX_GREYLIST_RETRY_MINUTES = 30

/**
 * runGreylistRetryCron — retry email_verify_queue + mailbox greylist alerts.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.runVerifyAndPersist  — server.js-local async helper
 *   @param {Function} deps.evaluateGreylistQueueItem — from src/lib/automation.js
 *   @param {Function} deps.evaluateMailboxGreylistResult — from src/lib/automation.js
 *   @param {Function} deps.isGreylisted — from src/lib/mailboxUtils.js
 *   @param {number}   deps.GREYLIST_MAX_ATTEMPTS
 */
export async function runGreylistRetryCron(pool, { runVerifyAndPersist, evaluateGreylistQueueItem, evaluateMailboxGreylistResult, isGreylisted, GREYLIST_MAX_ATTEMPTS }) {
  console.log('[cron] runGreylistRetryCron start')
  try {
    // ── Part 1: email_verify_queue (company email greylisting) ────────
    //
    // BF-A2 — worker-safe SELECT: FOR UPDATE SKIP LOCKED prevents two
    // concurrent BFF instances (Railway redeploy overlap, manual restart
    // races) from picking the same item. We hold the row lock only long
    // enough to give up or CLAIM each row (push retry_at into the future),
    // then COMMIT and verify lock-free — see the claim note in the loop.
    const client = await pool.connect()
    let processed = 0, resolved = 0, gaveUp = 0
    // Rows claimed under the lock, verified AFTER the lock is released (below).
    const toVerify = []
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id, ico, email, attempts FROM email_verify_queue
          WHERE retry_at < now()
          ORDER BY retry_at ASC LIMIT 50
          FOR UPDATE SKIP LOCKED`
      )
      processed = rows.length
      for (const item of rows) {
        const decision = evaluateGreylistQueueItem({
          attempts: item.attempts,
          maxAttempts: GREYLIST_MAX_ATTEMPTS,
        })
        if (decision.action === 'give_up') {
          // Atomic give-up: UPDATE companies + DELETE queue row in the
          // same tx as the SELECT lock so a crash mid-pair re-processes
          // cleanly on next tick (no orphaned queue row + missing
          // companies update).
          await client.query(
            `UPDATE companies SET email_verification = COALESCE(email_verification,'{}'::jsonb)
                                                       || jsonb_build_object('greylist_persistent', true,
                                                                              'greylist_attempts', $2)
              WHERE ico=$1`, [item.ico, item.attempts]
          ).catch(() => {})
          await client.query(`DELETE FROM email_verify_queue WHERE id=$1`, [item.id])
          gaveUp++
          continue
        }
        // Claim the row by pushing retry_at into the future through the
        // lock-holding client in THIS transaction, then verify it AFTER we
        // COMMIT (releasing the lock). runVerifyAndPersist → enqueueGreylistRetry
        // mutates this SAME row (INSERT…ON CONFLICT / DELETE) on a SEPARATE pool
        // connection; doing that while we still held FOR UPDATE here self-
        // deadlocked (lock-holder idle-in-tx, the pool query blocked forever on
        // the row lock). The claim keeps a concurrent BFF instance from
        // re-picking the row meanwhile; enqueueGreylistRetry overwrites retry_at
        // / DELETEs the row afterwards.
        await client.query(
          `UPDATE email_verify_queue
              SET retry_at = now() + interval '${GREYLIST_QUEUE_CLAIM_MINUTES} minutes'
            WHERE id=$1`,
          [item.id]
        )
        toVerify.push(item)
      }
      await client.query('COMMIT')
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    // Verify OUTSIDE the row lock — enqueueGreylistRetry now mutates the queue
    // row on a pool connection with no conflicting lock held (no self-deadlock).
    for (const item of toVerify) {
      try {
        const r = await runVerifyAndPersist(item.ico, item.email, 'greylist_retry')
        if (r?.smtp_valid != null) resolved++
      } catch (e) {
        console.error(`[cron] greylist-retry ${item.id}:`, e.message)
      }
    }
    console.log(`[cron] runGreylistRetryCron done — ${processed} processed, ${resolved} resolved, ${gaveUp} gave up`)

    // ── Part 2: mailbox-level greylisting (451 SMTP deferral) ─────────
    // Find mailboxes with an unresolved greylist_detected alert that is ≥30 min old.
    await runMailboxGreylistRetryCron(pool, { evaluateMailboxGreylistResult, isGreylisted })
  } catch (e) {
    console.error('[cron] runGreylistRetryCron error:', e.message)
  }
}

/**
 * runMailboxGreylistRetryCron — inner helper called by runGreylistRetryCron.
 * Not exported (not scheduled independently).
 */
async function runMailboxGreylistRetryCron(pool, { evaluateMailboxGreylistResult, isGreylisted }) {
  try {
    const { rows: greylistMbs } = await pool.query(`
      SELECT DISTINCT ON (mailbox_id) mailbox_id, id AS alert_id
      FROM mailbox_alerts
      WHERE type = 'greylist_detected'
        AND resolved_at IS NULL
        AND created_at < now() - interval '${MAILBOX_GREYLIST_RETRY_MINUTES} minutes'
      ORDER BY mailbox_id, created_at DESC
    `)
    if (!greylistMbs.length) return
    console.log(`[cron] mailbox-greylist-retry: ${greylistMbs.length} mailbox(es) eligible`)
    const base = `http://localhost:${process.env.PORT || 18001}`
    let cleared = 0, persisted = 0
    for (const { mailbox_id, alert_id } of greylistMbs) {
      try {
        const r = await fetch(`${base}/api/mailboxes/${mailbox_id}/full-check?force=1`,
          { headers: { 'x-api-key': process.env.OUTREACH_API_KEY || '' } })
        if (!r.ok) {
          // HTTP error from BFF itself — push created_at into the FUTURE so we
          // re-qualify ~1h later (gate + push ≈ 2× MAILBOX_GREYLIST_RETRY_MINUTES),
          // not after ~1 minute like the old `now() - 29 minutes`.
          await pool.query(
            `UPDATE mailbox_alerts SET created_at = now() + interval '${MAILBOX_GREYLIST_RETRY_MINUTES} minutes'
             WHERE id = $1`,
            [alert_id]
          ).catch(() => {})
          continue
        }
        const check = await r.json()
        // BF-A2 — pure-fn decision; tests in campaign-greylist.test.js
        const decision = evaluateMailboxGreylistResult(check.checks?.smtp, isGreylisted)
        if (decision.action === 'clear') {
          await pool.query(
            `UPDATE mailbox_alerts SET resolved_at = now() WHERE id = $1`,
            [alert_id]
          )
          cleared++
          console.log(`[cron] mailbox-greylist-retry: mailbox ${mailbox_id} — 451 cleared, alert resolved`)
        } else if (decision.action === 'resolve_other') {
          await pool.query(
            `UPDATE mailbox_alerts SET resolved_at = now() WHERE id = $1`,
            [alert_id]
          )
          console.log(`[cron] mailbox-greylist-retry: mailbox ${mailbox_id} — non-greylist failure, alert resolved, automation will evaluate`)
        } else {
          // still_greylisted — push created_at into the FUTURE so we re-qualify
          // ~1h later (true spacing). The old `now() - 29 minutes` re-qualified
          // after ~1 minute → ~6× more SMTP probes against a greylisting host.
          await pool.query(
            `UPDATE mailbox_alerts SET created_at = now() + interval '${MAILBOX_GREYLIST_RETRY_MINUTES} minutes'
             WHERE id = $1`,
            [alert_id]
          )
          persisted++
          console.log(`[cron] mailbox-greylist-retry: mailbox ${mailbox_id} — still greylisted, retry in 1h`)
        }
      } catch (e) {
        console.error(`[cron] mailbox-greylist-retry ${mailbox_id}:`, e.message)
      }
    }
    console.log(`[cron] mailbox-greylist-retry done — ${greylistMbs.length} checked, ${cleared} cleared, ${persisted} still pending`)
  } catch (e) {
    console.error('[cron] runMailboxGreylistRetryCron error:', e.message)
  }
}
