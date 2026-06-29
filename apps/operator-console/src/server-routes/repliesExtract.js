// AV-F3 — Vehicle extraction endpoint for the reply→capture-modal flow.
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/replies/:id/extracted-vehicles
//
// Resolves a reply (matched reply_inbox row or negative-id unmatched_inbound
// row), pulls the best available body representation (outreach_messages text/
// preview when joined; otherwise unmatched_inbound.body_preview; otherwise
// subject), and returns the regex+dictionary extractor output:
//   {
//     vehicles: [{ make, model, year, mileage_km, motohours,
//                  price_offered_eur, body_type, confidence,
//                  matched_text, matched_patterns }],
//     extractor_version: 'regex_v1',
//     cached_at: ISO-string,
//   }
//
// Cache: in-memory Map<reply_id, { payload, expiresAt }>, TTL =
// EXTRACTOR_CONFIG.CACHE_TTL_SECONDS. Cheap because extraction is pure-CPU
// regex with no DB write, but the operator may re-open the same modal
// repeatedly and there's no upside to re-running the regex each time.
//
// Schema verification (HARD RULE feedback_schema_verify_before_sql):
//   psql \d reply_inbox      → id, contact_id, received_at ✓
//   psql \d unmatched_inbound → id, body_preview, subject ✓
//   psql \d outreach_messages → body_text, body_preview, body_html ✓
// Mirrors the body-resolution path already used in replies.js
// GET /api/threads/:id/messages (S2.1 enrich block).
//
// Memory rules:
//   feedback_no_speculation — response shape mirrors VehicleCaptureModal
//     props one-to-one; no invented fields.
//   feedback_no_magic_thresholds — TTL lives in EXTRACTOR_CONFIG, not literal.

import { extractVehicles, EXTRACTOR_CONFIG, EXTRACTOR_VERSION } from '../lib/vehicleExtractor.js'
import { extractVehiclesLLM } from '../lib/ollamaVehicleExtract.js'

// Process-local cache. Map<replyId-string, { payload, expiresAt }>.
// Reset on process restart — acceptable given extraction is cheap.
const cache = new Map()

function cacheKey(replyId) {
  return String(replyId)
}

function getCached(replyId) {
  const entry = cache.get(cacheKey(replyId))
  if (!entry) return null
  if (entry.expiresAt < Date.now()) {
    cache.delete(cacheKey(replyId))
    return null
  }
  return entry.payload
}

function setCached(replyId, payload) {
  cache.set(cacheKey(replyId), {
    payload,
    expiresAt: Date.now() + EXTRACTOR_CONFIG.CACHE_TTL_SECONDS * 1000,
  })
}

// Test-only: drop everything (re-run regex against modified extractor).
export function _clearExtractedVehiclesCache() {
  cache.clear()
}

/**
 * Resolve the best-effort body string for a reply.
 *  - Negative id → unmatched_inbound (body_preview).
 *  - Positive id → reply_inbox row + best-effort outreach_messages join
 *                  (body_text → body_preview → subject).
 * Returns `{ body, subject, reply }` or `null` if not found.
 */
async function resolveReplyBody(pool, replyIdRaw) {
  const replyId = Number(replyIdRaw)
  if (!Number.isFinite(replyId)) return null

  if (replyId < 0) {
    const unmatchedId = -replyId
    const { rows } = await pool.query(
      `SELECT id, from_address, subject, body_preview, received_at
         FROM unmatched_inbound
        WHERE id = $1`,
      [unmatchedId]
    )
    if (!rows.length) return null
    const u = rows[0]
    return {
      body: u.body_preview || '',
      subject: u.subject || '',
      reply: { id: replyId, source: 'unmatched_inbound' },
    }
  }

  // iter62 fix: read the body straight from reply_inbox.body_text/body_html
  // (migration 128 — populated for 56/95 rows). The previous code SELECTed
  // only id/contact_id/subject and then joined `outreach_messages` which has
  // ZERO inbound rows, so the extractor always saw an empty body and the
  // vehicle prefill never worked — the operator had to hand-type every
  // vehicle from the subject line alone. body_text is canonical; fall back to
  // a tag-stripped body_html, then subject.
  const { rows } = await pool.query(
    `SELECT id, contact_id, subject, received_at, body_text, body_html
       FROM reply_inbox
      WHERE id = $1`,
    [replyId]
  )
  if (!rows.length) return null
  const r = rows[0]

  let body = (r.body_text || '').trim()
  if (!body && r.body_html) {
    // Minimal HTML→text: drop tags + collapse whitespace. Good enough to feed
    // the regex extractor (make/model/year/price); not a full sanitizer.
    body = String(r.body_html)
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  return {
    body,
    subject: r.subject || '',
    reply: { id: replyId, source: 'reply_inbox' },
  }
}

/**
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountRepliesExtractRoutes(app, deps) {
  const { pool, capture500, safeError } = deps

  app.get('/api/replies/:id/extracted-vehicles', async (req, res) => {
    try {
      const rawId = req.params.id
      const replyId = Number(rawId)
      if (!Number.isFinite(replyId)) {
        return res.status(400).json({ error: 'invalid id' })
      }

      const cached = getCached(replyId)
      if (cached) {
        return res.json({ ...cached, cache_hit: true })
      }

      const resolved = await resolveReplyBody(pool, replyId)
      if (!resolved) {
        return res.status(404).json({ error: 'not found' })
      }

      // RELATIVE-first: ask Ollama to read the free text; fall back to the
      // regex+dictionary extractor when OLLAMA_URL is unset or the call
      // fails/times out (graceful — never blocks the operator).
      const llm = await extractVehiclesLLM(resolved.body)
      const { vehicles, extractor_version } = llm || extractVehicles(
        resolved.body,
        resolved.subject
      )
      const payload = {
        vehicles,
        extractor_version,
        cached_at: new Date().toISOString(),
        cache_hit: false,
      }
      setCached(replyId, {
        vehicles,
        extractor_version,
        cached_at: payload.cached_at,
      })
      res.json(payload)
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}

// Re-export config for callers that want to surface TTL in operator UI later.
export { EXTRACTOR_CONFIG, EXTRACTOR_VERSION }
