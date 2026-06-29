// repliesRepository.js — Sprint B1 (issue #1247)
//
// Unified data access for replies in the operator inbox.
//
// Background: `/api/replies` is a UNION over two physical tables:
//   - reply_inbox          — matched replies tied to a send_event
//   - unmatched_inbound    — orphan replies the orchestrator couldn't tie
//                            to any thread (no Message-ID/References match)
//
// The route layer exposes both behind a single ID space using a sign
// convention: positive ID → reply_inbox.id, negative ID → -unmatched_inbound.id.
// Before this repository every handler that took :id had its own
// `if (rawId < 0)` branch, duplicating the routing logic four ways and
// inviting drift.
//
// This module is the single source of truth. Handlers call findById,
// markHandled, classify — they don't care which table answers.
//
// Memory:
//   feedback_no_pii_in_commands — no inline emails in logs.
//   feedback_search_before_implement — repo grep before adding more
//   if (rawId < 0) branches.

const REPLY_INBOX = 'reply_inbox'
const UNMATCHED_INBOUND = 'unmatched_inbound'

/**
 * Translate the operator-facing reply ID into (source, physicalId).
 *
 * @param {number|string} rawId
 * @returns {{ source: 'reply_inbox' | 'unmatched_inbound', physicalId: number } | null}
 */
export function classifyReplyId(rawId) {
  const n = Number(rawId)
  if (!Number.isFinite(n) || n === 0) return null
  return n < 0
    ? { source: UNMATCHED_INBOUND, physicalId: -n }
    : { source: REPLY_INBOX, physicalId: n }
}

/**
 * Fetch a single reply by operator-facing ID. Returns the unified shape
 * regardless of which table answered:
 *
 * {
 *   id: number,                     // back to operator-facing signed ID
 *   source: 'reply_inbox' | 'unmatched_inbound',
 *   from_email: string,
 *   subject: string,
 *   body_preview: string | null,
 *   body_html: string | null,       // only populated when present in DB
 *   received_at: string,
 *   handled: boolean,
 *   handled_at: string | null,
 *   classification: string | null,  // null for unmatched_inbound
 *   message_id: string | null,
 *   in_reply_to: string | null,
 *   contact_id: number | null,      // null for unmatched_inbound
 *   campaign_id: number | null,     // null for unmatched_inbound
 *   send_event_id: number | null,   // null for unmatched_inbound
 * }
 *
 * Returns null when no row matches.
 *
 * @param {import('pg').Pool} pool
 * @param {number|string} rawId
 */
export async function findById(pool, rawId) {
  const classified = classifyReplyId(rawId)
  if (!classified) return null
  const { source, physicalId } = classified

  if (source === REPLY_INBOX) {
    const { rows } = await pool.query(
      `SELECT id, from_email, subject, body_preview, body_html, received_at,
              handled, handled_at, classification, pre_classification, message_id, in_reply_to,
              contact_id, campaign_id, send_event_id
         FROM reply_inbox WHERE id = $1`,
      [physicalId],
    )
    if (!rows.length) return null
    const r = rows[0]
    return {
      id: Number(r.id),
      source: REPLY_INBOX,
      from_email: r.from_email,
      subject: r.subject,
      body_preview: r.body_preview ?? null,
      body_html: r.body_html ?? null,
      received_at: r.received_at,
      handled: r.handled,
      handled_at: r.handled_at,
      classification: r.classification ?? null,
      // pre_classification (JSONB) carries the automatic classifier's output —
      // {intent, confidence, classifier_version}. Surfaced so the operator
      // sees how confident the machine was before overriding (#1020).
      pre_classification: r.pre_classification ?? null,
      message_id: r.message_id ?? null,
      in_reply_to: r.in_reply_to ?? null,
      contact_id: r.contact_id ?? null,
      campaign_id: r.campaign_id ?? null,
      send_event_id: r.send_event_id ?? null,
    }
  }

  // unmatched_inbound — has fewer columns (no contact / campaign / classification).
  const { rows } = await pool.query(
    `SELECT id, from_address, subject, body_preview, message_id, in_reply_to,
            received_at, reviewed, reviewed_at
       FROM unmatched_inbound WHERE id = $1`,
    [physicalId],
  )
  if (!rows.length) return null
  const u = rows[0]
  return {
    id: -Number(u.id),
    source: UNMATCHED_INBOUND,
    from_email: u.from_address,
    subject: u.subject ?? '',
    body_preview: u.body_preview ?? null,
    body_html: null,
    received_at: u.received_at,
    handled: u.reviewed,
    handled_at: u.reviewed_at,
    classification: null,
    message_id: u.message_id ?? null,
    in_reply_to: u.in_reply_to ?? null,
    contact_id: null,
    campaign_id: null,
    send_event_id: null,
  }
}

/**
 * Toggle the handled/reviewed flag in the correct table.
 *
 * @param {import('pg').Pool} pool
 * @param {number|string} rawId
 * @param {boolean} handled
 * @returns {Promise<{ ok: true, source: string, physicalId: number } | { ok: false, error: 'not_found' | 'invalid_id' }>}
 */
export async function setHandled(pool, rawId, handled) {
  const classified = classifyReplyId(rawId)
  if (!classified) return { ok: false, error: 'invalid_id' }
  const { source, physicalId } = classified

  if (source === REPLY_INBOX) {
    const { rowCount } = await pool.query(
      `UPDATE reply_inbox
          SET handled = $1,
              handled_at = CASE WHEN $1 THEN now() ELSE NULL END
        WHERE id = $2`,
      [!!handled, physicalId],
    )
    if (!rowCount) return { ok: false, error: 'not_found' }
    return { ok: true, source, physicalId }
  }

  const { rowCount } = await pool.query(
    `UPDATE unmatched_inbound
        SET reviewed = $1,
            reviewed_at = CASE WHEN $1 THEN now() ELSE NULL END
      WHERE id = $2`,
    [!!handled, physicalId],
  )
  if (!rowCount) return { ok: false, error: 'not_found' }
  return { ok: true, source, physicalId }
}

/**
 * Set the classification on a reply. For unmatched_inbound (no
 * classification column) it acts as "mark reviewed" + propagates
 * negative/unsubscribe into outreach_suppressions.
 *
 * @param {import('pg').Pool} pool
 * @param {number|string} rawId
 * @param {string|null} classification
 * @returns {Promise<{ ok: true, source: string, from_email: string|null,
 *   was_previous: string|null } | { ok: false, error: string }>}
 */
export async function setClassification(pool, rawId, classification) {
  const classified = classifyReplyId(rawId)
  if (!classified) return { ok: false, error: 'invalid_id' }
  const { source, physicalId } = classified

  if (source === REPLY_INBOX) {
    // Capture previous classification for override-audit (KT-B4).
    let wasPrevious = null
    if (classification !== undefined && classification !== null) {
      const { rows: [pre] } = await pool.query(
        `SELECT classification FROM reply_inbox WHERE id = $1`,
        [physicalId],
      )
      if (pre) wasPrevious = pre.classification ?? null
    }
    const { rows: [reply] } = await pool.query(
      `UPDATE reply_inbox
          SET classification = COALESCE($1, classification),
              handled = TRUE,
              handled_at = now()
        WHERE id = $2
        RETURNING id, from_email, contact_id, campaign_id, classification,
                  handled, handled_at`,
      [classification ?? null, physicalId],
    )
    if (!reply) return { ok: false, error: 'not_found' }
    return {
      ok: true,
      source,
      reply,
      from_email: reply.from_email,
      was_previous: wasPrevious,
    }
  }

  // unmatched_inbound — UPDATE reviewed, return surface for downstream
  // suppression logic.
  const { rows: [u] } = await pool.query(
    `UPDATE unmatched_inbound
        SET reviewed = TRUE, reviewed_at = now()
      WHERE id = $1
      RETURNING id, from_address, subject`,
    [physicalId],
  )
  if (!u) return { ok: false, error: 'not_found' }
  return {
    ok: true,
    source,
    from_email: u.from_address,
    was_previous: null,
  }
}
