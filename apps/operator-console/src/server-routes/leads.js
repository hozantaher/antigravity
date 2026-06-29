// Leads route surface — sales-qualified replies CRUD slice.
// ─────────────────────────────────────────────────────────────────────────────
// T3.7 (2026-05-01): extracted verbatim from server.js per ADR-008 D2 module
// sequence. Behavior is byte-equivalent: same SQL, same response shape, same
// validation, same Sentry capture.
//
// Routes extracted (2):
//   GET   /api/leads     — list with optional status/sentiment filters
//   PATCH /api/leads/:id — operator updates status/assigned_to/notes
//
// Backed by the `leads` table extended in migration 009. Populated by
// services/orchestrator/thread/inbound.go upsertLead() when the reply
// classifier returns 'interested' or 'meeting'.

/**
 * Mount the Leads route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
// Valid lead statuses (must stay in sync with PATCH handler below).
const VALID_LEAD_STATUSES = new Set(['new', 'contacted', 'qualified', 'qualifying', 'won', 'lost', 'disqualified', 'closed'])

import { clampInt } from '../lib/clampInt.js'

export function mountLeadsRoutes(app, { pool, capture500, safeError }) {
  // POST /api/leads — create a new lead row, optionally promoted from a reply
  // thread. Shape: { contact_id, campaign_id?, title?, stage?, notes?,
  //   source_reply_id?, source_message_id?, mailbox_id? }
  //
  // Duplicate guard: UNIQUE (contact_id, campaign_id) on the leads table.
  // When both contact_id and campaign_id are supplied and a row already
  // exists, return 409 rather than silently inserting a duplicate.
  //
  // Audit: writes operator_audit_log action='lead_create_from_reply' when
  // source_reply_id is present.
  app.post('/api/leads', async (req, res) => {
    try {
      const body = req.body || {}
      const contactId = Number(body.contact_id)
      if (!Number.isFinite(contactId) || contactId <= 0) {
        return res.status(400).json({ error: 'contact_id je povinné a musí být kladné číslo.' })
      }
      const campaignId = body.campaign_id != null ? Number(body.campaign_id) : null
      if (campaignId !== null && (!Number.isFinite(campaignId) || campaignId <= 0)) {
        return res.status(400).json({ error: 'campaign_id musí být kladné číslo.' })
      }
      const mailboxId = body.mailbox_id != null ? Number(body.mailbox_id) : null
      const title = body.title != null ? String(body.title).trim().slice(0, 500) : null
      const rawStage = body.stage != null ? String(body.stage).trim() : 'qualifying'
      if (!VALID_LEAD_STATUSES.has(rawStage)) {
        return res.status(400).json({
          error: `Neplatný stage. Povolené: ${[...VALID_LEAD_STATUSES].join(', ')}.`,
        })
      }
      const notes = body.notes != null ? String(body.notes).slice(0, 5000) : null
      const sourceReplyId = body.source_reply_id != null ? Number(body.source_reply_id) : null
      const sourceMessageId = body.source_message_id != null ? String(body.source_message_id) : null

      // Duplicate detection — when both keys supplied, check for existing row.
      if (campaignId !== null) {
        const { rows: [existing] } = await pool.query(
          `SELECT id FROM leads WHERE contact_id = $1 AND campaign_id = $2 LIMIT 1`,
          [contactId, campaignId],
        )
        if (existing) {
          return res.status(409).json({
            error: 'Lead pro tuto kombinaci kontaktu a kampaně již existuje.',
            lead_id: existing.id,
          })
        }
      }

      const { rows: [lead] } = await pool.query(
        `INSERT INTO leads
           (contact_id, campaign_id, mailbox_id, status, source, notes,
            original_message_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'thread_promote', $5, $6, NOW(), NOW())
         RETURNING *`,
        [contactId, campaignId, mailboxId, rawStage, notes, sourceMessageId],
      )

      // Audit trail — only written when the lead originates from a reply thread.
      if (sourceReplyId != null) {
        await pool.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('lead_create_from_reply', $1, 'lead', $2, $3::jsonb)`,
          [
            'operator',
            String(lead.id),
            JSON.stringify({
              source_reply_id: sourceReplyId,
              source_message_id: sourceMessageId,
              contact_id: contactId,
              campaign_id: campaignId,
            }),
          ],
        ).catch(() => {}) // best-effort — never block the response
      }

      res.status(201).json({ lead })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/leads', async (req, res) => {
    try {
      const { status, sentiment, limit } = req.query
      const limitN = clampInt(parseInt(limit, 10) || 200, 1, 500)
      const where = []
      const params = []
      if (status) { params.push(status); where.push(`l.status = $${params.length}`) }
      if (sentiment) { params.push(sentiment); where.push(`l.sentiment = $${params.length}`) }
      const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : ''
      params.push(limitN)
      const { rows } = await pool.query(
        `SELECT l.id, l.contact_id, l.campaign_id, l.mailbox_id, l.status, l.source,
                l.sentiment, l.classified_at, l.created_at, l.updated_at, l.notes,
                l.original_message_id, l.assigned_to,
                c.email      AS contact_email,
                c.first_name AS contact_first_name,
                c.last_name  AS contact_last_name,
                CONCAT_WS(' ', c.first_name, c.last_name) AS contact_name,
                cm.name      AS campaign_name,
                m.from_address AS mailbox_address
           FROM leads l
           LEFT JOIN contacts c            ON c.id = l.contact_id
           LEFT JOIN campaigns cm          ON cm.id = l.campaign_id
           LEFT JOIN outreach_mailboxes m  ON m.id = l.mailbox_id
           ${whereSQL}
           ORDER BY l.classified_at DESC NULLS LAST, l.created_at DESC
           LIMIT $${params.length}`,
        params
      )
      res.json({ leads: rows, total: rows.length })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.patch('/api/leads/:id', async (req, res) => {
    try {
      const allowed = VALID_LEAD_STATUSES
      const { status, assigned_to, notes } = req.body || {}
      if (status && !allowed.has(status)) {
        return res.status(400).json({ error: `invalid status (allowed: ${[...allowed].join(',')})` })
      }
      const set = []
      const params = []
      if (status !== undefined)      { params.push(status);      set.push(`status = $${params.length}`) }
      if (assigned_to !== undefined) { params.push(assigned_to); set.push(`assigned_to = $${params.length}`) }
      if (notes !== undefined)       { params.push(notes);       set.push(`notes = $${params.length}`) }
      if (!set.length) return res.status(400).json({ error: 'no updatable fields supplied' })
      params.push(req.params.id)
      const { rows } = await pool.query(
        `UPDATE leads SET ${set.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
        params
      )
      if (!rows.length) return res.status(404).json({ error: 'lead not found' })
      res.json({ lead: rows[0] })
    } catch (e) { capture500(res, e, safeError) }
  })
}
