// Protections route surface — Ochrany panel diagnostic endpoints backing the
// protection verification matrix, per-message trace drawer, banner alerts,
// and 24h trace coverage gauge.
// ─────────────────────────────────────────────────────────────────────────────
// D2.8 (2026-05-02): extracted verbatim from server.js per ADR-008 D2 module
// sequence. Behavior is byte-equivalent to the inline declarations: same SQL,
// same response shape, same Sentry capture, same Express route ordering.
//
// MEMORY: project_protection_matrix (T1) — Ochrany panel = 12×2 cells
// (12 layers × 2 levels = L2/L3). The /api/protections/matrix response shape
// must remain stable: each probe = { layer, level, status, detail, latency_ms,
// expected, actual, checked_at }. UI pins layer names client-side so a missing
// layer renders as "unknown" — DO NOT change row keys without UI coordination.
//
// Routes covered (5 total):
//   GET  /api/protections/matrix              — latest probe per (layer, level)
//   GET  /api/protections/trace/:messageId    — per-send protection trace (S6)
//   GET  /api/protections/alerts              — open + acked alerts (S7)
//   POST /api/protections/alerts/:id/ack      — operator silences a banner
//   GET  /api/protections/coverage            — 24h trace coverage gauge

/**
 * Mount the Protections route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountProtectionsRoutes(app, deps) {
  const { pool, capture500, safeError } = deps

  // ── Protection verification matrix ─────────────────────────────────
  // Returns the latest row per (layer, level) from protection_probes
  // (migration 041). Consumers: Mailboxes AnonymizationBar, future
  // OchranyPanel drawer. Response shape is stable — UI pins the
  // layer names client-side so a missing layer renders as "unknown".
  app.get('/api/protections/matrix', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (layer, level)
          layer,
          level,
          status,
          COALESCE(detail, '')   AS detail,
          COALESCE(latency_ms, 0) AS latency_ms,
          COALESCE(expected, '{}'::jsonb) AS expected,
          COALESCE(actual,   '{}'::jsonb) AS actual,
          checked_at
        FROM protection_probes
        ORDER BY layer, level, checked_at DESC
      `)
      res.json({
        probes: rows.map(r => ({
          layer: r.layer,
          level: r.level,
          status: r.status,
          detail: r.detail,
          latency_ms: r.latency_ms,
          expected: r.expected,
          actual: r.actual,
          checked_at: r.checked_at,
        })),
        generated_at: new Date().toISOString(),
      })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })

  // ── Per-send protection trace (S6) ───────────────────────────────
  // Returns the protection layers that were active when a specific message
  // was sent. message_id comes from send_events.message_id — the caller
  // typically gets it from the send detail drawer.
  app.get('/api/protections/trace/:messageId', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          pt.message_id,
          pt.layers,
          se.sent_at     AS traced_at,
          se.campaign_id,
          se.contact_id,
          se.mailbox_used,
          se.status      AS send_status,
          se.sent_at
        FROM protection_trace pt
        LEFT JOIN send_events se ON se.message_id = pt.message_id
        WHERE pt.message_id = $1
        ORDER BY se.sent_at DESC
        LIMIT 1
      `, [req.params.messageId])
      if (!rows.length) return res.status(404).json({ error: 'not found' })
      const r = rows[0]
      res.json({
        message_id:   r.message_id,
        layers:       r.layers,
        traced_at:    r.traced_at,
        send_context: {
          campaign_id:  r.campaign_id,
          contact_id:   r.contact_id,
          mailbox_used: r.mailbox_used,
          send_status:  r.send_status,
          sent_at:      r.sent_at,
        },
      })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })

  // ── Protection alerts (S7) ────────────────────────────────────────
  // GET /api/protections/alerts — open + acked alerts for the banner.
  app.get('/api/protections/alerts', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          id, layer, level, severity, status,
          consecutive_failures, last_status, detail,
          fired_at, acked_at, updated_at
        FROM protection_alerts
        WHERE status IN ('open', 'acked')
        -- severity is a string enum {critical,warning}; alphabetical DESC ranks
        -- 'warning' ABOVE 'critical'. Order by an explicit severity rank so the
        -- most-severe alert sorts first regardless of lexical order.
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, fired_at ASC
      `)
      res.json({ alerts: rows, generated_at: new Date().toISOString() })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })

  // POST /api/protections/alerts/:id/ack — operator silences a banner.
  app.post('/api/protections/alerts/:id/ack', async (req, res) => {
    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')
      const { rowCount } = await client.query(
        `UPDATE protection_alerts
            SET status = 'acked', acked_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'open'
         RETURNING id`,
        [req.params.id]
      )
      if (rowCount === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not found or already acked' })
      }
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('protection_alert_ack', 'dashboard', 'protection_alert', $1, $2::jsonb)`,
        [String(req.params.id), JSON.stringify({ acked_at: new Date().toISOString() })]
      )
      await client.query('COMMIT')
      res.json({ ok: true })
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK') } catch {} }
      return capture500(res, e, safeError)
    } finally {
      if (client) client.release()
    }
  })

  // ── Protection trace coverage gauge ──────────────────────────────
  // Returns the 24h coverage %: what fraction of sent messages have a
  // protection_trace row. A value < 100% indicates the trace pipeline
  // dropped rows (DB write failures or engine rollouts).
  app.get('/api/protections/coverage', async (_req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(se.id)                              AS total_sent,
          COUNT(pt.message_id)                      AS traced,
          CASE WHEN COUNT(se.id) = 0 THEN NULL
               ELSE ROUND(COUNT(pt.message_id) * 100.0 / COUNT(se.id), 1)
          END                                       AS coverage_pct
        FROM send_events se
        LEFT JOIN protection_trace pt ON pt.message_id = se.message_id
        WHERE se.sent_at >= now() - interval '24 hours'
          AND se.status = 'sent'
      `)
      const r = rows[0]
      res.json({
        total_sent:   Number(r.total_sent),
        traced:       Number(r.traced),
        coverage_pct: r.coverage_pct !== null ? Number(r.coverage_pct) : null,
        window_hours: 24,
      })
    } catch (e) {
      return capture500(res, e, safeError)
    }
  })
}
