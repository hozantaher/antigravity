import { formatDailyReport } from '../lib/automation.js'

/**
 * runDailyReportCron — send daily mailbox health report email at 07:00.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {Function} deps.smtpSendWithFallback — server.js-local async helper
 */
export async function runDailyReportCron(pool, { smtpSendWithFallback }) {
  console.log('[cron] runDailyReportCron start')
  try {
    const { rows: cfg } = await pool.query(
      `SELECT key, value FROM outreach_config WHERE key IN ('report_recipient_email','report_mailbox_id')`
    )
    const cfgMap = Object.fromEntries(cfg.map(r => [r.key, r.value]))
    if (!cfgMap.report_recipient_email) {
      console.log('[cron] daily report skipped: report_recipient_email not configured')
      return
    }

    const { rows: mailboxes } = await pool.query(`
      SELECT m.from_address AS email, m.status, c.score, c.critical
      FROM outreach_mailboxes m
      LEFT JOIN mailbox_check_cache c ON c.mailbox_id=m.id
      WHERE m.status NOT IN ('retired')
    `)

    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Prague' })
    const { subject, text } = formatDailyReport(mailboxes.map(m => ({
      email: m.email, status: m.status, score: m.score, critical: m.critical || [],
    })), date)

    // Sprint AO6: query no longer filters by proxy_url IS NOT NULL — relay handles routing.
    const mbId = cfgMap.report_mailbox_id
    const { rows: senderRows } = await pool.query(
      mbId
        ? `SELECT id, from_address AS email, smtp_host AS host, smtp_port AS port,
                  smtp_username, password, COALESCE(preferred_country,'') AS preferred_country
           FROM outreach_mailboxes WHERE id=$1 AND status='active'`
        : `SELECT id, from_address AS email, smtp_host AS host, smtp_port AS port,
                  smtp_username, password, COALESCE(preferred_country,'') AS preferred_country
           FROM outreach_mailboxes WHERE status='active' LIMIT 1`,
      mbId ? [mbId] : []
    )
    if (!senderRows.length) { console.log('[cron] daily report skipped: no active sender'); return }
    const s = senderRows[0]

    await smtpSendWithFallback(mbId ? Number(mbId) : Number(s.id), {
      host: s.host, port: s.port,
      username: s.smtp_username || s.email,
      password: s.password,
      from: s.email, to: cfgMap.report_recipient_email,
      subject, text,
      preferredCountry: s.preferred_country,
    })
    console.log('[cron] daily report sent to report_recipient_email')  // address redacted per PII policy
  } catch (e) {
    console.error('[cron] runDailyReportCron error:', e.message)
  }
}
