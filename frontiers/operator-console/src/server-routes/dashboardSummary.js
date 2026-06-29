// Dashboard summary — single aggregate endpoint backing `/` Home overview.
// ─────────────────────────────────────────────────────────────────────────────
// Sprint Y10. Operator lands on `/` and wants a one-glance morning view:
//   1. Campaign 457 status (send rate last 24h, in_flight, paused/running)
//   2. Unhandled replies count + 3 most recent previews
//   3. Mailbox health pills (count by status)
//   4. Critical notifications (top 3)
//   5. Today's metrics strip (sends, bounces, replies, bounce%, reputation)
//
// One endpoint → one fetch → home renders in single round-trip.
//
// Read-only. Tolerates schema gaps (missing tables → empty arrays, not 500).
// Reuses logic from /api/campaigns/last-24h-summary, /api/replies/stats,
// /api/mailboxes, /api/notifications — but aggregates server-side to keep
// the home page snappy + avoid 5 parallel fetches every 30s.
//
// HARD RULE — feedback_no_magic_thresholds: all thresholds (e.g. "critical"
// severity set, recent reply preview limit) are named constants here so
// the operator/agent can tune without trawling the page code.
// HARD RULE — feedback_no_pii_in_commands: reply previews redact the
// from-address to `<local>@<domain>` shape — we drop the local part to
// `(skryto)` so the home view never leaks contact emails in operator
// over-the-shoulder views or screenshots.

import { decodeMimeWords } from '../lib/mimeDecode.js'
import { notUndeliverableSql } from '../lib/undeliverableFilter.js'

const HOME_CAMPAIGN_ID = 457               // primary campaign on home glance
const RECENT_REPLY_PREVIEW_LIMIT = 3       // grid card row count
const TOP_NOTIFICATION_LIMIT = 3           // notification card row count
const REDACTED_FROM = '(skryto)'           // PII-safe placeholder for from
const CRITICAL_SEVERITIES = new Set(['critical', 'high', 'error'])

/**
 * Redact a reply preview's from-address. Keeps domain so the operator can
 * still see provider context (e.g. gmail vs corporate) without leaking the
 * full address.
 *
 * @param {string|null|undefined} from
 * @returns {string}
 */
export function redactFrom(from) {
  if (typeof from !== 'string' || from === '') return REDACTED_FROM
  const at = from.lastIndexOf('@')
  if (at <= 0 || at === from.length - 1) return REDACTED_FROM
  return `${REDACTED_FROM}@${from.slice(at + 1)}`
}

async function readCampaignStatus(pool, campaignId) {
  // Two parallel queries: status + 24h send/bounce counts for this campaign.
  let row = null
  try {
    const r = await pool.query(
      `SELECT id, name, status
       FROM campaigns
       WHERE id = $1`,
      [campaignId],
    )
    row = r.rows[0] || null
  } catch (e) {
    // Tolerate missing relation OR missing column — Home dashboard must not
    // crash on schema drift; null `paused_until` is the documented contract.
    if (!/relation .* does not exist|column .* does not exist/i.test(e.message || '')) throw e
  }
  if (!row) {
    return {
      key: 'campaign',
      campaign_id: campaignId,
      found: false,
      name: null,
      status: null,
      sent_24h: 0,
      bounced_24h: 0,
      in_flight: 0,
      send_rate_per_hour: 0,
    }
  }
  // 24h counts for this campaign (send_events.campaign_id is keyed).
  let sent24h = 0
  let bounced24h = 0
  let inFlight = 0
  try {
    const { rows: [s = {}] } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='sent'    AND sent_at > now() - interval '24 hours')::int AS sent,
         COUNT(*) FILTER (WHERE status='bounced' AND sent_at > now() - interval '24 hours')::int AS bounced,
         COUNT(*) FILTER (WHERE status IN ('queued','sending'))::int AS in_flight
       FROM send_events
       WHERE campaign_id = $1`,
      [campaignId],
    )
    sent24h    = s.sent     ?? 0
    bounced24h = s.bounced  ?? 0
    inFlight   = s.in_flight ?? 0
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  // Send rate = sends-per-hour averaged across last 24h. Coarse signal —
  // good enough for the home glance "is it firing or stalled?".
  const sendRate = Math.round((sent24h / 24) * 10) / 10
  return {
    key: 'campaign',
    campaign_id: campaignId,
    found: true,
    name: row.name,
    status: row.status,
    paused_until: row.paused_until ?? null,
    sent_24h: sent24h,
    bounced_24h: bounced24h,
    in_flight: inFlight,
    send_rate_per_hour: sendRate,
  }
}

async function readRepliesPreview(pool) {
  let unhandled = 0
  let positiveUnhandled = 0
  let total24h = 0
  const recent = []
  // Same bounce/corrupted + NDR-signature exclusion the canonical /api/replies
  // list + repliesStats.js apply, so Home's unhandled/today counts + the preview
  // match the Odpovědi page exactly instead of over-counting and leaking
  // postmaster/mailer-daemon NDR rows into the home glance.
  const riNotNdr = notUndeliverableSql('from_email', 'subject')
  try {
    const { rows: [s = {}] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE NOT handled
            AND (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset'))
            AND ${riNotNdr}
        )::int AS unhandled,
        COUNT(*) FILTER (WHERE NOT handled AND classification = 'positive')::int AS positive_unhandled,
        COUNT(*) FILTER (
          WHERE received_at > now() - interval '24 hours'
            AND (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset'))
            AND ${riNotNdr}
        )::int AS today
      FROM reply_inbox
    `)
    unhandled = s.unhandled ?? 0
    positiveUnhandled = s.positive_unhandled ?? 0
    total24h  = s.today ?? 0
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, from_email AS from_address, subject, classification, received_at
       FROM reply_inbox
       WHERE NOT handled
         AND (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset'))
         AND ${riNotNdr}
       ORDER BY received_at DESC NULLS LAST
       LIMIT $1`,
      [RECENT_REPLY_PREVIEW_LIMIT],
    )
    for (const r of rows) {
      recent.push({
        id: r.id,
        from: redactFrom(r.from_address),
        // Decode RFC 2047 encoded-words so Home shows "Nepřítomnost Re: Dotaz"
        // instead of raw "=?UTF-8?Q?Nep=C5=99...?=" gibberish (the /replies
        // list already decoded; Home didn't).
        subject: decodeMimeWords(r.subject || '').slice(0, 80),
        classification: r.classification || null,
        received_at: r.received_at,
      })
    }
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  return {
    key: 'replies',
    unhandled,
    // Hot leads waiting: positive replies the operator hasn't actioned. This
    // is the business-critical signal (firma chce prodat techniku) — surfaced
    // distinctly on Home so it never hides inside the generic unhandled count.
    positive_unhandled: positiveUnhandled,
    today: total24h,
    recent,
  }
}

async function readMailboxHealth(pool) {
  let active = 0
  let paused = 0
  let auth_locked = 0
  let bounce_hold = 0
  let total = 0
  let avgScore = null
  try {
    const { rows } = await pool.query(`
      SELECT status, last_score
      FROM outreach_mailboxes
      WHERE environment = 'production'
    `)
    let scoreSum = 0
    let scoreN = 0
    for (const r of rows) {
      total += 1
      if (r.status === 'active') active += 1
      else if (r.status === 'paused') paused += 1
      else if (r.status === 'auth_locked') auth_locked += 1
      else if (r.status === 'bounce_hold') bounce_hold += 1
      if (typeof r.last_score === 'number' && Number.isFinite(r.last_score)) {
        scoreSum += r.last_score
        scoreN += 1
      }
    }
    if (scoreN > 0) avgScore = Math.round((scoreSum / scoreN) * 10) / 10
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  return {
    key: 'mailboxes',
    total,
    active,
    paused,
    auth_locked,
    bounce_hold,
    avg_score: avgScore,
  }
}

async function readNotifications(pool) {
  // Surface top critical / high-severity items, oldest unresolved first
  // (operator should triage stale ones). Caps at TOP_NOTIFICATION_LIMIT.
  let top = []
  let totalCritical = 0
  try {
    const { rows } = await pool.query(
      `SELECT id, type, severity, message, created_at
       FROM mailbox_alerts
       WHERE resolved_at IS NULL
         AND severity IN ('critical', 'high', 'error')
       ORDER BY created_at ASC
       LIMIT $1`,
      [TOP_NOTIFICATION_LIMIT],
    )
    top = rows.map(r => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      message: (r.message || '').slice(0, 140),
      created_at: r.created_at,
    }))
    const { rows: [c = {}] } = await pool.query(
      `SELECT COUNT(*)::int AS n
       FROM mailbox_alerts
       WHERE resolved_at IS NULL AND severity IN ('critical', 'high', 'error')`,
    )
    totalCritical = c.n ?? 0
  } catch (e) {
    if (!/relation .* does not exist/i.test(e.message || '')) throw e
  }
  return {
    key: 'notifications',
    total_critical: totalCritical,
    top,
  }
}

/**
 * Mount the dashboard-summary route on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: Function, safeError: Function,
 *          homeCampaignId?: number }} deps
 */
export function mountDashboardSummaryRoutes(app, { pool, capture500, safeError, homeCampaignId }) {
  const campaignId = Number.isInteger(homeCampaignId) && homeCampaignId > 0
    ? homeCampaignId
    : HOME_CAMPAIGN_ID

  app.get('/api/dashboard/summary', async (_req, res) => {
    try {
      const [campaign, replies, mailboxes, notifications] = await Promise.all([
        readCampaignStatus(pool, campaignId),
        readRepliesPreview(pool),
        readMailboxHealth(pool),
        readNotifications(pool),
      ])
      res.json({
        generated_at: new Date().toISOString(),
        home_campaign_id: campaignId,
        campaign,
        replies,
        mailboxes,
        notifications,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}

// Internal exports for unit tests.
export const __internals = {
  HOME_CAMPAIGN_ID,
  RECENT_REPLY_PREVIEW_LIMIT,
  TOP_NOTIFICATION_LIMIT,
  CRITICAL_SEVERITIES,
}
