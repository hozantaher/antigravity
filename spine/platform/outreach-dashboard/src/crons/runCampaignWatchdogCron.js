/**
 * runCampaignWatchdogCron — auto-pause campaigns with bounce > 5% or log low-reply-rate.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.logHealing — server.js-local async helper
 */
export async function runCampaignWatchdogCron(pool, { logHealing }) {
  console.log('[cron] runCampaignWatchdogCron start')
  try {
    const { rows: campaigns } = await pool.query(
      `SELECT id, name, status FROM campaigns WHERE status IN ('active','running')`
    )
    for (const camp of campaigns) {
      try {
        const { rows: [agg] } = await pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status='sent')::int    AS sent,
            COUNT(*) FILTER (WHERE status='bounced')::int AS bounced,
            COUNT(*) FILTER (WHERE status='replied')::int AS replied
          FROM send_events WHERE campaign_id=$1
        `, [camp.id])

        const sent    = agg?.sent    || 0
        const bounced = agg?.bounced || 0
        const replied = agg?.replied || 0

        if (sent < 10) continue  // not enough data yet

        const bounceRate = bounced / sent
        const replyRate  = replied / sent

        if (bounceRate > 0.05) {
          await pool.query(`UPDATE campaigns SET status='paused' WHERE id=$1`, [camp.id])
          await logHealing('campaign', camp.id, camp.name, 'auto_pause',
            `bounce rate ${(bounceRate * 100).toFixed(1)}% > 5% threshold (${bounced}/${sent} sent)`)
          console.log(`[watchdog] campaign ${camp.id} "${camp.name}" paused: bounce ${(bounceRate*100).toFixed(1)}%`)
        } else if (sent >= 50 && replyRate < 0.005) {
          await logHealing('campaign', camp.id, camp.name, 'low_performance',
            `reply rate ${(replyRate * 100).toFixed(2)}% after ${sent} sends — consider reviewing template`)
          console.log(`[watchdog] campaign ${camp.id} "${camp.name}" flagged: low reply rate ${(replyRate*100).toFixed(2)}%`)
        }
      } catch (e) {
        console.error(`[watchdog] campaign ${camp.id}:`, e.message)
      }
    }
    console.log(`[cron] runCampaignWatchdogCron done — checked ${campaigns.length} active campaigns`)
  } catch (e) {
    console.error('[cron] runCampaignWatchdogCron error:', e.message)
  }
}
