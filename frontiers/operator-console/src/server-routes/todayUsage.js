// todayUsage.js — AC2 (2026-05-14)
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/mailboxes/:id/today-usage
//   Read-only endpoint that surfaces "why is this mailbox throttled today?"
//   for the MailboxDrawer DailyLimitCard. Aggregates:
//     - lifecycle_phase (from outreach_mailboxes)
//     - daily_cap_override (from outreach_mailboxes)
//     - effective_cap = LEAST(phase_cap, daily_cap_override > 0)
//     - sent_today_count = COUNT(send_events sent today in Europe/Prague,
//       status='sent')
//     - remaining_today = max(0, effective_cap - sent_today_count)
//     - cap_source = 'lifecycle_phase' | 'daily_cap_override'
//     - phase_advances_at = next 03:00 Europe/Prague after the row
//       crosses the next phase threshold
//
// HARD RULES:
//   - feedback_no_magic_thresholds (T0): phase cap lookup table is imported
//     from `../lib/lifecyclePhaseCaps.js`. No `5`/`10`/`25`/`50`/`100`
//     literals inline.
//   - feedback_audit_log_on_mutations: N/A — endpoint is read-only.
//   - feedback_schema_verify_before_sql (T0): SQL uses verified columns:
//     outreach_mailboxes.{id, lifecycle_phase, daily_cap_override,
//                         from_address, created_at}
//     send_events.{mailbox_used, sent_at, status}
//     Confirmed via `psql \d outreach_mailboxes` + `\d send_events`
//     2026-05-14.
//
// Reference: docs/initiatives sprint AC2.

import {
  capForPhase,
  resolveEffectiveCap,
  nextPhaseAdvanceAt,
} from '../lib/lifecyclePhaseCaps.js'

/**
 * Mount the today-usage endpoint.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountTodayUsageRoute(app, { pool, capture500, safeError }) {
  app.get('/api/mailboxes/:id/today-usage', async (req, res) => {
    try {
      const raw = req.params.id
      if (!/^\d+$/.test(raw)) {
        return res.status(400).json({ error: 'invalid_id' })
      }
      const id = Number(raw)
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'invalid_id' })
      }

      // Single round-trip: join mailbox row with today's send count.
      // sent_at::date AT TIME ZONE 'Europe/Prague' rolls the boundary
      // at midnight Prague (matches the `enforce_warmup_cap` trigger
      // which compares to CURRENT_DATE — server is UTC, but the
      // trigger interprets sent_at::date as UTC date. We deliberately
      // use Europe/Prague here so the operator sees the same "day"
      // they live in. This is a display-side count, not the gate.
      const { rows } = await pool.query(
        `SELECT m.id,
                m.lifecycle_phase,
                m.daily_cap_override,
                m.from_address,
                m.created_at,
                COALESCE(
                  (
                    SELECT COUNT(*)::int
                    FROM send_events se
                    WHERE se.mailbox_used = m.from_address
                      AND se.status = 'sent'
                      AND (se.sent_at AT TIME ZONE 'Europe/Prague')::date
                          = (now() AT TIME ZONE 'Europe/Prague')::date
                  ),
                  0
                ) AS sent_today_count
         FROM outreach_mailboxes m
         WHERE m.id = $1
         LIMIT 1`,
        [id],
      )

      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' })
      }

      const row = rows[0]
      const phase = row.lifecycle_phase || 'warmup_d0'
      const override = row.daily_cap_override
      const { phase_cap, effective_cap, cap_source } = resolveEffectiveCap(phase, override)
      const sent_today_count = Number(row.sent_today_count) || 0
      const remaining_today = Math.max(0, effective_cap - sent_today_count)
      const advancesAt = nextPhaseAdvanceAt(row.created_at, phase)

      return res.json({
        mailbox_id: id,
        lifecycle_phase: phase,
        phase_cap,
        daily_cap_override: override == null ? null : Number(override),
        effective_cap,
        sent_today_count,
        remaining_today,
        cap_source,
        phase_advances_at: advancesAt ? advancesAt.toISOString() : null,
        // AJ10d: surface from_address so MailboxLifecyclePhaseDialog can
        // require operator to type it as anti-fat-finger confirmation.
        from_address: row.from_address || null,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}

// Re-export for direct tests that want the cap helpers from the same module.
export { capForPhase }
