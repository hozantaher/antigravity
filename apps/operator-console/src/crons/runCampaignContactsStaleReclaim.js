// AV-F9 — Stale in_flight reclaim cron.
//
// `campaign_contacts.status='in_flight'` is a short-lived lease the Go
// sender daemon holds while submitting one SMTP send per contact. The
// lease should resolve within seconds (one SMTP submission). When the
// daemon crashes, OOMs, or is killed mid-batch without graceful
// shutdown, the in_flight rows are never returned to 'pending' and
// the contact-pool shrinks silently.
//
// Incident (2026-05-13): sender daemon claimed ~22.5k contacts on
// campaign 457 → in_flight; daemon stopped mid-iteration; rows sat
// in_flight for 7 days while sender kept picking from a smaller pool
// and skipping no-MX entries. Operator released them manually via
// psql on 2026-05-20 (operator_audit_log
// action='campaign_contacts_zombie_release').
//
// This cron is the safety net that prevents recurrence regardless of
// the daemon's failure mode (crash / OOM / SIGKILL / Railway
// redeploy / network partition).
//
// Strategy:
//   - SELECT/UPDATE in_flight rows whose updated_at is older than
//     STALE_THRESHOLD_INTERVAL ("1 hour") back to 'pending'.
//   - Append release metadata to the details jsonb so post-mortems can
//     identify zombie releases vs. organic transitions.
//   - LIMIT 5000 per tick — guards against runaway UPDATE if a bug
//     ever generates millions of in_flight rows. Cron just runs again
//     on the next tick (10 minutes).
//   - One audit_log row per distinct campaign_id (not per contact —
//     low-stakes bulk reclaim, would otherwise spam the table).
//   - If a single tick reclaims >= ALERT_THRESHOLD contacts, also
//     insert a mailbox_alerts row (mailbox_id=NULL, system-wide
//     warning) so the operator sees recent daemon crash signal.
//
// HARD rules followed:
//   - feedback_no_magic_thresholds T0 — STALE_THRESHOLD_INTERVAL,
//     RECLAIM_BATCH_LIMIT, ALERT_THRESHOLD all named constants.
//   - feedback_audit_log_on_mutations T0 — every reclaim batch
//     INSERTs operator_audit_log, one row per campaign.
//   - feedback_schema_verify_before_sql T0 — columns verified
//     2026-05-20 against PROD via `\d campaign_contacts` +
//     `\d operator_audit_log` + `\d mailbox_alerts`. campaign_contacts
//     has: id, campaign_id, contact_id, current_step, next_send_at,
//     status, details (jsonb), created_at, updated_at, priority.
//     operator_audit_log has: id, action, actor, created_at, details
//     (jsonb), entity_id, entity_type. mailbox_alerts has: id,
//     created_at, mailbox_id, message, resolved_at, severity, type.

// Exactly-once send-claim coupling (migration 171): a contact reset from a
// stuck in_flight lease must also have its 'claiming' send-claim expired,
// else the stale claim blocks the next send attempt forever.
import { expireClaimsForContacts } from '../lib/sendClaim.js'

// ── Named tuning constants (no magic numbers) ────────────────────────────────
//
// Lease lifetime is measured in seconds for the happy path (one SMTP
// submission per contact). >1 hour is unambiguously a daemon failure.
export const STALE_THRESHOLD_INTERVAL = '1 hour'

// Per-tick UPDATE cap. If reality ever produces more zombie rows than
// this, we still process 5000 per 10-min tick (~30k/h reclaim
// throughput) — fast enough to recover from the 22.5k incident in 5
// ticks.
export const RECLAIM_BATCH_LIMIT = 5000

// Threshold for emitting a mailbox_alerts row. A single tick
// reclaiming this many contacts almost certainly means the daemon
// crashed recently (organic in_flight churn within 10 min would be
// far smaller). Operator should review sender logs.
export const ALERT_THRESHOLD = 100

// Cron cadence — 10 min keeps zombie lifetime short without DB churn.
// Used by server.js scheduleCron wiring.
export const RECLAIM_CRON_INTERVAL_MS = 10 * 60 * 1000

/**
 * Reclaim contacts whose sender-daemon lease has gone stale.
 *
 * @param {import('pg').Pool} pool
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{
 *   rows_released: number,
 *   by_campaign: Record<string, number>,
 *   alert_emitted: boolean,
 *   duration_ms: number,
 *   error?: string,
 * }>}
 */
export async function runCampaignContactsStaleReclaim(pool, options = {}) {
  const t0 = Date.now()
  const { now: _now = new Date() } = options  // reserved — currently uses NOW()
  void _now

  let rows_released = 0
  const by_campaign = {}
  let alert_emitted = false

  try {
    // 1. Reclaim stale leases back to 'pending'.
    //
    // The WHERE clause guards:
    //   - status='in_flight'   → idempotent vs. rows that already
    //     transitioned (sent / failed / pending).
    //   - updated_at < threshold → don't fight the daemon for fresh
    //     leases it actually holds.
    //
    // The details jsonb append uses COALESCE to handle rows where
    // details is NULL — we never want a single bad row to abort the
    // batch.
    const { rows: released } = await pool.query(
      `
      WITH stale AS (
        SELECT id
          FROM campaign_contacts
         WHERE status = 'in_flight'
           AND updated_at < NOW() - ($1)::interval
         ORDER BY updated_at ASC
         LIMIT $2
      )
      UPDATE campaign_contacts cc
         SET status     = 'pending',
             updated_at = NOW(),
             details    = COALESCE(cc.details, '{}'::jsonb) || jsonb_build_object(
               'released_from_in_flight_at', NOW(),
               'released_reason', 'av_f9_stale_lease',
               'released_by_cron', true
             )
        FROM stale
       WHERE cc.id = stale.id
      RETURNING cc.id, cc.campaign_id, cc.contact_id
      `,
      [STALE_THRESHOLD_INTERVAL, RECLAIM_BATCH_LIMIT],
    )

    rows_released = released.length

    // 1b. Couple the send-claim ledger (migration 171): expire the 'claiming'
    //     claims of the contacts we just reset, so they become re-claimable on
    //     the next send tick. Best-effort — a failure here must not abort the
    //     reclaim's audit/alert bookkeeping below.
    if (rows_released > 0) {
      try {
        const claimsExpired = await expireClaimsForContacts(pool, released)
        if (claimsExpired > 0) {
          console.log(`[av-f9] expired ${claimsExpired} stale send-claims for reclaimed contacts`)
        }
      } catch (e) {
        console.warn(`[av-f9] expire send-claims failed: ${e && e.message ? e.message : e}`)
      }
    }

    // 2. Tally per-campaign for audit + alerting.
    for (const row of released) {
      const key = String(row.campaign_id ?? 'null')
      by_campaign[key] = (by_campaign[key] || 0) + 1
    }

    // 3. Write one audit_log row per distinct campaign (not per
    //    contact). Aggregated counts are sufficient for incident
    //    post-mortems — per-row provenance lives in
    //    campaign_contacts.details (released_from_in_flight_at).
    if (rows_released > 0) {
      for (const [campaignKey, count] of Object.entries(by_campaign)) {
        const entityId = campaignKey === 'null' ? null : Number(campaignKey)
        await pool.query(
          `INSERT INTO operator_audit_log
             (action, actor, entity_type, entity_id, details)
           VALUES
             ($1, $2, $3, $4, $5::jsonb)`,
          [
            'campaign_contacts_zombie_release_cron',
            'cron:runCampaignContactsStaleReclaim',
            'campaigns',
            entityId,
            JSON.stringify({
              campaign_id: entityId,
              rows_released: count,
              stale_threshold: STALE_THRESHOLD_INTERVAL,
              reclaim_batch_limit: RECLAIM_BATCH_LIMIT,
              released_reason: 'av_f9_stale_lease',
            }),
          ],
        )
      }
    }

    // 4. System-wide warn alert when a single tick reclaims a lot.
    //    A burst this size means the daemon crashed within the last
    //    ~ STALE_THRESHOLD_INTERVAL and the operator should look at
    //    sender logs / Sentry.
    if (rows_released >= ALERT_THRESHOLD) {
      const topCampaigns = Object.entries(by_campaign)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([id, count]) => `${id}:${count}`)
        .join(' ')
      const message =
        `zombie_in_flight: reclaimed ${rows_released} contacts in one tick ` +
        `(threshold=${ALERT_THRESHOLD}); top campaigns=${topCampaigns}; ` +
        `likely sender daemon crash within last ${STALE_THRESHOLD_INTERVAL}`
      await pool.query(
        `INSERT INTO mailbox_alerts (mailbox_id, type, severity, message)
         VALUES (NULL, 'zombie_in_flight', 'warn', $1)`,
        [message],
      )
      alert_emitted = true
    }
  } catch (e) {
    // Fail-soft — cron resilience. A transient DB error must not
    // crash the BFF scheduler; the next tick (10 min) will retry.
    const message = e && e.message ? e.message : String(e)
    console.error(`[cron] runCampaignContactsStaleReclaim error: ${message}`)
    return {
      rows_released: 0,
      by_campaign: {},
      alert_emitted: false,
      duration_ms: Date.now() - t0,
      error: message,
    }
  }

  const duration_ms = Date.now() - t0
  if (rows_released > 0) {
    console.log(
      `[av-f9] reclaimed ${rows_released} in_flight contacts:`,
      by_campaign,
    )
  }

  return {
    rows_released,
    by_campaign,
    alert_emitted,
    duration_ms,
  }
}
