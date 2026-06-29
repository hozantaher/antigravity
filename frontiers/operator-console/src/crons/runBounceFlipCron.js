// Fixed recent lookback window scanned every run. Bounces flip status async
// (a DSN can arrive days after the send) WITHOUT touching send_events.sent_at,
// so a now()-based checkpoint that advances each run skips late bounces whose
// sent_at predates the checkpoint. We re-scan a fixed window instead and rely
// on the idempotent company UPDATE (the SELECT below already excludes companies
// whose email_status is already 'invalid'/'spamtrap', so re-scans are no-ops).
const BOUNCE_FLIP_LOOKBACK_DAYS = 30

/**
 * runBounceFlipCron — flip companies with hard-bounced email to email_status='invalid'.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runBounceFlipCron(pool) {
  console.log('[cron] runBounceFlipCron start')
  try {
    const { rows: bounced } = await pool.query(
      `SELECT DISTINCT ct.email
         FROM send_events se
         JOIN contacts ct ON ct.id = se.contact_id
        WHERE se.status='bounced'
          AND se.sent_at > now() - interval '${BOUNCE_FLIP_LOOKBACK_DAYS} days'
          AND ct.email IS NOT NULL`
    )
    let flipped = 0
    for (const b of bounced) {
      const email = b.email
      const { rows: cos } = await pool.query(
        `SELECT ico, email_status FROM companies
          WHERE LOWER(email)=LOWER($1)
            AND COALESCE(email_status,'unverified') NOT IN ('invalid','spamtrap')`,
        [email]
      )
      for (const co of cos) {
        const verification = { trigger: 'bounce', detail: 'Hard bounce z send pipeline', flipped_from: co.email_status }
        await pool.query(
          `UPDATE companies SET email_status='invalid', email_verified_at=now(), email_verification=$1 WHERE ico=$2`,
          [JSON.stringify(verification), co.ico]
        )
        await pool.query(
          `INSERT INTO email_verification_log(company_ico, email, old_status, new_status, detail, trigger, verification)
           VALUES($1,$2,$3,'invalid',$4,'bounce',$5)`,
          [co.ico, email, co.email_status, 'Hard bounce z send pipeline', JSON.stringify(verification)]
        ).catch(() => {})
        flipped++
      }
    }
    // No now()-based checkpoint advance: we deliberately re-scan the fixed
    // lookback window every run so late-arriving bounces (DSN after sent_at)
    // still flip. The company UPDATE is idempotent (already-invalid skipped).
    console.log(`[cron] runBounceFlipCron done — ${bounced.length} bounced emails, ${flipped} companies flipped`)
  } catch (e) {
    console.error('[cron] runBounceFlipCron error:', e.message)
  }
}
