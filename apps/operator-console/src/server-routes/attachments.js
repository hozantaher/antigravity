// BFF attachment blob streaming endpoint.
// ─────────────────────────────────────────────────────────────────────────────
// Implements issue #874 — inbound attachments (images/PDF/other) are stored as
// BYTEA in `message_attachments.data` (migration 013). This module exposes a
// single endpoint that streams that blob to the operator browser so the
// ThreadDetail UI can render thumbnail images and offer download links for
// non-image files.
//
// Route:
//   GET /api/attachments/:id/blob
//
// Security:
//   - Auth is enforced globally by createAuthMiddleware() (X-API-Key header).
//     This module does NOT re-check auth; the global middleware runs first for
//     every /api/* route.
//   - Content-Type is read from the DB row and validated: only image/* types
//     are served with their real MIME type. All other types are served as
//     application/octet-stream so the browser downloads them rather than
//     executing them (XSS prevention for HTML/SVG/etc).
//   - Content-Disposition: inline for images, attachment for everything else.
//   - Content-Length is set from size_bytes so the browser can show progress.
//   - No partial content (Range) support — blobs are ≤10 MB per migration 013
//     size policy, so full-response is fine for operator tooling.
//
// Memory rules:
//   feedback_extreme_testing  (T0)  — tests in tests/contract/bff-attachments.contract.test.ts
//   feedback_no_speculation   (T0)  — column names derived from migrations/013_message_attachments.sql
//   feedback_search_before_implement (T0) — read existing cidRewrite + replies.js first

const SAFE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml', // served as octet-stream below — listed for completeness
])

/**
 * Returns true when the content_type should be rendered inline in a browser
 * <img> tag. SVG is intentionally excluded (XSS vector when embedded inline).
 *
 * @param {string} ct
 */
function isSafeInlineImage(ct) {
  if (!ct || typeof ct !== 'string') return false
  const normalized = ct.split(';')[0].trim().toLowerCase()
  return (
    normalized !== 'image/svg+xml' &&
    normalized.startsWith('image/')
  )
}

/**
 * Mount the attachment blob streaming surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountAttachmentsRoutes(app, { pool, safeError }) {
  // GET /api/attachments/:id/blob
  // Streams the raw bytes of a message_attachments row back to the caller.
  // Requires X-API-Key (enforced by global auth middleware).
  app.get('/api/attachments/:id/blob', async (req, res) => {
    const idStr = req.params.id
    const id = parseInt(idStr, 10)
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'invalid attachment id' })
    }

    try {
      const { rows } = await pool.query(
        `SELECT filename, content_type, size_bytes, data
           FROM message_attachments
          WHERE id = $1`,
        [id]
      )

      if (rows.length === 0) {
        return res.status(404).json({ error: 'not found' })
      }

      const row = rows[0]
      const filename = row.filename || 'attachment'
      const rawCt = (row.content_type || '').split(';')[0].trim().toLowerCase()

      // Determine safe MIME type to serve — never trust stored type for rendering.
      // image/* (except SVG) → serve inline with real type.
      // Everything else (PDF, SVG, HTML, binary, ...) → force download.
      const serveCt = isSafeInlineImage(rawCt) ? rawCt : 'application/octet-stream'
      const disposition = isSafeInlineImage(rawCt)
        ? `inline; filename="${encodeURIComponent(filename)}"`
        : `attachment; filename="${encodeURIComponent(filename)}"`

      res.set({
        'Content-Type': serveCt,
        'Content-Disposition': disposition,
        'Content-Length': String(row.size_bytes || (row.data ? row.data.length : 0)),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      })

      // row.data is a Node.js Buffer (pg returns BYTEA as Buffer).
      return res.end(row.data)
    } catch (e) {
      console.error('[attachments/blob] error:', safeError(e))
      return res.status(500).json({ error: safeError(e) })
    }
  })
}
