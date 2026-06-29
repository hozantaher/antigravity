// AR13 — Engagement-driven daily cap adjustment cron.
//
// Per AR2 audit: open-pixel tracking removed from templates (seznam delivery).
// Engagement signal = reply rate (proxy metric).
//
// Logic (runs daily at 04:00 Prague via scheduleDaily):
//   reply_rate < 0.005 (< 0.5%)  → reduce daily_cap_override (current / 2, floor 5)
//   reply_rate > 0.05  (> 5%)    → allow growth (restore toward phase cap)
//   < 50 sends in 7d             → skip (insufficient data)
//   phase cap (AP1) is never exceeded by the growth path
//
// Adjustment log: operator_audit_log (action='cap_adjusted_engagement')
// Skip if outreach_threads table inaccessible — graceful degradation.
//
// PHASE_CAPS source of truth: ../lib/lifecyclePhaseCaps.js (mirrors DB
// `compute_phase_cap()` from migration 116 — operator-180 schedule).
// HARD RULE feedback_no_magic_thresholds (T0): never inline phase cap
// literals here — import them from lifecyclePhaseCaps.js.
import { capForPhase } from '../lib/lifecyclePhaseCaps.js'

/**
 * Run one tick of the engagement-driven cap adjustment cron.
 * @param {import('pg').Pool} pool
 * @param {{ Sentry?: object }} [deps]
 * @returns {Promise<{adjusted: number, checked: number, skipped: number}>}
 */
export async function runEngagementCapAdjustmentCron(pool, deps = {}) {
  const { Sentry } = deps

  // Verify outreach_threads table is accessible before proceeding (graceful degradation).
  try {
    await pool.query('SELECT 1 FROM outreach_threads LIMIT 0')
  } catch (e) {
    console.warn('[AR13] runEngagementCapAdjustmentCron: outreach_threads not accessible — skipping', e.message)
    return { adjusted: 0, checked: 0, skipped: 0, skip_reason: 'threads_unavailable' }
  }

  // Fetch per-mailbox engagement stats: 7-day sends + replies.
  // Reply = thread where a recipient message exists in the 7d window.
  // threads join by campaign→mailbox path: we join send_events to get the
  // mailbox from_address, then count threads where a reply arrived recently.
  // Minimum 50 sends in 7 days to have enough data.
  const { rows } = await pool.query(`
    WITH mailbox_engagement AS (
      SELECT
        m.id,
        m.from_address,
        m.daily_cap_override,
        m.lifecycle_phase,
        count(DISTINCT se.id)
          FILTER (WHERE se.sent_at > NOW() - INTERVAL '7 days')   AS sends_7d,
        count(DISTINCT t.id)
          FILTER (
            WHERE t.updated_at > NOW() - INTERVAL '7 days'
              AND t.status = 'replied'
          )                                                          AS replies_7d
      FROM outreach_mailboxes m
      LEFT JOIN send_events se
             ON se.mailbox_used = m.from_address
      LEFT JOIN outreach_threads t
             ON t.campaign_id IN (
                  SELECT DISTINCT campaign_id FROM send_events
                  WHERE mailbox_used = m.from_address
                    AND sent_at > NOW() - INTERVAL '7 days'
                )
      WHERE m.environment = 'production'
        AND m.status = 'active'
      GROUP BY m.id, m.from_address, m.daily_cap_override, m.lifecycle_phase
      HAVING count(DISTINCT se.id) FILTER (WHERE se.sent_at > NOW() - INTERVAL '7 days') >= 50
    )
    SELECT
      id,
      from_address,
      daily_cap_override,
      lifecycle_phase,
      sends_7d,
      replies_7d,
      (replies_7d::float / NULLIF(sends_7d, 0)) AS reply_rate
    FROM mailbox_engagement
    WHERE sends_7d > 0
  `)

  // Phase caps sourced from lifecyclePhaseCaps.js (DB migration 116 mirror).
  // Never allow growth beyond phase cap. Unknown phase → conservative
  // default (DEFAULT_PHASE_CAP = warmup_d0 = 10) via capForPhase().
  let adjusted = 0
  let skipped = 0

  for (const r of rows) {
    const replyRate = typeof r.reply_rate === 'number' ? r.reply_rate : 0
    const currentOverride = r.daily_cap_override !== null ? Number(r.daily_cap_override) : null
    const phaseCap = capForPhase(r.lifecycle_phase)

    let newOverride = null
    let action = null

    if (replyRate < 0.005) {
      // Low engagement: halve the cap, floor at 5. Clamp to the current base so
      // "reduce" can never RAISE a deliberately-lowered cap (base 1-4 → floor 5
      // would otherwise bump it back up to 5).
      const base = currentOverride !== null ? currentOverride : phaseCap
      newOverride = Math.min(base, Math.max(5, Math.floor(base / 2)))
      action = 'reduce'
    } else if (replyRate > 0.05) {
      // Good engagement: allow growth back toward phase cap.
      const base = currentOverride !== null ? currentOverride : phaseCap
      // Grow by 25%, ceil, never exceed phaseCap.
      newOverride = Math.min(phaseCap, Math.ceil(base * 1.25))
      // If already at phase cap, no change needed.
      if (newOverride === base) {
        skipped++
        continue
      }
      action = 'grow'
    } else {
      // Neutral range (0.5% – 5%): no change.
      skipped++
      continue
    }

    // Persist: only update if the value actually changes.
    if (currentOverride === newOverride) {
      skipped++
      continue
    }

    // Persist UPDATE + audit row atomically (HARD: feedback_audit_log_on_mutations).
    // Previously the audit INSERT was a separate pool.query swallowed by try/catch,
    // so a failed audit left an operator-visible cap change with no trail. Now both
    // run in one tx and roll back together.
    const redacted = r.from_address.replace(/^([^@]{1,3})[^@]*/, '$1…')
    const client = await pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')
      await client.query(
        `UPDATE outreach_mailboxes
            SET daily_cap_override = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [newOverride, r.id],
      )
      await client.query(
        `INSERT INTO operator_audit_log
           (entity_type, entity_id, action, details, created_at)
         VALUES ('mailbox', $1, 'cap_adjusted_engagement', $2, NOW())`,
        [
          r.id,
          JSON.stringify({
            action,
            reply_rate: replyRate,
            sends_7d: Number(r.sends_7d),
            replies_7d: Number(r.replies_7d),
            old_cap: currentOverride,
            new_cap: newOverride,
            phase_cap: phaseCap,
            lifecycle_phase: r.lifecycle_phase,
          }),
        ],
      )
      await client.query('COMMIT')
      committed = true
    } catch (txErr) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      console.warn('[AR13] cap adjust tx failed (rolled back):', txErr.message)
    } finally {
      client.release()
    }

    if (!committed) continue

    console.log(
      `[AR13] cap_adjusted mb=${redacted} action=${action} reply_rate=${(replyRate * 100).toFixed(2)}% old_cap=${currentOverride} new_cap=${newOverride}`,
    )
    adjusted++
  }

  console.log(`[AR13] runEngagementCapAdjustmentCron checked=${rows.length} adjusted=${adjusted} skipped=${skipped}`)

  if (adjusted > 0) {
    try {
      Sentry?.captureMessage(`engagement_cap_adjusted: ${adjusted} mailboxes`, 'info')
    } catch (_) { /* best-effort */ }
  }

  return { adjusted, checked: rows.length, skipped }
}
