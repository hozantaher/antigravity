// mailboxBounceWarnings.js — Sprint UX-4 (live bounce-rate warning banner).
//
// Surfaces mailboxes at risk of triggering auto-pause BEFORE the auto-pause
// fires. Operator sees a warning at 1.5% bounce rate so they can react
// before the 2% hard floor. Companion read-only endpoint to M1
// (mailboxBounceStats.js) but scoped to TODAY (current calendar day) and
// using a tunable warn threshold (1.5%) instead of M1's 2% breach flag.
//
// Route:
//   GET /api/mailboxes/bounce-warnings
//
// Response shape:
//   {
//     ran_at: ISO 8601,
//     thresholds: {
//       warn: 0.015,           // 1.5%
//       pause: 0.02,           // 2%
//       min_volume: 20,        // require ≥20 sends today
//     },
//     warnings: [
//       {
//         mailbox_id, from_address,
//         bounces_today, sends_today,
//         bounce_rate,         // float 0..1
//       }
//     ]
//   }
//
// Sort order: rate DESC — worst offender first so the banner highlights
// the riskiest mailbox at the top.
//
// HARD RULE compliance:
//   - feedback_no_magic_thresholds T0: thresholds are loaded from
//     operator_settings (bounce_warn_threshold, bounce_pause_threshold,
//     bounce_min_volume). Defaults shipped here as fallbacks; operator can
//     override via UI / SQL without redeploy.
//   - feedback_schema_verify_before_sql T0: schema verified against
//     existing mailboxBounceStats.js (status='active', send_events
//     status in ('sent','bounced'), mailbox_used join column).
//   - feedback_ux_ui_first T0: read-only endpoint — mutations (Pause now)
//     go through existing POST /api/mailboxes/bulk-pause flow.

// Defaults (fallbacks when operator_settings row missing).
const DEFAULT_BOUNCE_WARN_THRESHOLD = 0.015   // 1.5% — warn before auto-pause
const DEFAULT_BOUNCE_PAUSE_THRESHOLD = 0.02   // 2% — auto-pause fires here
const DEFAULT_BOUNCE_MIN_VOLUME = 20          // require ≥20 sends to avoid tiny-N noise

/**
 * Load a numeric threshold from operator_settings, falling back to
 * `fallback` when the row is missing or unparseable.
 *
 * @param {import('pg').Pool} pool
 * @param {string} key
 * @param {number} fallback
 * @returns {Promise<number>}
 */
async function loadThreshold(pool, key, fallback) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM operator_settings WHERE key = $1`,
      [key],
    )
    if (rows.length === 0) return fallback
    const raw = rows[0].value
    const parsed = typeof raw === 'string' ? parseFloat(raw) : Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/**
 * Mount /api/mailboxes/bounce-warnings on the Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountMailboxBounceWarningsRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/bounce-warnings', async (_req, res) => {
    try {
      const warn = await loadThreshold(
        pool, 'bounce_warn_threshold', DEFAULT_BOUNCE_WARN_THRESHOLD,
      )
      const pause = await loadThreshold(
        pool, 'bounce_pause_threshold', DEFAULT_BOUNCE_PAUSE_THRESHOLD,
      )
      const minVolume = await loadThreshold(
        pool, 'bounce_min_volume', DEFAULT_BOUNCE_MIN_VOLUME,
      )

      // Live aggregation against send_events for the current calendar day.
      // Day boundary = `sent_at::date = CURRENT_DATE` (server tz). The
      // Go runner + BFF run with UTC tz set, matching send_events.sent_at
      // timestamptz semantics — so this is "today UTC" which aligns with
      // the auto-pause cron daily window.
      const { rows } = await pool.query(
        `SELECT
           m.id                                                  AS mailbox_id,
           m.from_address                                         AS from_address,
           COUNT(se.*) FILTER (WHERE se.status = 'bounced')      AS bounces_today,
           COUNT(se.*)                                            AS sends_today
         FROM outreach_mailboxes m
         LEFT JOIN send_events se
           ON se.mailbox_used = m.from_address
          AND se.sent_at::date = CURRENT_DATE
         WHERE m.status = 'active'
         GROUP BY m.id, m.from_address
         HAVING COUNT(se.*) >= $1
         ORDER BY m.from_address`,
        [minVolume],
      )

      const warnings = rows
        .map((r) => {
          const sends = Number(r.sends_today) || 0
          const bounces = Number(r.bounces_today) || 0
          const rate = sends === 0 ? 0 : bounces / sends
          return {
            mailbox_id: Number(r.mailbox_id),
            from_address: r.from_address,
            bounces_today: bounces,
            sends_today: sends,
            bounce_rate: rate,
          }
        })
        // Warn-threshold is inclusive (`>=`) — exactly 1.5% should fire.
        .filter((row) => row.bounce_rate >= warn)
        // Worst offender first.
        .sort((a, b) => b.bounce_rate - a.bounce_rate)

      res.json({
        ran_at: new Date().toISOString(),
        thresholds: {
          warn,
          pause,
          min_volume: minVolume,
        },
        warnings,
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
