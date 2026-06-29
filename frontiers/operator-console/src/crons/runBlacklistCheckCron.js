import { checkBlacklist } from '../lib/blacklistCheck.js'

/**
 * runBlacklistCheckCron — S18: DNS-based DNSBL check for active production mailboxes.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 */
export async function runBlacklistCheckCron(pool) {
  console.log('[cron] runBlacklistCheckCron start')
  try {
    const { rows } = await pool.query(
      `SELECT id, from_address, smtp_host FROM outreach_mailboxes WHERE status = 'active' AND environment = 'production'`
    )
    let flagged = 0
    for (const mb of rows) {
      if (!mb.smtp_host) continue
      try {
        const result = await checkBlacklist(mb.smtp_host)
        if (result.listed) {
          flagged++
          const message = `Blacklist hit: ${result.hits.map(h => h.zone).join(', ')}`
          // Dedup: skip if an unresolved blacklist_hit alert was already raised in the last 24 hours
          await pool.query(`
            INSERT INTO mailbox_alerts (mailbox_id, type, severity, message)
            SELECT $1, 'blacklist_hit', 'critical', $2
            WHERE NOT EXISTS (
              SELECT 1 FROM mailbox_alerts
              WHERE mailbox_id = $1
                AND type = 'blacklist_hit'
                AND resolved_at IS NULL
                AND created_at > now() - interval '24 hours'
            )
          `, [mb.id, message])
          console.log(`[blacklist] mailbox ${mb.id} (${mb.from_address}) listed on: ${result.hits.map(h => h.zone).join(', ')}`)
        }
      } catch (e) {
        console.error(`[blacklist] mailbox ${mb.id}:`, e.message)
      }
    }
    console.log(`[cron] runBlacklistCheckCron done — checked ${rows.length}, flagged ${flagged}`)
  } catch (e) {
    console.error('[cron] runBlacklistCheckCron error:', e.message)
  }
}
