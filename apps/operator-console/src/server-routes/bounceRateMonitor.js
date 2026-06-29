// AR11 — Bounce rate auto-pause cron
//
// Monitors send_events for per-mailbox bounce rates in the last 24h.
// Auto-pauses mailboxes whose bounce rate >= 5% with a minimum sample of 10 sends.
// Already-paused mailboxes are not re-paused (no double-flip).
//
// Bounce categorisation (P1.8 Fix):
//   hard_bounces  — status='bounced' (5xx permanent SMTP failure: 550, 551, 553, 554)
//   soft_bounces  — status='failed' where smtp_response starts with '4'
//                   (4xx transient: 421, 450, 451, 452 — greylisting, retry-eligible)
//                   Soft bounces that exhaust retries land in status='failed'.
//
// AR11 detection fires on: (hard_bounces + soft_excessive) / total >= 0.05
// so excessive soft bounces (infrastructure / greylisting issues) also trigger.
//
// Sentry alert fired on each auto-pause (security: requires Sentry to be
// available; falls back silently — HARD RULE feedback_no_extra_monitoring:
// only Sentry, no Better Stack/Slack etc).

/**
 * Run the bounce rate monitor for one tick.
 *
 * @param {import('pg').Pool} pool
 * @param {{ Sentry?: object }} [deps]
 * @returns {Promise<{paused: number, checked: number}>}
 */
export async function runBounceRateMonitorCron(pool, deps = {}) {
  const { Sentry } = deps

  // AR11 P1.8: Split hard (5xx permanent) vs soft (4xx transient) bounces.
  // hard_bounces: status='bounced' — relay already classified as permanent failure.
  // soft_bounces: status='failed' with smtp_response starting with '4' — greylisting
  //               or temporary host rejection that exhausted retry budget.
  // Both types damage sender reputation; combined rate triggers auto-pause.
  const { rows } = await pool.query(`
    WITH recent AS (
      SELECT
        mailbox_used,
        count(*) FILTER (WHERE status = 'bounced')                                        AS hard_bounces,
        count(*) FILTER (WHERE status = 'failed' AND smtp_response ~ '^4')                AS soft_bounces,
        count(*)                                                                           AS total
      FROM send_events
      WHERE sent_at > NOW() - INTERVAL '24 hours'
      GROUP BY mailbox_used
      HAVING count(*) >= 10
    )
    SELECT
      mailbox_used,
      hard_bounces,
      soft_bounces,
      (hard_bounces + soft_bounces)                               AS bounces,
      total,
      ((hard_bounces + soft_bounces)::float / total)              AS rate
    FROM recent
    WHERE (hard_bounces + soft_bounces)::float / total >= 0.05
  `)

  let paused = 0
  for (const r of rows) {
    const ratePct = (r.rate * 100).toFixed(1)
    const reason = `bounce_rate_${ratePct}pct (${r.hard_bounces} hard + ${r.soft_bounces} soft = ${r.bounces}/${r.total} in 24h)`

    // Pause + audit row in one tx (HARD: feedback_audit_log_on_mutations) — an
    // operator-visible status flip must never commit without a matching trail.
    const client = await pool.connect()
    let pausedId = null
    try {
      await client.query('BEGIN')
      const { rows: updatedRows } = await client.query(
        `UPDATE outreach_mailboxes
            SET status = 'paused',
                status_reason = $2,
                updated_at = NOW()
          WHERE from_address = $1
            AND status = 'active'
          RETURNING id`,
        [r.mailbox_used, reason],
      )
      if (updatedRows.length > 0) {
        pausedId = updatedRows[0].id
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('mailbox_bounce_autopause', 'cron:runBounceRateMonitorCron', 'mailbox', $1, $2::jsonb)`,
          [String(pausedId), JSON.stringify({
            from_address: r.mailbox_used,
            reason,
            rate: r.rate,
            hard_bounces: Number(r.hard_bounces),
            soft_bounces: Number(r.soft_bounces),
            total: Number(r.total),
          })],
        )
      }
      await client.query('COMMIT')
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      console.warn('[AR11] bounce autopause tx failed (rolled back):', txErr.message)
      pausedId = null
    } finally {
      client.release()
    }

    if (pausedId != null) {
      paused++
      // Redact: only log the local-part initial + domain, not full address
      const redacted = r.mailbox_used.replace(/^([^@]{1,3})[^@]*/, '$1…')
      console.warn(
        `[AR11] mailbox_bounce_rate_high mailbox=${redacted} rate=${r.rate} hard=${r.hard_bounces} soft=${r.soft_bounces} reason=${reason}`,
      )
      try {
        Sentry?.captureMessage(
          `mailbox_bounce_rate_high mailbox=${r.mailbox_used.split('@')[0]} rate=${r.rate} hard=${r.hard_bounces} soft=${r.soft_bounces}`,
          'error',
        )
      } catch (_) { /* Sentry best-effort */ }
    }
  }

  return { paused, checked: rows.length }
}

/**
 * Mount AR11 status endpoint onto an Express router.
 * Exposes GET /api/bounce-rate-monitor/status for operator visibility.
 *
 * @param {import('express').Router} router
 * @param {import('pg').Pool} pool
 */
export function mountBounceRateMonitor(router, pool) {
  router.get('/api/bounce-rate-monitor/status', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        WITH recent AS (
          SELECT
            mailbox_used,
            count(*) FILTER (WHERE status = 'bounced')                          AS hard_bounces,
            count(*) FILTER (WHERE status = 'failed' AND smtp_response ~ '^4')  AS soft_bounces,
            count(*)                                                              AS total
          FROM send_events
          WHERE sent_at > NOW() - INTERVAL '24 hours'
          GROUP BY mailbox_used
          HAVING count(*) >= 10
        )
        SELECT
          mailbox_used,
          hard_bounces,
          soft_bounces,
          (hard_bounces + soft_bounces)                                   AS bounces,
          total,
          round(((hard_bounces + soft_bounces)::float / total * 100)::numeric, 1) AS rate_pct
        FROM recent
        ORDER BY rate_pct DESC
        LIMIT 20
      `)
      res.json({ ok: true, mailboxes: rows })
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message })
    }
  })
}
