// Templates CRUD + ranking + preview route surface.
// ─────────────────────────────────────────────────────────────────────────────
// D2.6 (2026-05-02): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after D2.5 mountScoringRoutes #664). Behavior is byte-equivalent
// to the inline declarations: same SQL, same response shape, same Sentry
// capture, same Express route ordering.
//
// Routes covered (6 total):
//   GET    /api/templates             — list email_templates (created_at DESC)
//   GET    /api/templates/ranking     — per-template reply/open rate (with
//                                       degraded fallback when send_events
//                                       join fails)
//   POST   /api/templates             — insert (requires name)
//   PUT    /api/templates/:id         — update name/subject/body
//   POST   /api/templates/preview     — pure render preview (renderTemplatePreview)
//   DELETE /api/templates/:id         — drop row
//
// Route ordering matters: /api/templates/ranking must be registered BEFORE
// PUT /api/templates/:id (Express path-matching is per-method, but we still
// mirror the original order so introspection / route audits stay stable).
//
// Helpers (renderTemplatePreview) STAY in server.js as the import root. It
// is passed in via `deps` so this mounter can stay free of './../lib/*' dep
// surface — same pattern as scoring.js.

/**
 * Mount the Templates route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 *   renderTemplatePreview: (subject: string, body: string, sample: Record<string, unknown>) => unknown,
 * }} deps
 */
export function mountTemplatesRoutes(app, deps) {
  const { pool, capture500, safeError, renderTemplatePreview } = deps

  app.get('/api/templates', async (req, res) => {
    try { const { rows } = await pool.query(`SELECT * FROM email_templates ORDER BY created_at DESC`); res.json(rows) }
    catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/templates/ranking', async (req, res) => {
    // Caught by 2026-04-30 visual smoke (`/api/templates/ranking → 500`).
    // Original query joined `reply_inbox` and `tracking_events` to count
    // replies/opens. Both joins are fragile: `tracking_events` is missing in
    // some envs (its absence is already swallowed by the .catch shim around
    // line 437), and a LEFT JOIN onto a missing table aborts the whole
    // statement instead of returning NULL.
    //
    // `send_events` records the canonical status (`status='replied'`) — we don't
    // need the auxiliary tables for reply_rate. Fall back to a templates-only
    // query if even `send_events` / `template_variants` is unavailable.
    try {
      // send_events links to a template via template_variant_id →
      // template_variants.base_template_name = email_templates.name. (There is
      // no se.template_id column — that was the long-standing drift that forced
      // this whole block into its zero-analytics fallback.) reply_rate is real;
      // open_rate is fixed 0 — open-pixel tracking was removed (AR2), there is
      // no se.opened_at. Until the Go sender starts populating
      // template_variant_id the per-template counts are legitimately 0, but the
      // query is now schema-correct and lights up automatically once it does.
      const { rows } = await pool.query(`
        SELECT t.id AS template_id, t.name,
               COUNT(DISTINCT se.campaign_id)::int AS campaigns_used,
               COUNT(se.id)::int AS total_sent,
               CASE WHEN COUNT(se.id) > 0
                 THEN ROUND(
                   COUNT(*) FILTER (WHERE se.status = 'replied')::numeric
                   / COUNT(se.id) * 100, 1)
                 ELSE 0 END AS reply_rate,
               0 AS open_rate
        FROM email_templates t
        LEFT JOIN template_variants tv ON tv.base_template_name = t.name
        LEFT JOIN send_events se ON se.template_variant_id = tv.id
        GROUP BY t.id, t.name
        ORDER BY reply_rate DESC
      `)
      // PostgreSQL numeric returns as string from node-postgres. Coerce to
      // number so frontend can call .toFixed() without runtime crash.
      const ranking = rows.map(r => ({
        ...r,
        reply_rate: Number(r.reply_rate) || 0,
        open_rate: Number(r.open_rate) || 0,
      }))
      return res.json({ ranking })
    } catch (primaryErr) {
      // Last-resort fallback: list templates with zero analytics. Prefer a
      // visible-but-empty Templates page over a blocking 500 (the Templates
      // table renders fine with zeroed reply_rate/open_rate — see
      // Templates.jsx useResource hook + stats memo).
      try {
        const { rows } = await pool.query(`
          SELECT id AS template_id, name,
                 0::int AS campaigns_used, 0::int AS total_sent,
                 0 AS reply_rate, 0 AS open_rate
          FROM email_templates
          ORDER BY id DESC
        `)
        return res.json({ ranking: rows, degraded: true })
      } catch {
        return capture500(res, primaryErr, safeError)
      }
    }
  })

  // Compliance gate — operator HARD RULE memory `feedback_no_unsub_url_in_body`
  // (2026-05-07): cold-mail body MUST NOT contain a clickable unsub URL.
  // Opt-out is provided by reply-based path ("stačí odepsat") + STOP keyword.
  // Validation now requires the absence of {{.UnsubURL}} / unsubscribe_url
  // merge tags + /unsubscribe URL substring. Empty body still allowed (drafts).
  // GDPR Art. 21 + zákon č. 480/2004 § 7/4 satisfied via operator-driven
  // suppression on STOP-reply.
  function bodyHasNoUnsubLink(body) {
    if (!body || body.length === 0) return true
    if (/\{\{\s*unsubscribe_url\s*\}\}/i.test(body)) return false
    if (/\{\{\s*\.UnsubURL\s*\}\}/i.test(body)) return false
    if (/\/unsubscribe\b/i.test(body)) return false
    return true
  }

  // AR2 short-URL gate (Sprint AR2 + CLAUDE.md AR5).
  // Short-URL services (bit.ly, t.co, tinyurl.com, etc.) are treated as
  // phishing-like fingerprints by anti-spam filters (same domains used in
  // mass-phish campaigns). Render in services/campaigns/content/template.go
  // already fails hard with ErrShortURL; this pre-check surfaces the error
  // to the operator at save time rather than at first send — earlier feedback,
  // fewer wasted campaign sends.
  // Pattern mirrors Go shortURLRe in services/campaigns/content/template.go.
  const SHORT_URL_RE = /(?:https?:\/\/)?(?:bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|tiny\.cc|is\.gd|buff\.ly|rebrand\.ly|short\.io)\//i

  function bodyHasNoShortURL(body) {
    if (!body || body.length === 0) return true
    return !SHORT_URL_RE.test(body)
  }

  app.post('/api/templates', async (req, res) => {
    const client = await pool.connect()
    try {
      // Defensive: req.body is undefined when content-type is missing or
      // body parser refused to decode. Default to {} so destructure can't throw.
      const { name, subject, body, body_html } = req.body || {}
      // Validation early-returns rely on the `finally { client.release() }` below.
      // Releasing here too double-releases the pooled client (node-postgres throws
      // "Release called on a client which has already been released").
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name required' })
      }
      // Compliance checks apply to both plain body and HTML body — the same
      // forbidden patterns (unsub link, short URLs) must not slip in via HTML.
      if (!bodyHasNoUnsubLink(body) || !bodyHasNoUnsubLink(body_html)) {
        return res.status(400).json({
          error: 'compliance_unsub_link_forbidden',
          message: 'Tělo šablony NESMÍ obsahovat klikatelný odkaz pro odhlášení ({{unsubscribe_url}}, {{.UnsubURL}} ani literál /unsubscribe). Opt-out přes reply + STOP keyword (HARD RULE feedback_no_unsub_url_in_body).',
          action_url: '/templates',
        })
      }
      if (!bodyHasNoShortURL(body) || !bodyHasNoShortURL(body_html)) {
        return res.status(400).json({
          error: 'short_url_in_body',
          message: 'Tělo šablony obsahuje zkrácenou URL (bit.ly, t.co, tinyurl.com atd.). Použijte plnou cílovou URL — zkrácené URL jsou anti-spam fingerprint. (AR2/AR5)',
          action_url: '/templates',
        })
      }
      await client.query('BEGIN')
      const { rows } = await client.query(
        `INSERT INTO email_templates(name,subject,body,body_html) VALUES($1,$2,$3,$4) RETURNING *`,
        [name, subject || '', body || '', body_html || '']
      )
      const newTemplate = rows[0]
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('template_create', 'dashboard', 'template', $1, $2::jsonb)`,
        [String(newTemplate.id), JSON.stringify({ name: newTemplate.name, subject: newTemplate.subject })]
      )
      await client.query('COMMIT')
      res.json(newTemplate)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  app.put('/api/templates/:id', async (req, res) => {
    const client = await pool.connect()
    try {
      // Defensive: req.body is undefined when content-type is missing.
      const { name, subject, body, body_html } = req.body || {}
      // Mirror the POST guard: `name` is bound straight into SET name=$1 with no
      // `|| ''` default (unlike subject/body), so an omitted/blank name would
      // overwrite the column with NULL. Require a non-empty string instead.
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name required' })
      }
      // Validation early-returns rely on `finally { client.release() }` — releasing
      // here too double-releases the pooled client (node-postgres throws).
      if (!bodyHasNoUnsubLink(body) || !bodyHasNoUnsubLink(body_html)) {
        return res.status(400).json({
          error: 'compliance_unsub_link_forbidden',
          message: 'Tělo šablony NESMÍ obsahovat klikatelný odkaz pro odhlášení ({{unsubscribe_url}}, {{.UnsubURL}} ani literál /unsubscribe). Opt-out přes reply + STOP keyword (HARD RULE feedback_no_unsub_url_in_body).',
          action_url: '/templates',
        })
      }
      if (!bodyHasNoShortURL(body) || !bodyHasNoShortURL(body_html)) {
        return res.status(400).json({
          error: 'short_url_in_body',
          message: 'Tělo šablony obsahuje zkrácenou URL (bit.ly, t.co, tinyurl.com atd.). Použijte plnou cílovou URL — zkrácené URL jsou anti-spam fingerprint. (AR2/AR5)',
          action_url: '/templates',
        })
      }
      // body_html is updated only when the field is explicitly present in the
      // payload (omitted = keep DB value untouched, empty string = clear).
      const updateBodyHtml = Object.prototype.hasOwnProperty.call(req.body || {}, 'body_html')
      await client.query('BEGIN')
      const { rows } = updateBodyHtml
        ? await client.query(
            `UPDATE email_templates SET name=$1,subject=$2,body=$3,body_html=$4 WHERE id=$5 RETURNING *`,
            [name, subject || '', body || '', body_html || '', req.params.id]
          )
        : await client.query(
            `UPDATE email_templates SET name=$1,subject=$2,body=$3 WHERE id=$4 RETURNING *`,
            [name, subject || '', body || '', req.params.id]
          )
      if (!rows.length) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Template not found' })
      }
      const updated = rows[0]
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('template_update', 'dashboard', 'template', $1, $2::jsonb)`,
        [String(req.params.id), JSON.stringify({ name: updated.name, subject: updated.subject })]
      )
      await client.query('COMMIT')
      res.json(updated)
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // MVP-5 — template preview. Renders subject + body with sample variables
  // substituted, plus warnings the operator should resolve before send:
  //   - unbalanced merge tags ({{x without }})
  //   - unknown merge tags (not in known set)
  //   - empty subject or body
  //   - missing unsubscribe link reference (compliance)
  // No-op for the actual send path — pure preview for the editor UI.
  app.post('/api/templates/preview', async (req, res) => {
    try {
      const { subject, body, sample } = req.body || {}
      const result = renderTemplatePreview(subject || '', body || '', sample || {})
      res.json(result)
    } catch (e) { capture500(res, e, safeError) }
  })

  app.delete('/api/templates/:id', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Fetch the template for audit details before deletion
      const { rows: [template] } = await client.query(
        'SELECT id, name, subject FROM email_templates WHERE id=$1',
        [req.params.id]
      )
      if (!template) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Template not found' })
      }

      // Delete the template
      await client.query('DELETE FROM email_templates WHERE id=$1', [req.params.id])

      // Audit log the deletion
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('template_delete', 'dashboard', 'template', $1, $2::jsonb)`,
        [String(req.params.id), JSON.stringify({
          id: template.id,
          name: template.name,
          subject: template.subject
        })]
      )

      await client.query('COMMIT')
      res.json({ ok: true })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })
}
