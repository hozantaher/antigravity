import { classifyBounceHealth } from '../lib/mailboxUtils.js'
import { shouldAdvanceWarmup, warmupDayToCap } from '../lib/automation.js'

/**
 * runWarmupAdvanceCron — advance mailbox warmup day counter and cap daily at 05:00.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runWarmupAdvanceCron(pool) {
  console.log('[cron] runWarmupAdvanceCron start')
  try {
    const { rows } = await pool.query(`
      SELECT m.id, m.from_address, m.total_sent, m.total_bounced, m.consecutive_bounces,
             w.warmup_day, w.last_advanced_at
      FROM outreach_mailboxes m
      JOIN mailbox_warmup w ON w.mailbox_address=m.from_address
      WHERE m.status='active'
        AND w.is_paused=false
        AND w.warmup_day IS NOT NULL
        AND (w.last_advanced_at IS NULL OR
             (w.last_advanced_at AT TIME ZONE 'Europe/Prague')::date
              < (now() AT TIME ZONE 'Europe/Prague')::date)
    `)
    for (const row of rows) {
      try {
        const { rows: cacheRows } = await pool.query(
          `SELECT checks FROM mailbox_check_cache WHERE mailbox_id=$1 AND checked_at > now() - interval '6 hours'`,
          [row.id]
        )
        const smtpOk = cacheRows[0]?.checks?.smtp?.ok === true
        const ts = Number(row.total_sent || 0), tb = Number(row.total_bounced || 0)
        const bounceRate = ts > 0 ? (tb / ts) * 100 : null
        const bounceClass = classifyBounceHealth(bounceRate, Number(row.consecutive_bounces || 0))

        if (!shouldAdvanceWarmup({ smtpOk, bounceRate, consecutiveBounces: Number(row.consecutive_bounces || 0), bounceClass })) {
          if (!smtpOk) { console.log(`[cron] warmup skip ${row.id}: smtp not ok`); continue }
          // shouldPauseWarmup triggered — pause warmup
          await pool.query(
            `UPDATE mailbox_warmup SET is_paused=true, pause_reason='auto: bounce threshold'
             WHERE mailbox_address=$1`, [row.from_address]
          )
          console.log(`[cron] warmup paused ${row.id} (bounce=${bounceClass})`)
          continue
        }

        await pool.query(
          `UPDATE mailbox_warmup SET warmup_day=warmup_day+1, last_advanced_at=now()
           WHERE mailbox_address=$1`, [row.from_address]
        )
        const newDay = row.warmup_day + 1
        const newCap = warmupDayToCap(newDay)
        await pool.query(
          `UPDATE outreach_mailboxes SET daily_cap_override=$1 WHERE id=$2`,
          [newCap, row.id]
        )
        console.log(`[warmup] mailbox ${row.id} → day ${newDay}, cap ${newCap}`)
      } catch (e) {
        console.error(`[cron] warmup-advance ${row.id}:`, e.message)
      }
    }
    // Auto-restart warmups that were auto-paused and bounce rate has recovered
    const { rows: pausedWarmups } = await pool.query(`
      SELECT m.id, m.from_address, m.total_sent, m.total_bounced, m.consecutive_bounces
      FROM outreach_mailboxes m
      JOIN mailbox_warmup w ON w.mailbox_address=m.from_address
      WHERE m.status='active'
        AND w.is_paused=true
        AND w.pause_reason LIKE 'auto:%'
    `)
    for (const row of pausedWarmups) {
      try {
        const ts = Number(row.total_sent || 0), tb = Number(row.total_bounced || 0)
        const bounceRate = ts > 0 ? (tb / ts) * 100 : null
        const bounceClass = classifyBounceHealth(bounceRate, Number(row.consecutive_bounces || 0))
        const bounceRecovered = (!bounceRate || bounceRate < 3) && Number(row.consecutive_bounces || 0) === 0 && bounceClass === 'ok'
        if (bounceRecovered) {
          await pool.query(
            `UPDATE mailbox_warmup SET is_paused=false, pause_reason=NULL WHERE mailbox_address=$1`,
            [row.from_address]
          )
          console.log(`[cron] warmup auto-restarted mailbox ${row.id} (bounce recovered)`)
        }
      } catch (e) {
        console.error(`[cron] warmup-auto-restart ${row.id}:`, e.message)
      }
    }
    console.log(`[cron] runWarmupAdvanceCron done — processed ${rows.length} mailboxes`)
  } catch (e) {
    console.error('[cron] runWarmupAdvanceCron error:', e.message)
  }
}
