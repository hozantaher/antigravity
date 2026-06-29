// AW8-3 — Failed sends triage endpoint.
//
// GET /api/failed-sends?since_days=<n>&limit=<n>&campaign_id=<id?>
//
// Returns send_events rows with status='failed' from the last N days (default 7,
// max 30) joined with contacts + campaigns for operator-friendly display.
// Drives the "Failed Sends" filter on the Replies page.
//
// Per-row error_message comes from `smtp_response` (canonical relay-emitted
// error per migration 033_legacy_send_events_schema.sql). PR #1184 minlog
// unmask makes these strings useful — they're no longer just "minlog:masked"
// for failed sends specifically.
//
// retry_count is approximated as the number of distinct send_events rows for
// the same (campaign_id, contact_id) pair across the entire sequence — the
// count includes successful retries that ultimately led to failure.
//
// POST /api/failed-sends/:cc_id/reset
//
// Resets a single campaign_contacts row with status='failed' back to 'pending'
// so the next send-batch tick picks it up. Body must include {confirm:true}.
// HARD RULE feedback_anti_trace_full_stack: this endpoint NEVER calls SMTP
// directly — it only flips the DB row. Operator follows up with
// POST /api/campaigns/:id/send-batch?count=1 (which goes through the relay's
// anti-trace pipeline). The split avoids reproducing the send-batch policy
// surface (X-Confirm-Send / send-window / rate-limit) here.
//
// Response shapes:
//   GET  /api/failed-sends    →  { ok, count, rows:[…], generated_at }
//   POST /api/failed-sends/:cc_id/reset
//        Success → 200  { ok:true,  reset:true,  cc_id, previous_status }
//        Already → 200  { ok:true,  reset:false, cc_id, current_status, reason }
//        Missing → 404  { ok:false, error }
//        Unsafe  → 412  { ok:false, error: 'confirm body field required' }
//
// PII guard (feedback_no_pii_in_commands): the GET response includes contact
// emails because the Replies UI already displays from_email everywhere — this
// is operator-facing, not appended to commands. The reset endpoint returns
// only the cc_id so audit-log writes do not leak PII into details JSON.

/**
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500?: Function, safeError?: Function }} deps
 */
export function mountFailedSendsRoutes(app, { pool, capture500, safeError } = {}) {
  app.get('/api/failed-sends', async (req, res) => {
    try {
      const sinceDaysRaw = Number(req.query.since_days ?? 7)
      const sinceDays = Number.isFinite(sinceDaysRaw)
        ? Math.max(1, Math.min(30, Math.floor(sinceDaysRaw)))
        : 7

      const limitRaw = Number(req.query.limit ?? 100)
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(500, Math.floor(limitRaw)))
        : 100

      const campaignIdRaw = req.query.campaign_id
      const campaignId = campaignIdRaw && /^\d+$/.test(String(campaignIdRaw))
        ? Number(campaignIdRaw)
        : null

      const params = [String(sinceDays)]
      let where = `se.status = 'failed' AND se.sent_at > now() - ($1 || ' days')::interval`
      if (campaignId) {
        params.push(campaignId)
        where += ` AND se.campaign_id = $${params.length}`
      }
      params.push(limit)

      // Notes:
      //   - retry_count: COUNT over (campaign_id, contact_id) — the join key
      //     for an outbound attempt-stream — across all status values.
      //   - cc_id: campaign_contacts row id, needed for the reset endpoint.
      //   - LEFT JOINs on contacts/campaigns tolerate orphan send_events rows
      //     (e.g. contact deleted via DSR after send) instead of dropping them.
      const sql = `
        SELECT
          se.id,
          se.campaign_id,
          se.contact_id,
          se.message_id,
          se.smtp_response,
          se.mailbox_used,
          se.sent_at,
          c.email          AS contact_email,
          c.first_name     AS contact_first_name,
          c.last_name      AS contact_last_name,
          camp.name        AS campaign_name,
          cc.id            AS cc_id,
          cc.status        AS cc_status,
          (
            SELECT COUNT(*)::int FROM send_events se2
            WHERE se2.campaign_id = se.campaign_id
              AND se2.contact_id  = se.contact_id
          ) AS retry_count
        FROM send_events se
        LEFT JOIN contacts  c    ON c.id    = se.contact_id
        LEFT JOIN campaigns camp ON camp.id = se.campaign_id
        LEFT JOIN campaign_contacts cc
               ON cc.campaign_id = se.campaign_id
              AND cc.contact_id  = se.contact_id
        WHERE ${where}
        ORDER BY se.sent_at DESC
        LIMIT $${params.length}
      `

      const { rows } = await pool.query(sql, params)
      return res.json({
        ok: true,
        since_days: sinceDays,
        campaign_id: campaignId,
        count: rows.length,
        rows,
        generated_at: new Date().toISOString(),
      })
    } catch (e) {
      // Schema gap — be resilient if send_events / campaign_contacts missing.
      if (e?.code === '42P01') {
        return res.json({
          ok: false,
          reason: 'send_events / campaign_contacts table not present',
          rows: [],
          count: 0,
          generated_at: new Date().toISOString(),
        })
      }
      if (capture500) return capture500(res, e, safeError)
      console.error('[failedSends] error:', e?.message || e)
      return res.status(500).json({ ok: false, error: e?.message || 'internal error' })
    }
  })

  // POST /api/failed-sends/:cc_id/reset — flip campaign_contacts.status back to 'pending'.
  // No SMTP path here. Operator follows up with /api/campaigns/:id/send-batch.
  app.post('/api/failed-sends/:cc_id/reset', async (req, res) => {
    try {
      if (!/^\d+$/.test(String(req.params.cc_id))) {
        return res.status(400).json({ ok: false, error: 'invalid cc_id' })
      }
      const ccId = Number(req.params.cc_id)
      const confirm = req.body && req.body.confirm === true
      if (!confirm) {
        return res.status(412).json({
          ok: false,
          error: 'confirm body field required',
          hint: 'POST { "confirm": true } to confirm the reset (no SMTP fired here).',
        })
      }

      // HARD RULE feedback_audit_log_on_mutations: the status flip and its
      // audit row must be atomic. Previously the UPDATE + audit were separate
      // pool.query calls with the audit in a swallowing try/catch, so a 200
      // {reset:true} could ship with no audit row. One BEGIN/COMMIT now binds
      // them: if the audit INSERT fails, the re-arm is rolled back too.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Atomic flip — only flips rows currently in 'failed' so we can't undo a successful send.
        const upd = await client.query(
          `
            UPDATE campaign_contacts
               SET status = 'pending',
                   updated_at = now()
             WHERE id = $1 AND status = 'failed'
          RETURNING id, campaign_id, contact_id, status
          `,
          [ccId],
        )

        if (upd.rowCount === 0) {
          // Either the row doesn't exist or it's not in 'failed' state.
          // No mutation occurred — abandon the tx and report the current state.
          const { rows: probe } = await client.query(
            `SELECT id, status FROM campaign_contacts WHERE id = $1`,
            [ccId],
          )
          await client.query('ROLLBACK')
          if (probe.length === 0) {
            return res.status(404).json({ ok: false, error: 'campaign_contact not found' })
          }
          return res.json({
            ok: true,
            reset: false,
            cc_id: ccId,
            current_status: probe[0].status,
            reason: 'row not in failed state',
          })
        }

        // Audit row — actor identity from header chain (P1.10 pattern).
        const actor = req.headers['x-operator-id'] || req.user?.email || req.user?.id || 'dashboard'
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('failed_send_reset', $1, 'campaign_contact', $2, $3::jsonb)`,
          [
            String(actor),
            String(ccId),
            JSON.stringify({
              cc_id: ccId,
              campaign_id: upd.rows[0].campaign_id,
              previous_status: 'failed',
              new_status: 'pending',
              at: new Date().toISOString(),
            }),
          ],
        )

        await client.query('COMMIT')

        return res.json({
          ok: true,
          reset: true,
          cc_id: ccId,
          previous_status: 'failed',
          new_status: 'pending',
          campaign_id: upd.rows[0].campaign_id,
        })
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {})
        throw txErr
      } finally {
        client.release()
      }
    } catch (e) {
      if (capture500) return capture500(res, e, safeError)
      console.error('[failedSends/reset] error:', e?.message || e)
      return res.status(500).json({ ok: false, error: e?.message || 'internal error' })
    }
  })
}
