// leadTierThresholds.js — UX-1 / UX-3 (2026-05-14)
//
// Single source of truth for lead-score tier thresholds + reply
// expectation baselines. Centralizes magic numbers that were previously
// duplicated across:
//   - apps/outreach-dashboard/src/lib/campaign-send-batch.js (Go-runner parity)
//   - apps/outreach-dashboard/src/server-routes/campaigns.js
//     (GET /api/campaigns/:id/priority-distribution tier CASE)
//   - apps/outreach-dashboard/src/components/PriorityTierWidgets.jsx
//
// HARD RULE feedback_no_magic_thresholds (T0): every threshold lives
// in a named constant in this module. UI + BFF + worker all import
// from here (BFF re-binds in SQL via `priority >= $TIER_A` etc).

/**
 * Tier band lower bounds. priority >= TIER_A_MIN → A, etc.
 * Mirrors migration 111 + Go runner sorting (campaign_contacts.priority).
 */
export const TIER_A_MIN = 0.90
export const TIER_B_MIN = 0.78
export const TIER_C_MIN = 0.65
export const TIER_D_MIN = 0.50

/**
 * E-tier upper bound (exclusive). Contacts with priority < this value
 * are considered low-signal (ÚŘADY, ARCHITEKTI, dormant cohorts) and
 * are eligible for the optional pre-launch tier filter.
 */
export const E_TIER_MAX_PRIORITY = TIER_D_MIN

/**
 * Cohort E-tier share at which the pre-launch modal will auto-check
 * the "Filter E-tier" checkbox + show an inline warn banner. Below
 * this threshold the operator can opt-in manually but the default is
 * unchecked so legitimate mixed cohorts (e.g. 2% E-tier) are not over-filtered.
 *
 * Past incident (2026-05-14, campaign 457 first launch): operator
 * realized post-launch that ~16% of cohort was E-tier (5071 / 30977
 * contacts) and had to manually filter after send started. Setting
 * this to 0.05 (5%) trips the auto-filter on any cohort where the
 * E-tier wastage is meaningful relative to the rest of the cohort.
 */
export const E_TIER_AUTO_FILTER_THRESHOLD = 0.05

/**
 * Cohort E-tier share at which the pre-launch modal blocks the
 * unfiltered launch path entirely. Operator must either keep the
 * "Filter E-tier" checkbox checked (default at this severity) OR
 * explicitly tick the "Forzuj — pošli i E-tier" override.
 *
 * 0.20 = 20% E-tier share. Above this the cohort is dominated by
 * low-signal contacts and an unfiltered send is almost certainly
 * an operator mistake (wrong segment selected, stale priority
 * scores, etc.).
 */
export const E_TIER_FORCE_BLOCK_THRESHOLD = 0.20

/**
 * Human-readable labels for tier rows. Czech-first per dashboard convention.
 */
export const TIER_LABELS = {
  'A_top_0.90+':       'A_top (≥ 0,90) — top priority',
  'B_high_0.78-0.89':  'B_high (0,78–0,89) — strong fit',
  'C_mid_0.65-0.77':   'C_mid (0,65–0,77) — viable',
  'D_low_0.50-0.64':   'D_low (0,50–0,64) — marginal',
  'E_dead_below_0.50': 'E_dead (< 0,50) — bottom decile',
}

/**
 * Classify a numeric priority into a tier key.
 *
 * @param {number | null | undefined} priority
 * @returns {'A_top_0.90+' | 'B_high_0.78-0.89' | 'C_mid_0.65-0.77' | 'D_low_0.50-0.64' | 'E_dead_below_0.50'}
 */
export function tierFromPriority(priority) {
  const p = Number(priority)
  if (!Number.isFinite(p)) return 'E_dead_below_0.50'
  if (p >= TIER_A_MIN) return 'A_top_0.90+'
  if (p >= TIER_B_MIN) return 'B_high_0.78-0.89'
  if (p >= TIER_C_MIN) return 'C_mid_0.65-0.77'
  if (p >= TIER_D_MIN) return 'D_low_0.50-0.64'
  return 'E_dead_below_0.50'
}

// ── Reply latency expectation widget thresholds (UX-3) ────────────────

/**
 * Expected reply rate for cold B2B outreach in the heavy-machinery /
 * commercial-equipment vertical. Used as the baseline to compare
 * actual replies against on day 5+. Conservative — typical industry
 * range is 1–3% for unverified cold lists; we use 1.5% as a midpoint.
 */
export const EXPECTED_REPLY_RATE = 0.015 // 1.5%

/**
 * Days after the first send when we expect the reply curve to have
 * stabilized enough to compare against the baseline. B2B cold mail
 * typically lags 2–5 business days (decision-maker is rarely at desk
 * within 24h of receiving an unsolicited message).
 */
export const REPLY_LATENCY_NORMAL_DAYS = 5

/**
 * Day count after which a zero-reply campaign is considered concerning.
 * Below this is "within normal range"; at/above this with 0 replies
 * triggers the red "Below baseline" copy.
 */
export const REPLY_LATENCY_WARN_DAYS = REPLY_LATENCY_NORMAL_DAYS

// ── ADD-3: Yesterday summary widget thresholds (2026-05-14) ────────────

/**
 * Number of days of history rendered on the mailbox health-trend chart
 * (ADD-4). Operator looks back 7 calendar days to spot regressions.
 */
export const MAILBOX_HEALTH_TREND_DAYS = 7

/**
 * Yesterday-summary widget refresh cadence. Operator opens Home once
 * per morning so a long interval is fine — we still re-poll hourly to
 * catch late-day backfills (delayed bounce notifications, etc.).
 */
export const YESTERDAY_SUMMARY_REFRESH_MS = 60 * 60 * 1000

/**
 * Trend deltas vs day-before-yesterday. Threshold for tagging the
 * day as up / flat / down on the send count axis. ±10% is the
 * "noise" band — anything outside flips the arrow.
 */
export const YESTERDAY_TREND_DELTA_PCT = 10

// ── AH6: Live cluster throughput widget thresholds (2026-05-15) ────────

/**
 * Live cluster widget polling cadence. 30s matches VerifyQueueWidget so
 * operator sees current state without spamming the BFF. Slower than the
 * Vite HMR loop (which is human-driven), faster than the 1h yesterday
 * widget (which is morning-glance).
 */
export const LIVE_CLUSTER_REFRESH_MS = 30_000

/**
 * Minutes since last send per mailbox that flips a mailbox to amber
 * (stuck / cron may have stalled). Used during business hours; off-hours
 * we expect long gaps and the widget should not red-flag them.
 */
export const LIVE_CLUSTER_MB_STUCK_MINUTES = 5

/**
 * Cluster rate "healthy" floor as a fraction of the per-spacing ceiling.
 * 0.70 = 70% of cluster ceiling. Below this we tag the whole cluster
 * amber (engine is sending but throughput is below the configured
 * ceiling — could be daily cap exhaustion, recipient-side throttling,
 * or a partial pool outage).
 */
export const LIVE_CLUSTER_HEALTHY_FLOOR_PCT = 0.70

/**
 * Look-back window for the live cluster rate calculation. 60 minutes is
 * a stable trailing-hour rate — short enough to catch a sudden stall
 * (engine paused 10min ago → rate drops noticeably), long enough that a
 * single late send does not whipsaw the headline number.
 */
export const LIVE_CLUSTER_WINDOW_MINUTES = 60

/**
 * Per-mailbox spacing default when neither operator_settings nor the
 * env var resolves a value. 180s = 20 sends/hour per mailbox, the
 * conservative production default since Sprint AP3 spacing tightening.
 */
export const LIVE_CLUSTER_DEFAULT_SPACING_SECONDS = 180
