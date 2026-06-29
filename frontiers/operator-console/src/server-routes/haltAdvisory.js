// Halt advisory route — campaign bounce/complaint rate vs operator thresholds
// (#1004 [S1.3]). Read-only ADVISORY: it never pauses anything itself (the
// operator pauses via POST /api/campaigns/:id/pause). It tells the operator
// whether the current campaign reputation is safe to keep sending — the safety
// rail for resuming campaign 457.
//
// Data source (verified 2026-06-01): bounces live in send_events.status, NOT
// bounce_events (that table is empty and has no campaign_id — it links by
// send_event_id). send_events.status for a campaign is one of
// sent / bounced / failed / presend_skip. Bounce rate = bounced / (sent +
// bounced) — the share of *delivery attempts* that bounced.
//
// Complaints are NOT tracked: Seznam exposes no feedback loop (FBL) — see
// #1161. We report complaint_rate as null with a reason rather than a fake 0.
//
// Thresholds come from operator_settings (feedback_no_magic_thresholds T0):
// halt_bounce_pause_pct / halt_bounce_stop_pct / halt_complaint_pause_pct.
// The named DEFAULTS below are the boot fallback if a key is missing
// (feedback_env_var_needs_db_fallback — operator tunes in DB, no redeploy).

const DEFAULTS = { bounce_pause_pct: 5, bounce_stop_pct: 10, complaint_pause_pct: 0.3 }

/**
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: Function, safeError: Function }} deps
 */
export function mountHaltAdvisoryRoutes(app, deps) {
  const { pool, capture500, safeError } = deps

  app.get('/api/campaigns/:id/halt-advisory', async (req, res) => {
    const campaignId = Number(req.params.id)
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'invalid campaign id' })
    }
    try {
      // Thresholds (DB-overridable, named defaults as boot fallback).
      const { rows: tRows } = await pool.query(
        `SELECT key, value FROM operator_settings
          WHERE key IN ('halt_bounce_pause_pct','halt_bounce_stop_pct','halt_complaint_pause_pct')`,
      )
      const tMap = Object.fromEntries(tRows.map((r) => [r.key, Number(r.value)]))
      const thresholds = {
        bounce_pause_pct: Number.isFinite(tMap.halt_bounce_pause_pct) ? tMap.halt_bounce_pause_pct : DEFAULTS.bounce_pause_pct,
        bounce_stop_pct: Number.isFinite(tMap.halt_bounce_stop_pct) ? tMap.halt_bounce_stop_pct : DEFAULTS.bounce_stop_pct,
        complaint_pause_pct: Number.isFinite(tMap.halt_complaint_pause_pct) ? tMap.halt_complaint_pause_pct : DEFAULTS.complaint_pause_pct,
      }

      // Lifetime send outcome for the campaign (bounce_events has no timestamp
      // to window on, and send_events.status is the canonical bounce signal).
      const { rows: sRows } = await pool.query(
        `SELECT status, COUNT(*)::int AS n FROM send_events WHERE campaign_id = $1 GROUP BY status`,
        [campaignId],
      )
      const counts = Object.fromEntries(sRows.map((r) => [r.status, r.n]))
      const sent = counts.sent || 0
      const bounced = counts.bounced || 0
      const failed = counts.failed || 0
      const attempts = sent + bounced  // delivery attempts that left the system
      const bounceRate = attempts > 0 ? (bounced / attempts) * 100 : 0

      // Decide the advisory. Hard stop dominates pause.
      let status = 'ok'
      let recommendation = 'Bounce rate v normě — můžeš pokračovat.'
      if (bounceRate >= thresholds.bounce_stop_pct) {
        status = 'hard_stop'
        recommendation = `Bounce rate ${bounceRate.toFixed(2)}% ≥ ${thresholds.bounce_stop_pct}% — OKAMŽITĚ zastav kampaň a prověř seznam i schránky.`
      } else if (bounceRate >= thresholds.bounce_pause_pct) {
        status = 'warn_pause'
        recommendation = `Bounce rate ${bounceRate.toFixed(2)}% ≥ ${thresholds.bounce_pause_pct}% — doporučeno pozastavit a prošetřit.`
      }

      res.json({
        campaign_id: campaignId,
        sent,
        bounced,
        failed,
        attempts,
        bounce_rate_pct: Math.round(bounceRate * 100) / 100,
        // Honest: no Seznam FBL, so complaints are not observable (#1161).
        complaint_rate_pct: null,
        complaint_note: 'Stížnosti (spam) nelze měřit — Seznam neposkytuje feedback loop (#1161).',
        thresholds,
        status,          // ok | warn_pause | hard_stop
        recommendation,
        pause_endpoint: `/api/campaigns/${campaignId}/pause`,
        generated_at: new Date().toISOString(),
      })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })
}
