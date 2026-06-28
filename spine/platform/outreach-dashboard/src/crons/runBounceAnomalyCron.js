// AV-F8 — Bounce anomaly detection + auto-pause cron.
//
// Two-dimensional defense:
//   1. Per-mailbox 24h bounce rate > MAILBOX_BOUNCE_THRESHOLD_PCT (5 %)
//      → set status='paused', paused_until=NOW()+PAUSE_DURATION_HOURS,
//        emit mailbox_alerts row + operator_audit_log.
//   2. Per-domain 7d bounce rate > DOMAIN_BOUNCE_THRESHOLD_PCT (20 %)
//      → INSERT outreach_suppressions(domain, reason='auto_bounce_anomaly_<pct>'),
//        emit operator_audit_log.
//
// Differentiator vs. existing runBounceRateMonitorCron / runMailboxBounceThrottleCron:
//   - explicit paused_until (cron does not auto-resume; operator decides)
//   - 12h cooldown via last_bounce_alert_at (no re-fire storm)
//   - domain-level auto-suppression (sender-reputation protection beyond mailbox)
//
// HARD RULES followed:
//   - feedback_no_magic_thresholds T0: all numbers named constants below
//   - feedback_audit_log_on_mutations T0: every UPDATE / INSERT writes operator_audit_log
//   - feedback_schema_verify_before_sql T0: columns verified 2026-05-19 against PROD
//     (paused_until + last_bounce_alert_at added in migration 124)
//
// Schema citations (verified 2026-05-19):
//   send_events:           status, mailbox_used, sent_at, contact_id
//   outreach_mailboxes:    id, from_address, status, paused_until, last_bounce_alert_at,
//                          status_reason
//   contacts:              id, email
//   outreach_suppressions: domain, email, reason  (no created_at / added_at column)
//   mailbox_alerts:        mailbox_id, type, severity, message, resolved_at
//   operator_audit_log:    action, actor, entity_type, entity_id, details (jsonb)

// ── Named thresholds (no magic numbers — feedback_no_magic_thresholds T0) ─────
export const MAILBOX_BOUNCE_THRESHOLD_PCT = 5     // auto-pause trigger
export const MAILBOX_BOUNCE_MIN_SENDS = 20        // sample-size floor for mailbox tier
export const DOMAIN_BOUNCE_THRESHOLD_PCT = 20     // auto-suppress trigger
export const DOMAIN_BOUNCE_MIN_SENDS = 5          // sample-size floor for domain tier
export const PAUSE_DURATION_HOURS = 24            // paused_until = NOW() + this
export const COOLDOWN_HOURS = 12                  // skip re-pause within this window
export const MAILBOX_WINDOW_HOURS = 24            // SELECT window for mailbox tier
export const DOMAIN_WINDOW_DAYS = 7               // SELECT window for domain tier

/**
 * Compute per-mailbox bounce stats over the last MAILBOX_WINDOW_HOURS.
 * @param {import('pg').Pool} pool
 * @returns {Promise<Array<{ from_address: string, bounced: number, total: number, bounce_rate_pct: number }>>}
 */
async function computeMailboxBounceStats(pool) {
  const { rows } = await pool.query(
    `
    SELECT mailbox_used AS from_address,
           COUNT(*) FILTER (WHERE status='bounced')                                 AS bounced,
           COUNT(*) FILTER (WHERE status IN ('sent','queued','bounced','failed'))   AS total
      FROM send_events
     WHERE sent_at > NOW() - ($1 || ' hours')::interval
       AND mailbox_used IS NOT NULL
     GROUP BY mailbox_used
    HAVING COUNT(*) FILTER (WHERE status IN ('sent','queued','bounced','failed')) >= $2
    `,
    [String(MAILBOX_WINDOW_HOURS), MAILBOX_BOUNCE_MIN_SENDS],
  )
  return rows.map((r) => {
    const bounced = Number(r.bounced) || 0
    const total = Number(r.total) || 0
    const bounce_rate_pct = total > 0 ? (bounced / total) * 100 : 0
    return { from_address: r.from_address, bounced, total, bounce_rate_pct }
  })
}

/**
 * Compute per-domain bounce stats over the last DOMAIN_WINDOW_DAYS.
 * @param {import('pg').Pool} pool
 */
async function computeDomainBounceStats(pool) {
  const { rows } = await pool.query(
    `
    SELECT LOWER(SUBSTRING(c.email FROM '@(.*)$')) AS domain,
           COUNT(*) FILTER (WHERE s.status='bounced')                                 AS bounced,
           COUNT(*) FILTER (WHERE s.status IN ('sent','queued','bounced','failed'))   AS total
      FROM send_events s
      JOIN contacts c ON c.id = s.contact_id
     WHERE s.sent_at > NOW() - ($1 || ' days')::interval
       AND c.email IS NOT NULL
       AND POSITION('@' IN c.email) > 0
     GROUP BY domain
    HAVING COUNT(*) FILTER (WHERE s.status IN ('sent','queued','bounced','failed')) >= $2
    `,
    [String(DOMAIN_WINDOW_DAYS), DOMAIN_BOUNCE_MIN_SENDS],
  )
  return rows
    .map((r) => {
      const bounced = Number(r.bounced) || 0
      const total = Number(r.total) || 0
      const bounce_rate_pct = total > 0 ? (bounced / total) * 100 : 0
      return { domain: r.domain, bounced, total, bounce_rate_pct }
    })
    .filter((r) => r.domain && r.domain.length > 0)
}

/**
 * Auto-pause one mailbox if all guards pass.
 * Returns true when an UPDATE actually flipped the row.
 *
 * Guards (in order):
 *   1. Status must already be 'active' (UPDATE WHERE keeps idempotency).
 *   2. last_bounce_alert_at must be NULL or older than COOLDOWN_HOURS.
 *
 * @param {import('pg').Pool} pool
 * @param {{ from_address: string, bounced: number, total: number, bounce_rate_pct: number }} stat
 */
async function maybePauseMailbox(pool, stat) {
  const reason = `auto_bounce_anomaly: ${stat.bounce_rate_pct.toFixed(2)}% (${stat.bounced}/${stat.total} in ${MAILBOX_WINDOW_HOURS}h)`

  const { rows: updRows } = await pool.query(
    `
    UPDATE outreach_mailboxes
       SET status                = 'paused',
           paused_until          = NOW() + ($2 || ' hours')::interval,
           last_bounce_alert_at  = NOW(),
           status_reason         = $3,
           updated_at            = NOW()
     WHERE from_address          = $1
       AND status                = 'active'
       AND (last_bounce_alert_at IS NULL
            OR last_bounce_alert_at < NOW() - ($4 || ' hours')::interval)
     RETURNING id
    `,
    [stat.from_address, String(PAUSE_DURATION_HOURS), reason, String(COOLDOWN_HOURS)],
  )

  if (updRows.length === 0) return false
  const mailboxId = updRows[0].id

  // Insert mailbox_alerts row so Notifications surface picks it up.
  // mailbox_alerts.message is TEXT — encode structured payload as JSON for
  // operator readability; severity='critical' (sender-reputation risk).
  const alertMessage = `bounce_anomaly: rate=${stat.bounce_rate_pct.toFixed(2)}% sample=${stat.total} threshold=${MAILBOX_BOUNCE_THRESHOLD_PCT}% — paused for ${PAUSE_DURATION_HOURS}h`
  await pool.query(
    `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message)
     VALUES ($1, 'bounce_anomaly', 'critical', $2)`,
    [mailboxId, alertMessage],
  )

  // Audit log — every mutation (feedback_audit_log_on_mutations T0).
  await pool.query(
    `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
     VALUES ('mailbox_auto_paused_bounce_anomaly', 'cron:runBounceAnomalyCron', 'outreach_mailboxes', $1, $2::jsonb)`,
    [
      mailboxId,
      JSON.stringify({
        from_address: stat.from_address,
        bounce_rate_pct: Number(stat.bounce_rate_pct.toFixed(2)),
        bounced: stat.bounced,
        total: stat.total,
        threshold_pct: MAILBOX_BOUNCE_THRESHOLD_PCT,
        pause_duration_hours: PAUSE_DURATION_HOURS,
        window_hours: MAILBOX_WINDOW_HOURS,
      }),
    ],
  )
  return true
}

/**
 * Auto-suppress one domain if not already suppressed.
 * Idempotency: SELECT-then-INSERT (no unique index on domain column).
 *
 * @param {import('pg').Pool} pool
 * @param {{ domain: string, bounced: number, total: number, bounce_rate_pct: number }} stat
 */
async function maybeSuppressDomain(pool, stat) {
  // Idempotent check — outreach_suppressions has no UNIQUE on domain alone.
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM outreach_suppressions
      WHERE LOWER(domain) = $1
        AND reason LIKE 'auto_bounce_anomaly%'
      LIMIT 1`,
    [stat.domain],
  )
  if (existing.length > 0) return false

  const reason = `auto_bounce_anomaly_${stat.bounce_rate_pct.toFixed(0)}pct_${stat.total}sends`
  await pool.query(
    `INSERT INTO outreach_suppressions(domain, reason) VALUES ($1, $2)`,
    [stat.domain, reason],
  )

  await pool.query(
    `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
     VALUES ('domain_auto_suppressed_bounce_anomaly', 'cron:runBounceAnomalyCron', 'outreach_suppressions', NULL, $1::jsonb)`,
    [
      JSON.stringify({
        domain: stat.domain,
        bounce_rate_pct: Number(stat.bounce_rate_pct.toFixed(2)),
        bounced: stat.bounced,
        total: stat.total,
        threshold_pct: DOMAIN_BOUNCE_THRESHOLD_PCT,
        window_days: DOMAIN_WINDOW_DAYS,
      }),
    ],
  )
  return true
}

/**
 * One tick of the bounce anomaly detector.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{
 *   mailboxes_checked: number,
 *   mailboxes_paused: number,
 *   domains_checked: number,
 *   domains_suppressed: number,
 *   duration_ms: number
 * }>}
 */
export async function runBounceAnomalyCron(pool) {
  const t0 = Date.now()
  console.log('[cron] runBounceAnomalyCron start')

  let mailboxes_paused = 0
  let domains_suppressed = 0
  let mailboxes_checked = 0
  let domains_checked = 0

  try {
    // ── Mailbox tier ──────────────────────────────────────────────────────
    const mailboxStats = await computeMailboxBounceStats(pool)
    mailboxes_checked = mailboxStats.length
    for (const stat of mailboxStats) {
      if (stat.bounce_rate_pct <= MAILBOX_BOUNCE_THRESHOLD_PCT) continue
      try {
        const paused = await maybePauseMailbox(pool, stat)
        if (paused) {
          mailboxes_paused++
          // Redact: only local-part initial + domain.
          const redacted = (stat.from_address || '').replace(/^([^@]{1,3})[^@]*/, '$1…')
          console.warn(
            `[AV-F8] mailbox_paused mailbox=${redacted} rate=${stat.bounce_rate_pct.toFixed(2)}% sample=${stat.total}`,
          )
        }
      } catch (err) {
        console.error(`[AV-F8] maybePauseMailbox error for ${stat.from_address}: ${err.message}`)
      }
    }

    // ── Domain tier ───────────────────────────────────────────────────────
    const domainStats = await computeDomainBounceStats(pool)
    domains_checked = domainStats.length
    for (const stat of domainStats) {
      if (stat.bounce_rate_pct <= DOMAIN_BOUNCE_THRESHOLD_PCT) continue
      try {
        const suppressed = await maybeSuppressDomain(pool, stat)
        if (suppressed) {
          domains_suppressed++
          console.warn(
            `[AV-F8] domain_suppressed domain=${stat.domain} rate=${stat.bounce_rate_pct.toFixed(2)}% sample=${stat.total}`,
          )
        }
      } catch (err) {
        console.error(`[AV-F8] maybeSuppressDomain error for ${stat.domain}: ${err.message}`)
      }
    }
  } catch (e) {
    console.error('[cron] runBounceAnomalyCron error:', e.message)
  }

  const duration_ms = Date.now() - t0
  console.log(
    `[cron] runBounceAnomalyCron done duration_ms=${duration_ms} ` +
      `mailboxes_checked=${mailboxes_checked} mailboxes_paused=${mailboxes_paused} ` +
      `domains_checked=${domains_checked} domains_suppressed=${domains_suppressed}`,
  )

  return {
    mailboxes_checked,
    mailboxes_paused,
    domains_checked,
    domains_suppressed,
    duration_ms,
  }
}
