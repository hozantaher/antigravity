// vehicleCapture.js — shared reply→vehicle linking + automated capture.
//
// North-star: maximally interlink the data we already have. A reply arrives
// from a prospect who wants to SELL machinery (hot lead — Hozan KUPUJE
// techniku). The reply body names the vehicle (make / model / year / mileage
// / price). We want that vehicle to land in the `vehicles` inventory tab
// AUTOMATICALLY, fully linked to the sender's contact → company → crm_client,
// instead of waiting for the operator to click "Zapsat vozidlo" by hand.
//
// Two consumers share this module (DRY — feedback_search_before_implement T0):
//   1. POST /api/vehicles            — operator manual capture (vehicles.js)
//   2. runVehicleAutoCaptureCron     — automated sweep over incoming replies
//
// HARD RULES followed:
//   - feedback_anti_trace / "LLM never auto-applies destructive actions":
//     the AUTOMATED path uses ONLY the deterministic regex_v2 extractor.
//     The Ollama (relative LLM) extractor stays behind the operator-triggered
//     on-demand endpoint — a hallucinated make/model must never silently
//     create inventory rows.
//   - feedback_no_magic_thresholds T0 — CAPTURE_MIN_CONFIDENCE +
//     CAPTURE_MAX_PER_REPLY are named, tunable constants.
//   - feedback_audit_log_on_mutations T0 — every INSERT writes
//     operator_audit_log (action='vehicle_auto_captured' / 'vehicle_created').
//
// Deliberately does NOT mark the source reply handled: auto-capture must not
// hide a reply from the operator's triage queue. The operator still classifies
// the lead; capture is an additive, reviewable, deletable side effect.

import { extractVehicles, EXTRACTOR_VERSION } from './vehicleExtractor.js'

// Brand-only matches (no model, no facts) score ~0.5; below this we treat the
// hit as noise and skip it so the inventory doesn't fill with bare brand
// mentions ("máme tu starou Avii na dvoře" with no offer).
export const CAPTURE_MIN_CONFIDENCE = 0.5

// A single reply yielding more than this many vehicles is almost certainly a
// forwarded bazos digest / signature spam, not a genuine multi-vehicle offer.
export const CAPTURE_MAX_PER_REPLY = 5

/** Extract the bare lowercased address from a possibly-decorated From header. */
export function bareEmail(addr) {
  if (!addr) return ''
  const m = String(addr).match(/<([^>]+)>/)
  if (m) return m[1].trim().toLowerCase()
  return String(addr).trim().toLowerCase()
}

/** Get-or-create a crm_clients row by email; bumps last_activity on hit. */
export async function upsertCrmClient(pool, { email, name, ico }) {
  if (!email) return null
  const lowerEmail = email.toLowerCase()
  const { rows: [existing] } = await pool.query(
    `SELECT id FROM crm_clients
      WHERE LOWER(email) = $1 OR LOWER(email_primary) = $1
      LIMIT 1`,
    [lowerEmail]
  )
  if (existing) {
    await pool.query(
      `UPDATE crm_clients
          SET last_activity_at = NOW(),
              last_activity = NOW(),
              updated_at = NOW(),
              name = COALESCE(NULLIF(name, ''), $2),
              ico = COALESCE(NULLIF(ico, ''), $3)
        WHERE id = $1`,
      [existing.id, name || null, ico || null]
    )
    return existing.id
  }
  const { rows: [created] } = await pool.query(
    `INSERT INTO crm_clients (email, email_primary, name, ico, crm_status, crm_relationship,
                              last_activity_at, last_activity, created_at, updated_at,
                              imported_from)
     VALUES ($1, $1, $2, $3, 'lead', 'vehicle_offered', NOW(), NOW(), NOW(), NOW(), 'vehicles.auto_upsert')
     RETURNING id`,
    [lowerEmail, name || null, ico || null]
  )
  return created.id
}

/** Resolve contact_id + company_id (via ICO join) + name from a sender email. */
export async function lookupContactByEmail(pool, email) {
  if (!email) return null
  const lower = email.toLowerCase()
  const { rows: [c] } = await pool.query(
    `SELECT ct.id AS contact_id, ct.ico, co.id AS company_id,
            TRIM(COALESCE(ct.first_name,'') || ' ' || COALESCE(ct.last_name,'')) AS contact_name
       FROM contacts ct
       LEFT JOIN companies co
         ON co.ico = ct.ico
        AND co.ico IS NOT NULL AND co.ico <> ''
      WHERE LOWER(ct.email) = $1
        AND ct.email IS NOT NULL
        AND ct.email <> ''
      LIMIT 1`,
    [lower]
  )
  return c || null
}

/** Stamp the source reply handled (signed-id aware: <0 → unmatched_inbound). */
export async function markReplyHandled(pool, replyId) {
  if (!replyId) return
  if (replyId < 0) {
    await pool.query(
      `UPDATE unmatched_inbound SET reviewed = TRUE, reviewed_at = NOW() WHERE id = $1`,
      [Math.abs(replyId)]
    )
  } else {
    await pool.query(
      `UPDATE reply_inbox SET handled = TRUE, handled_at = NOW() WHERE id = $1`,
      [replyId]
    )
  }
}

/** Append an operator_audit_log row for a vehicle mutation. */
export async function auditLog(pool, { action, entityId, details, actor = 'system' }) {
  await pool.query(
    `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
     VALUES ($1, $2, 'vehicle', $3, $4)`,
    [action, actor, String(entityId), JSON.stringify(details || {})]
  )
}

/**
 * Resolve a sender's contact / company / crm_client provenance once.
 * Shared by both manual + auto capture so a reply's vehicles all link
 * to the same relationship.
 *
 * @returns {Promise<{ contactId: number|null, companyId: number|null,
 *                      crmClientId: number|null, contactName: string|null }>}
 */
export async function resolveProvenance(pool, emailBare) {
  let contactId = null
  let companyId = null
  let contactName = null
  let crmClientId = null
  if (emailBare) {
    const lk = await lookupContactByEmail(pool, emailBare).catch(() => null)
    if (lk) {
      contactId = lk.contact_id
      companyId = lk.company_id
      contactName = lk.contact_name
    }
    crmClientId = await upsertCrmClient(pool, { email: emailBare, name: contactName }).catch(() => null)
  }
  return { contactId, companyId, crmClientId, contactName }
}

/**
 * Auto-capture vehicles named in a single reply into the `vehicles` table.
 *
 * Deterministic (regex_v2) only — never the LLM extractor. Dedups against
 * already-captured (source_reply_id, make, model). Fully links the sender's
 * contact/company/crm. Idempotent: re-running over the same reply inserts
 * nothing new.
 *
 * @param {import('pg').Pool} pool
 * @param {{ replyId: number, fromEmail?: string, subject?: string, body?: string }} reply
 * @returns {Promise<{ inserted: number, skipped: number, candidates: number }>}
 */
export async function captureVehiclesFromReply(pool, { replyId, fromEmail, subject, body }) {
  const { vehicles } = extractVehicles(body || '', subject || '')
  const qualified = vehicles
    .filter(v => v.make && v.confidence >= CAPTURE_MIN_CONFIDENCE)
    .slice(0, CAPTURE_MAX_PER_REPLY)

  if (qualified.length === 0) return { inserted: 0, skipped: 0, candidates: 0 }

  const emailBare = bareEmail(fromEmail)
  const { contactId, companyId, crmClientId } = await resolveProvenance(pool, emailBare)

  let inserted = 0
  let skipped = 0
  for (const v of qualified) {
    const model = v.model || ''
    const { rows: [dup] } = await pool.query(
      `SELECT id FROM vehicles
        WHERE source_reply_id = $1
          AND lower(make) = lower($2)
          AND lower(COALESCE(model, '')) = lower($3)
        LIMIT 1`,
      [replyId, v.make, model]
    )
    if (dup) { skipped++; continue }

    const noteParts = []
    if (v.motohours != null) noteParts.push(`motohodin: ${v.motohours}`)
    if (v.body_type) noteParts.push(v.body_type)
    if (v.matched_text) noteParts.push(v.matched_text)
    noteParts.push(`auto-capture (${EXTRACTOR_VERSION}, confidence ${v.confidence})`)

    const { rows: [created] } = await pool.query(
      `INSERT INTO vehicles (
         make, model, year, mileage_km, price_offered_eur, status,
         source_reply_id, source_reply_email,
         contact_id, company_id, crm_client_id, notes, photos
       ) VALUES ($1,$2,$3,$4,$5,'offered',$6,$7,$8,$9,$10,$11,'[]'::jsonb)
       RETURNING id, make, model`,
      [
        v.make, v.model || null, v.year || null, v.mileage_km || null,
        v.price_offered_eur || null,
        replyId, emailBare || null,
        contactId, companyId, crmClientId, noteParts.join(' · '),
      ]
    )
    inserted++
    await auditLog(pool, {
      action: 'vehicle_auto_captured',
      entityId: created.id,
      details: {
        make: created.make, model: created.model,
        source_reply_id: replyId, confidence: v.confidence,
        extractor_version: EXTRACTOR_VERSION,
      },
    }).catch(() => null)
  }
  return { inserted, skipped, candidates: qualified.length }
}
