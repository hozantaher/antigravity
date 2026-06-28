/**
 * runStaleHealthCheckCron — sweep mailboxes with stale check-cache and trigger full-check.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *
 * Note: the AP3 full_check rate limit (2/hour, OP_RATE_CAPS) is enforced solely
 * by the `/full-check?force=1` endpoint via checkAndRecord. We intentionally do
 * NOT pre-check here: the previous pre-check called checkAndRecord (which
 * RECORDS a token) and the endpoint recorded a second time, burning 2 of the
 * 2/hour budget per real check → only ~1 effective check/hour. The endpoint
 * returns HTTP 429 (no token consumed when over cap) which we surface below.
 */
export async function runStaleHealthCheckCron(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT m.id FROM outreach_mailboxes m
       LEFT JOIN mailbox_check_cache c ON c.mailbox_id=m.id
       WHERE m.status NOT IN ('retired')
         AND (c.checked_at IS NULL OR c.checked_at < now() - interval '90 seconds')
       ORDER BY m.id
       LIMIT 8`
    )
    if (rows.length === 0) return
    const base = `http://localhost:${process.env.PORT || 18001}`
    await Promise.all(rows.map(row =>
      fetch(`${base}/api/mailboxes/${row.id}/full-check?force=1`)
        .then(r => {
          // 429 = endpoint-enforced AP3 cap; no token consumed, retry next sweep.
          if (r.status === 429) {
            console.log(`[cron] stale-refresh mailbox ${row.id}: full_check rate-limited (429) — skip`)
          }
        })
        .catch(e => console.warn(`[cron] stale-refresh ${row.id}:`, e.message))
    ))
  } catch (e) {
    console.error('[cron] runStaleHealthCheckCron error:', e.message)
  }
}
