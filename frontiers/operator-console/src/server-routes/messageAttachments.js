// messageAttachments.js — Sprint B2 (issue #1248)
//
// GET /api/messages/:id/attachments/:idx
//
// Streams a single attachment by:
//   - positive id → message_attachments (FK outreach_messages, matched thread)
//   - negative id → unmatched_inbound_attachments (FK unmatched_inbound, orphan)
//
// idx is the zero-based position within the message's attachment list.
// Same convention as the orchestrator writes (sequential idx, no gaps).
//
// Response: raw BYTEA stream with Content-Type from DB and
// Content-Disposition: inline for image/*, attachment for everything else
// (operator UI uses inline for cid: img refs, download for the rest).
//
// Memory:
//   feedback_no_pii_in_commands — we don't log filenames inline (they may
//   contain sender PII). Log only the (id, idx, size, hash prefix).
//   feedback_search_before_implement — existing attachments.js mounter
//   serves outbound attachments from message_attachments by different ID
//   shape (mounted at /api/replies/:id/attachments — keep separate to
//   avoid disturbing existing flow).

export function mountMessageAttachmentsRoutes(app, { pool, capture500, safeError }) {
  // List metadata for all attachments of a reply (no BYTEA — just the
  // operator-facing manifest so the UI can render a strip with download
  // links). Same signed-ID convention as the streaming endpoint.
  app.get('/api/replies/:id/attachments', async (req, res) => {
    try {
      const rawId = Number(req.params.id)
      if (!Number.isFinite(rawId) || rawId === 0) {
        return res.status(400).json({ error: 'invalid id' })
      }
      if (rawId < 0) {
        const { rows } = await pool.query(
          `SELECT idx, filename, content_type, size_bytes, sha256, is_inline
             FROM unmatched_inbound_attachments
            WHERE unmatched_id = $1
            ORDER BY idx ASC`,
          [-rawId],
        )
        return res.json({
          ok: true,
          message_id: rawId,
          source: 'unmatched_inbound',
          attachments: rows,
        })
      }
      // Prefer reply_inbox_attachments (migration 144) — byte-backed, so the
      // manifest's idx maps to a servable blob (thumbnails render). Falls back
      // to reply_inbox.attachments_meta for replies ingested before 144 (meta
      // only — filenames show, no thumbnail).
      const { rows: ra } = await pool.query(
        `SELECT idx, filename, content_type, size_bytes, sha256, is_inline
           FROM reply_inbox_attachments WHERE reply_inbox_id = $1 ORDER BY idx ASC`,
        [rawId],
      )
      if (ra.length) {
        return res.json({ ok: true, message_id: rawId, source: 'reply_inbox_attachments', attachments: ra })
      }
      const { rows: r } = await pool.query(
        `SELECT attachments_meta, source_unmatched_id FROM reply_inbox WHERE id = $1 LIMIT 1`,
        [rawId],
      )
      if (!r.length) return res.status(404).json({ error: 'not found' })
      // Promoted-from-orphan reply (migration 145): its byte-backed photos live
      // under the original unmatched_id. Serve those (servable thumbnails).
      if (r[0].source_unmatched_id) {
        const { rows: ua } = await pool.query(
          `SELECT idx, filename, content_type, size_bytes, sha256, is_inline
             FROM unmatched_inbound_attachments WHERE unmatched_id = $1 ORDER BY idx ASC`,
          [r[0].source_unmatched_id],
        )
        if (ua.length) {
          return res.json({ ok: true, message_id: rawId, source: 'reply_inbox_via_unmatched', attachments: ua })
        }
      }
      const meta = Array.isArray(r[0].attachments_meta) ? r[0].attachments_meta : []
      const attachments = meta.map((a, i) => ({
        idx: i,
        filename: a.filename || a.name || `příloha-${i + 1}`,
        content_type: a.content_type || a.mime_type || 'application/octet-stream',
        size_bytes: a.size_bytes ?? a.size ?? null,
        sha256: a.sha256 || '',
        is_inline: a.is_inline ?? false,
      }))
      res.json({
        ok: true,
        message_id: rawId,
        source: 'reply_inbox',
        attachments,
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/messages/:id/attachments/:idx', async (req, res) => {
    try {
      const rawId = Number(req.params.id)
      const idx = Number(req.params.idx)
      if (!Number.isFinite(rawId) || rawId === 0 || !Number.isFinite(idx) || idx < 0) {
        return res.status(400).json({ error: 'invalid id or idx' })
      }

      if (rawId < 0) {
        // Orphan attachment — unmatched_inbound_attachments keyed on
        // (unmatched_id, idx). Negative ID convention: -N → row N.
        const { rows } = await pool.query(
          `SELECT filename, content_type, size_bytes, data, sha256, is_inline
             FROM unmatched_inbound_attachments
            WHERE unmatched_id = $1 AND idx = $2`,
          [-rawId, idx],
        )
        if (!rows.length) return res.status(404).json({ error: 'attachment not found' })
        const a = rows[0]
        return streamAttachment(res, a)
      }

      // Matched reply attachment. As of migration 144 the orchestrator persists
      // matched-reply attachment BYTES to reply_inbox_attachments (keyed by
      // reply_inbox_id + idx) — message_attachments (Schema-B) is empty in this
      // deployment. This is what makes hot-lead seller photos servable
      // (RCA 2026-06-01 "netěží fotky").
      const { rows } = await pool.query(
        `SELECT filename, content_type, size_bytes, data, sha256, is_inline
           FROM reply_inbox_attachments
          WHERE reply_inbox_id = $1 AND idx = $2`,
        [rawId, idx],
      )
      if (rows.length) return streamAttachment(res, rows[0])
      // Promoted-from-orphan reply (migration 145): photos under the original
      // unmatched_id.
      const { rows: link } = await pool.query(
        `SELECT source_unmatched_id FROM reply_inbox WHERE id = $1 LIMIT 1`,
        [rawId],
      )
      if (link.length && link[0].source_unmatched_id) {
        const { rows: ua } = await pool.query(
          `SELECT filename, content_type, size_bytes, data, sha256, is_inline
             FROM unmatched_inbound_attachments WHERE unmatched_id = $1 AND idx = $2`,
          [link[0].source_unmatched_id, idx],
        )
        if (ua.length) return streamAttachment(res, ua[0])
      }
      return res.status(404).json({ error: 'attachment not found' })
    } catch (e) { capture500(res, e, safeError) }
  })
}

function streamAttachment(res, row) {
  const isImage = String(row.content_type || '').startsWith('image/')
  const disposition = (isImage || row.is_inline) ? 'inline' : 'attachment'
  // RFC 5987 filename* would be ideal for non-ASCII but most browsers
  // also accept plain quoted filename with UTF-8 bytes. Default to a safe
  // fallback if the filename is empty (operator UI can still download).
  const filename = row.filename && row.filename.trim() ? row.filename : `attachment-${row.sha256.slice(0, 8) || 'unknown'}`
  res.setHeader('Content-Type', row.content_type || 'application/octet-stream')
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename.replace(/"/g, '')}"`)
  res.setHeader('Content-Length', String(row.size_bytes || row.data.length))
  // SHA-256 lets the client cache by content. ETag is the canonical header.
  if (row.sha256) res.setHeader('ETag', `"sha256-${row.sha256}"`)
  // Cache aggressively — attachments are immutable once stored.
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.end(row.data)
}
