// replyDraft.js — POST /api/replies/:id/draft-reply
//
// On-demand Ollama reply-draft for inbound triage (Odpovědi pane). Loads the
// reply body, asks Ollama to draft a short Czech answer, returns it for the
// operator to read/edit/copy. READ-ONLY: no DB write, no send. The draft is a
// suggestion — deterministic code (the operator's own send) writes final state.

import { draftReply, DRAFT_VERSION } from '../lib/ollamaReplyDraft.js'

// Load a reply body the same way the extractor does (reply_inbox body_text →
// stripped body_html → subject). Mirrors repliesExtract.resolveReplyBody but
// self-contained so this route has no cross-module coupling.
async function loadReplyBody(pool, replyIdRaw) {
  const replyId = Number(replyIdRaw)
  if (!Number.isFinite(replyId) || replyId <= 0) return null
  const { rows } = await pool.query(
    `SELECT id, subject, body_text, body_html FROM reply_inbox WHERE id = $1`,
    [replyId]
  )
  if (!rows.length) return null
  const r = rows[0]
  let body = (r.body_text || '').trim()
  if (!body && r.body_html) {
    body = String(r.body_html)
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return { body, subject: r.subject || '' }
}

/**
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500: Function, safeError: Function }} deps
 */
export function mountReplyDraftRoute(app, deps) {
  const { pool, capture500, safeError } = deps

  app.post('/api/replies/:id/draft-reply', async (req, res) => {
    try {
      const replyId = Number(req.params.id)
      if (!Number.isFinite(replyId)) return res.status(400).json({ error: 'invalid id' })

      const resolved = await loadReplyBody(pool, replyId)
      if (!resolved) return res.status(404).json({ error: 'not found' })
      if (!resolved.body) {
        return res.json({ draft: null, reason: 'no_body', message: 'Tělo zprávy není uloženo — nelze navrhnout odpověď.' })
      }

      const result = await draftReply(resolved.body, resolved.subject)
      if (!result) {
        return res.json({ draft: null, reason: 'llm_unavailable', message: 'Ollama nedostupná — zkus to za chvíli.' })
      }
      // READ-ONLY: the draft is returned for the operator to copy. Nothing is
      // persisted and no mail is sent.
      res.json({ draft: result.draft, model: result.model, version: DRAFT_VERSION })
    } catch (e) { capture500(res, e, safeError) }
  })
}
