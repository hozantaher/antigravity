// Pure helpers for the Odpovědi → Vozidlo capture panel.
// The LLM extraction is a SUGGESTION the operator edits; this module turns the
// edited draft into the POST /api/vehicles payload. Deterministic code writes
// the final state — the LLM never auto-creates (guardrail).

// Seed an editable draft from the first Ollama/regex extraction candidate.
// Everything is a string for controlled inputs; empty = unknown.
export function draftFromCandidate(c) {
  return {
    make: c?.make ?? '',
    model: c?.model ?? '',
    year: c?.year != null ? String(c.year) : '',
    mileage_km: c?.mileage_km != null ? String(c.mileage_km) : '',
    price_offered_eur: c?.price_offered_eur != null ? String(c.price_offered_eur) : '',
    body_type: c?.body_type ?? '',
  }
}

// A draft is submittable only when make + model are both present (the POST
// endpoint requires them). Pure predicate for disabling the button.
export function isDraftValid(d) {
  return Boolean(d && String(d.make).trim() && String(d.model).trim())
}

// Map a reply attachment manifest entry to a vehicle photo reference. We store
// REFERENCES (not bytes) — the bytes already live in unmatched_inbound_attachments
// and are served by GET /api/messages/:replyId/attachments/:idx, which the URL
// points at. Only image/* attachments become photos.
export function photoRefsFromAttachments(replyId, attachments) {
  if (replyId == null || !Array.isArray(attachments)) return []
  return attachments
    .filter((a) => String(a?.content_type || '').startsWith('image/'))
    .map((a) => ({
      source: 'reply',
      reply_id: replyId,
      idx: a.idx,
      filename: a.filename || `foto-${a.idx}`,
      content_type: a.content_type,
      url: `/api/messages/${replyId}/attachments/${a.idx}`,
    }))
}

// Build the POST /api/vehicles body from an edited draft + the source reply.
// Numeric fields are parsed; blank/zero/non-numeric → omitted (null), so the
// operator clearing a field means "unknown", never 0. source_reply_id +
// _email drive the backend's contact/company/CRM auto-linking. `photos` are the
// reply's image attachments (refs), so the captured vehicle carries the seller's
// machine photos into the auction pipeline.
export function buildCreatePayload(draft, reply, photos = []) {
  const num = (v) => {
    const n = Number(String(v).replace(/\s/g, ''))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  return {
    make: String(draft.make).trim(),
    model: String(draft.model).trim(),
    year: num(draft.year),
    mileage_km: num(draft.mileage_km),
    price_offered_eur: num(draft.price_offered_eur),
    body_type: String(draft.body_type || '').trim() || null,
    status: 'offered',
    source_reply_id: reply?.id ?? null,
    source_reply_email: reply?.from_email ?? null,
    photos: Array.isArray(photos) ? photos : [],
  }
}
