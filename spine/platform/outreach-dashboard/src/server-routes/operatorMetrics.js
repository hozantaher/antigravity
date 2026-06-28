// BFF operator metrics endpoint — aggregates Go orchestrator operator metrics
// into a single JSON snapshot for the dashboard operator view.
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/operator/metrics
//   Proxies to the Go orchestrator's in-memory snapshot served via
//   GET <GO_SERVER_URL>/api/operator/metrics.
//
//   The Go side (services/orchestrator/intelligence/operator_metrics.go) runs
//   Collect() hourly and returns an OperatorMetricsSnapshot with:
//     - campaigns[]: sent_24h, bounce_rate_24h, reply_rate_24h, step_distribution
//     - mailboxes[]: last_score, send_count_today, circuit_state
//     - classifier_overrides_today, training_set_size, accuracy_rolling_7d
//
//   If Go is unreachable the BFF falls back to querying Postgres directly for
//   a reduced snapshot (mailbox count + campaign count) so the dashboard
//   has something to render rather than a blank page.
//
// Read-only — no writes.
//
// Per memory feedback_no_extra_monitoring: no external monitoring services
// are added here; Sentry capture on unexpected errors only.

/**
 * Mount the operator metrics endpoint.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
// ── ADD-3: Yesterday's summary thresholds ─────────────────────────────────────
// Named constants per HARD RULE feedback_no_magic_thresholds — the trend
// band (±10%) is what classifies sent/reply counts as up/flat/down vs the
// day before yesterday.
import {
  YESTERDAY_TREND_DELTA_PCT,
  EXPECTED_REPLY_RATE,
  LIVE_CLUSTER_WINDOW_MINUTES,
  LIVE_CLUSTER_DEFAULT_SPACING_SECONDS,
} from '../lib/leadTierThresholds.js'

// AH6 — Sends-per-hour math constants. Used to convert the configured
// spacing into a per-mailbox ceiling (3600s / spacing = sends/hour).
const SECONDS_PER_HOUR = 3600
// Mailbox statuses counted as "active" for the cluster ceiling math.
// Mirrors the engine pickMailbox filter — paused/auth_locked/bounce_hold
// can't send, so they should not inflate the ceiling.
const LIVE_CLUSTER_ACTIVE_STATUSES = ['active']

/**
 * Classify a delta percent into trend direction.
 * @param {number} deltaPct
 * @returns {'up' | 'down' | 'flat'}
 */
export function classifyTrend(deltaPct) {
  if (!Number.isFinite(deltaPct)) return 'flat'
  if (deltaPct >= YESTERDAY_TREND_DELTA_PCT) return 'up'
  if (deltaPct <= -YESTERDAY_TREND_DELTA_PCT) return 'down'
  return 'flat'
}

/**
 * Compute percentage delta safely (handles zero baseline).
 * Returns 0 if both values are 0; returns 100 if baseline is 0 and current > 0.
 * @param {number} current
 * @param {number} baseline
 * @returns {number} integer percent
 */
export function percentDelta(current, baseline) {
  const c = Number(current) || 0
  const b = Number(baseline) || 0
  if (b === 0 && c === 0) return 0
  if (b === 0) return 100
  return Math.round(((c - b) / b) * 100)
}

/**
 * Resolve the per-mailbox spacing (seconds between consecutive sends from
 * the same mailbox) used to compute the cluster ceiling. Precedence:
 *   1. operator_settings.mailbox_min_spacing_seconds_default
 *   2. env MAILBOX_MIN_SPACING_SECONDS
 *   3. LIVE_CLUSTER_DEFAULT_SPACING_SECONDS (180s)
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<number>} seconds (positive integer)
 */
export async function resolveSpacingSeconds(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM operator_settings
        WHERE key = 'mailbox_min_spacing_seconds_default'
        LIMIT 1`,
    )
    if (rows[0]?.value) {
      const n = Number.parseInt(String(rows[0].value).trim(), 10)
      if (Number.isFinite(n) && n > 0) return n
    }
  } catch (_e) {
    // operator_settings table may be absent in fresh envs.
  }
  const envVal = Number.parseInt(String(process.env.MAILBOX_MIN_SPACING_SECONDS || '').trim(), 10)
  if (Number.isFinite(envVal) && envVal > 0) return envVal
  return LIVE_CLUSTER_DEFAULT_SPACING_SECONDS
}

/**
 * Cluster ceiling per hour given the active mailbox count + spacing.
 * Each mailbox can send at most (3600s / spacing) per hour.
 *
 * @param {number} activeMailboxCount
 * @param {number} spacingSeconds
 * @returns {number} integer sends/hour
 */
export function computeCeilingPerHour(activeMailboxCount, spacingSeconds) {
  const n = Math.max(0, Number(activeMailboxCount) || 0)
  const s = Math.max(1, Number(spacingSeconds) || LIVE_CLUSTER_DEFAULT_SPACING_SECONDS)
  return Math.floor(n * (SECONDS_PER_HOUR / s))
}

/**
 * Whole-number minutes elapsed since the given ISO timestamp. Returns null
 * when input is falsy/invalid so the UI can render an em-dash row.
 *
 * @param {string | Date | null | undefined} iso
 * @param {Date} [now=new Date()]
 * @returns {number | null}
 */
export function minutesSince(iso, now = new Date()) {
  if (!iso) return null
  const t = iso instanceof Date ? iso.getTime() : Date.parse(String(iso))
  if (!Number.isFinite(t)) return null
  const deltaMs = now.getTime() - t
  if (deltaMs < 0) return 0
  return Math.floor(deltaMs / 60_000)
}

export function mountOperatorMetricsRoutes(app, { pool, capture500, safeError }) {
  const GO_SERVER_URL = process.env.GO_SERVER_URL
  const API_KEY = process.env.OUTREACH_API_KEY || ''

  // GET /api/operator/metrics
  // Returns the Go orchestrator's operator metrics snapshot. Falls back to
  // a minimal direct-DB response when Go is unreachable so the dashboard
  // always shows something meaningful.
  app.get('/api/operator/metrics', async (_req, res) => {
    try {
      // Primary path: forward to Go orchestrator.
      if (GO_SERVER_URL) {
        const url = `${GO_SERVER_URL.replace(/\/$/, '')}/api/operator/metrics`
        let goRes
        try {
          goRes = await fetch(url, {
            headers: { 'x-api-key': API_KEY },
            signal: AbortSignal.timeout(8_000),
          })
        } catch (fetchErr) {
          // Relay to fallback below; log but don't 500.
          console.warn('[operator-metrics] go unreachable, using fallback:', fetchErr?.message)
          goRes = null
        }

        if (goRes && goRes.ok) {
          const data = await goRes.json()
          return res.json({ ...data, _source: 'go' })
        }

        // Go returned a non-OK status (e.g. 503 before first Collect tick).
        if (goRes && !goRes.ok) {
          console.warn('[operator-metrics] go returned', goRes.status, '— using fallback')
        }
      }

      // Fallback path: minimal direct-DB snapshot when Go is unavailable.
      const snap = await buildFallbackSnapshot(pool)
      return res.json({ ...snap, _source: 'bff-fallback' })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // ── ADD-3: Yesterday's daily summary ──────────────────────────────────────
  // GET /api/operator-metrics/daily-summary?date=yesterday|YYYY-MM-DD
  //   Aggregates send_events + bounce_events + reply_inbox + unmatched_inbound
  //   over a single Europe/Prague calendar day so the Home widget can render
  //   "what actually happened yesterday".
  //
  //   Default `date=yesterday`. Explicit YYYY-MM-DD form is for ad-hoc
  //   look-back (operator chooses any single day). The baseline ("vs day
  //   before") is the day before the requested date so the trend is
  //   day-over-day for whichever day the operator inspects.
  //
  //   Per HARD RULE feedback_no_magic_thresholds — thresholds for trend
  //   classification live in lib/leadTierThresholds.js, not inline.
  app.get('/api/operator-metrics/daily-summary', async (req, res) => {
    try {
      // Determine the target day in Europe/Prague. We compute the day
      // range in SQL using `date_trunc('day', X AT TIME ZONE 'Europe/Prague')`
      // so timezone shifts (DST) are correct.
      const requestedDate = String(req.query.date || 'yesterday').trim().slice(0, 10)
      let dayExpr
      let dayParams = []
      // dayExpr must be a timestamptz at Prague-local midnight so the window
      // bounds (`>= dayExpr AND < dayExpr + 1 day`) align with the labeled
      // Prague day. `now() AT TIME ZONE 'Europe/Prague'` yields a *naive*
      // timestamp (Prague wall clock); without the trailing `AT TIME ZONE
      // 'Europe/Prague'` it is compared to the timestamptz columns in the
      // session zone (UTC in prod), shifting the counted window 1–2h off the
      // labeled day. The trailing AT TIME ZONE re-anchors it to the Prague instant.
      if (requestedDate === 'yesterday' || requestedDate === '') {
        dayExpr = `((date_trunc('day', (now() AT TIME ZONE 'Europe/Prague')) - interval '1 day') AT TIME ZONE 'Europe/Prague')`
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        dayExpr = `(($1::date)::timestamp AT TIME ZONE 'Europe/Prague')`
        dayParams = [requestedDate]
      } else {
        return res.status(400).json({ error: 'invalid_date', hint: 'use "yesterday" or YYYY-MM-DD' })
      }

      // ── Sends + bounces for the target day ──
      // mailbox_used column → matches outreach_mailboxes.from_address
      const sendsSql = `
        SELECT
          COUNT(*) FILTER (WHERE se.status IN ('sent','queued','bounced','failed')) AS sent_count,
          COUNT(*) FILTER (WHERE se.status = 'bounced') AS bounce_count
        FROM send_events se
        WHERE se.sent_at >= ${dayExpr}
          AND se.sent_at <  ${dayExpr} + interval '1 day'
      `
      // ── Replies received on target day ──
      const repliesSql = `
        SELECT COUNT(*)::int AS reply_count
        FROM reply_inbox
        WHERE received_at >= ${dayExpr}
          AND received_at <  ${dayExpr} + interval '1 day'
      `
      // ── New unmatched_inbound rows ──
      const unmatchedSql = `
        SELECT COUNT(*)::int AS unmatched_count
        FROM unmatched_inbound
        WHERE received_at >= ${dayExpr}
          AND received_at <  ${dayExpr} + interval '1 day'
      `

      // No per-query .catch → zero fallback: that returned HTTP 200 with all
      // zeros on a DB error, making an outage indistinguishable from a real
      // zero-activity day. Let any error propagate to the outer handler (500).
      const [sendsRes, repliesRes, unmatchedRes] = await Promise.all([
        pool.query(sendsSql, dayParams),
        pool.query(repliesSql, dayParams),
        pool.query(unmatchedSql, dayParams),
      ])

      const sent = Number(sendsRes.rows[0]?.sent_count) || 0
      const bounces = Number(sendsRes.rows[0]?.bounce_count) || 0
      const replies = Number(repliesRes.rows[0]?.reply_count) || 0
      const newUnmatched = Number(unmatchedRes.rows[0]?.unmatched_count) || 0
      const bounceRatePct = sent > 0 ? Math.round((bounces / sent) * 1000) / 10 : 0
      const replyRatePct = sent > 0 ? Math.round((replies / sent) * 1000) / 10 : 0

      // ── Baseline: day before the target day ──
      const baselineDayExpr = `(${dayExpr} - interval '1 day')`
      const baselineSendsSql = `
        SELECT
          COUNT(*) FILTER (WHERE se.status IN ('sent','queued','bounced','failed')) AS sent_count
        FROM send_events se
        WHERE se.sent_at >= ${baselineDayExpr}
          AND se.sent_at <  ${baselineDayExpr} + interval '1 day'
      `
      const baselineRepliesSql = `
        SELECT COUNT(*)::int AS reply_count
        FROM reply_inbox
        WHERE received_at >= ${baselineDayExpr}
          AND received_at <  ${baselineDayExpr} + interval '1 day'
      `

      const [baseSendsRes, baseRepliesRes] = await Promise.all([
        pool.query(baselineSendsSql, dayParams),
        pool.query(baselineRepliesSql, dayParams),
      ])
      const baselineSent = Number(baseSendsRes.rows[0]?.sent_count) || 0
      const baselineReplies = Number(baseRepliesRes.rows[0]?.reply_count) || 0

      const sentDelta = sent - baselineSent
      const replyDelta = replies - baselineReplies
      const sentDeltaPct = percentDelta(sent, baselineSent)
      const trend = classifyTrend(sentDeltaPct)

      // Resolve the actual ISO date the SQL targeted so the UI can render
      // a real date instead of just the literal "yesterday".
      // dayExpr is a timestamptz (Prague-midnight instant); render it back in
      // Prague so the label reads the intended calendar day, not the session-zone
      // (UTC) day, which would show the day before for a +01/+02 Prague instant.
      const { rows: dateRows } = await pool.query(
        `SELECT to_char(${dayExpr} AT TIME ZONE 'Europe/Prague', 'YYYY-MM-DD') AS d`,
        dayParams,
      )
      const isoDate = dateRows[0]?.d || requestedDate

      return res.json({
        date: isoDate,
        sent,
        bounces,
        bounce_rate_pct: bounceRatePct,
        replies,
        reply_rate_pct: replyRatePct,
        new_unmatched: newUnmatched,
        expected_reply_rate_pct: Math.round(EXPECTED_REPLY_RATE * 1000) / 10,
        vs_baseline: {
          baseline_sent: baselineSent,
          baseline_replies: baselineReplies,
          sent_delta: sentDelta,
          sent_delta_pct: sentDeltaPct,
          reply_delta: replyDelta,
          trend,
        },
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // ── AH6: Live cluster throughput ─────────────────────────────────────
  // GET /api/operator-metrics/cluster-rate-live
  //   Returns the trailing 60-minute send rate per active mailbox plus
  //   the cluster total and the computed ceiling (active mailbox count ×
  //   sends/h per mailbox @ configured spacing).
  //
  //   The widget consuming this endpoint refreshes every 30s, so the
  //   trailing-hour rate is "live enough" — operator sees a stall within
  //   one polling cycle but the hour window keeps the headline number
  //   stable against single-send noise.
  //
  //   Read-only. No mutations, no audit log.
  //
  //   Per HARD RULES:
  //     - feedback_no_magic_thresholds: window (60min), spacing default
  //       (180s), and ceiling math are all named constants.
  //     - feedback_schema_verify_before_sql: queries verified against
  //       migration 029 (outreach_mailboxes.from_address/status/last_send_at)
  //       and 033 (send_events.mailbox_used/status/sent_at).
  app.get('/api/operator-metrics/cluster-rate-live', async (_req, res) => {
    try {
      const nowIso = new Date().toISOString()
      const windowMinutes = LIVE_CLUSTER_WINDOW_MINUTES

      // 1) Resolve spacing first — needed for the ceiling math below.
      const spacingSeconds = await resolveSpacingSeconds(pool)

      // 2) Per-mailbox aggregates over the trailing window.
      //    JOIN: outreach_mailboxes.from_address = send_events.mailbox_used.
      //    Filter: production mailboxes with status='active' only — paused /
      //    auth_locked / bounce_hold mailboxes cannot send so they don't
      //    contribute to the cluster ceiling. We still keep their row when
      //    they sent during the window (status flipped mid-hour) so the
      //    operator sees the tail of their throughput.
      const perMailboxSql = `
        WITH active_mb AS (
          SELECT from_address, last_send_at, status
            FROM outreach_mailboxes
           WHERE environment = 'production'
             AND status = ANY ($1::text[])
        ),
        window_sends AS (
          SELECT
            se.mailbox_used AS addr,
            COUNT(*) FILTER (
              WHERE se.status IN ('sent','queued','bounced','failed')
            ) AS sent_count,
            COUNT(*) FILTER (WHERE se.status = 'bounced') AS bounce_count,
            MAX(se.sent_at) AS last_sent_at
          FROM send_events se
          WHERE se.sent_at >= now() - ($2::int * interval '1 minute')
          GROUP BY se.mailbox_used
        )
        SELECT
          m.from_address                              AS from_address,
          COALESCE(ws.sent_count, 0)::int             AS sent_60min,
          COALESCE(ws.bounce_count, 0)::int           AS bounce_60min,
          COALESCE(ws.last_sent_at, m.last_send_at)   AS last_sent_at,
          m.status                                    AS status
        FROM active_mb m
        LEFT JOIN window_sends ws ON ws.addr = m.from_address
        ORDER BY m.from_address ASC
      `

      let perMailboxRows = []
      try {
        const r = await pool.query(perMailboxSql, [LIVE_CLUSTER_ACTIVE_STATUSES, windowMinutes])
        perMailboxRows = r.rows || []
      } catch (e) {
        // Schema gap (fresh env) — return empty cluster rather than 500.
        // Surface the error in a degraded payload so the widget can show
        // a friendly empty state instead of an opaque red banner.
        return res.json({
          now_iso: nowIso,
          window_minutes: windowMinutes,
          cluster: { sent_60min: 0, rate_per_hour: 0, bounce_60min: 0, bounce_rate_pct: 0 },
          mailboxes: [],
          mailbox_status_summary: { active: 0, paused: 0, auth_locked: 0, bounce_hold: 0, total: 0 },
          ceiling_per_h: 0,
          spacing_seconds: spacingSeconds,
          _degraded: true,
          _degraded_reason: (e && e.message) || 'db_error',
        })
      }

      // 3) Mailbox status summary — one extra SELECT so the widget can show
      //    "3 active · 1 paused · 0 auth_locked" pills without a separate
      //    endpoint. Covers all production mailboxes regardless of status.
      //    Read-only; no audit log required.
      let mailboxStatusSummary = { active: 0, paused: 0, auth_locked: 0, bounce_hold: 0, total: 0 }
      try {
        const statusSql = `
          SELECT
            COUNT(*) FILTER (WHERE status = 'active')      AS active,
            COUNT(*) FILTER (WHERE status = 'paused')      AS paused,
            COUNT(*) FILTER (WHERE status = 'auth_locked') AS auth_locked,
            COUNT(*) FILTER (WHERE status = 'bounce_hold') AS bounce_hold,
            COUNT(*)                                       AS total
          FROM outreach_mailboxes
          WHERE environment = 'production'
        `
        const sr = await pool.query(statusSql)
        const row = sr.rows[0] || {}
        mailboxStatusSummary = {
          active:      Number(row.active)      || 0,
          paused:      Number(row.paused)      || 0,
          auth_locked: Number(row.auth_locked) || 0,
          bounce_hold: Number(row.bounce_hold) || 0,
          total:       Number(row.total)       || 0,
        }
      } catch (_e) {
        // Schema gap — keep the zero-filled default; widget degrades gracefully.
      }

      // Per-mailbox row shaping.
      const now = new Date()
      const mailboxes = perMailboxRows.map((r) => {
        const sent60 = Number(r.sent_60min) || 0
        const bounce60 = Number(r.bounce_60min) || 0
        const lastSentIso = r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null
        return {
          from_address: String(r.from_address || ''),
          sent_60min: sent60,
          rate_per_hour: sent60,
          bounce_60min: bounce60,
          last_sent_at: lastSentIso,
          minutes_since_last_send: minutesSince(lastSentIso, now),
        }
      })

      // Cluster aggregates.
      const clusterSent = mailboxes.reduce((acc, m) => acc + m.sent_60min, 0)
      const clusterBounce = mailboxes.reduce((acc, m) => acc + m.bounce_60min, 0)
      const bounceRatePct =
        clusterSent > 0 ? Math.round((clusterBounce / clusterSent) * 1000) / 10 : 0

      // Active mailbox count for ceiling math.
      const activeCount = mailboxes.length
      const ceilingPerH = computeCeilingPerHour(activeCount, spacingSeconds)

      return res.json({
        now_iso: nowIso,
        window_minutes: windowMinutes,
        cluster: {
          sent_60min: clusterSent,
          rate_per_hour: clusterSent,
          bounce_60min: clusterBounce,
          bounce_rate_pct: bounceRatePct,
        },
        mailboxes,
        mailbox_status_summary: mailboxStatusSummary,
        ceiling_per_h: ceilingPerH,
        spacing_seconds: spacingSeconds,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}

// buildFallbackSnapshot constructs a minimal snapshot from Postgres when the
// Go orchestrator is unreachable. Exposes only campaign/mailbox counts so the
// dashboard can render a degraded but non-empty state.
async function buildFallbackSnapshot(pool) {
  const now = new Date().toISOString()

  // Campaign list (running + paused with 24h send counts).
  let campaigns = []
  try {
    const { rows } = await pool.query(`
      SELECT
        c.id,
        c.name,
        c.status,
        -- COUNT(DISTINCT se.id): the bounce_events LEFT JOIN fans each send into
        -- one row per bounce, so a bare COUNT(se.id) double-counts sends.
        COUNT(DISTINCT se.id) FILTER (WHERE se.sent_at > now() - interval '24h') AS sent_24h,
        COUNT(be.id) FILTER (WHERE se.sent_at > now() - interval '24h') AS bounced_24h
      FROM campaigns c
      LEFT JOIN send_events se ON se.campaign_id = c.id
      LEFT JOIN bounce_events be ON be.send_event_id = se.id
      WHERE c.status IN ('running', 'paused')
      GROUP BY c.id, c.name, c.status
      ORDER BY sent_24h DESC
    `)
    campaigns = rows.map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      sent_24h: Number(r.sent_24h) || 0,
      bounce_rate_24h: r.sent_24h > 0
        ? Number(r.bounced_24h) / Number(r.sent_24h)
        : 0,
      reply_rate_24h: 0,          // unavailable without Go snapshot
      current_step_distribution: {},
    }))
  } catch (_e) {
    // Schema gap (fresh env) — return empty list, not 500.
  }

  // Mailbox list (score + today send count).
  let mailboxes = []
  try {
    const { rows } = await pool.query(`
      SELECT
        m.from_address AS address,
        COALESCE(m.last_score, 0) AS last_score,
        COUNT(se.id) FILTER (
          WHERE se.sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
        ) AS send_count_today,
        m.status
      FROM outreach_mailboxes m
      LEFT JOIN send_events se ON se.mailbox_used = m.from_address
      GROUP BY m.from_address, m.last_score, m.status
      ORDER BY m.from_address
    `)
    mailboxes = rows.map(r => ({
      address: r.address,
      last_score: Number(r.last_score) || 0,
      send_count_today: Number(r.send_count_today) || 0,
      circuit_state: r.status === 'bounce_hold' ? 'open' : 'closed',
      status: r.status,
    }))
  } catch (_e) {
    // Schema gap — return empty list.
  }

  // Classifier overrides today (best-effort — operator_audit_log may not exist).
  let classifierOverridesToday = 0
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM operator_audit_log
      WHERE created_at > now() - interval '24h'
        AND action = 'reply_classify_override'
    `)
    classifierOverridesToday = rows[0]?.n || 0
  } catch (_e) {}

  return {
    generated_at: now,
    campaigns,
    mailboxes,
    classifier_overrides_today: classifierOverridesToday,
    training_set_size: 0,        // not available in fallback path
    accuracy_rolling_7d: 0,      // not available in fallback path
  }
}
