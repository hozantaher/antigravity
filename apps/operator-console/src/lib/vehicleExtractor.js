// AV-F3 — Regex + dictionary vehicle extractor (Phase B-regex).
// ─────────────────────────────────────────────────────────────────────────────
// Pure-JS function that scans an inbound-reply body and pulls out vehicle
// candidates (make / model / year / mileage / motohours / price + a coarse
// body_type). LLM-based extraction (Phase C) is a follow-up; this is the
// cheap, deterministic first pass that pre-fills VehicleCaptureModal.
//
// Validation samples (PR description):
//   1) "MAME NA PRODEJ BAGR 24 TUN PASAK LIBHER 922 PLNĚ V PROVOZU MOTOR PO
//      GO 1.850MTH PARDUBICE" → Liebherr 922, 1850 mth, body 'bagr'
//   2) "Kolový bagr HITACHI 160W" → Hitachi 160W, body 'kolový bagr'
//   3) "Pásový bagr Komatsu PC 160LC široké pasy" → Komatsu PC160LC,
//      body 'pásový bagr'
//   4) "Dodávka Mercedes Sprinter r.v. 2018, 280 000 km, cena 12 000 EUR"
//      → Mercedes Sprinter, 2018, 280000 km, 12000 EUR
//   5) "Nemáme bagry na prodej" → empty (negation guard caps confidence)
//
// Memory rules:
//   feedback_no_speculation — output schema mirrors the VehicleCaptureModal
//     form fields one-to-one. No invented properties.
//   feedback_no_magic_thresholds — all confidence weights, conversion rates,
//     and caps live in the EXTRACTOR_CONFIG object at the top of this file.
//   feedback_no_fabricated_test_data — extractor never invents values; it
//     only surfaces tokens that physically appear in the body string.

import { BRANDS, BODY_TYPES } from './machineryDict.js'
import { stripQuotedReply } from './quoteStrip.js'

// ── Named thresholds — no magic numbers (HARD RULE T0) ───────────────────────
export const EXTRACTOR_CONFIG = Object.freeze({
  // Confidence weights summed per vehicle chunk.
  CONFIDENCE_BRAND:        0.50,
  CONFIDENCE_MODEL:        0.20,
  CONFIDENCE_PER_FACT:     0.10, // year / mileage / motohours / price each
  CONFIDENCE_FACT_CAP:     0.30, // facts beyond this contribute 0 (avoid runaway)
  CONFIDENCE_NEGATION_PEN: 0.20, // subtract for negation contamination
  CONFIDENCE_MIN_REPORT:   0.40, // chunks below this are dropped from output

  // Window for nearest-model match (chars from brand match start).
  MODEL_PROXIMITY_CHARS:   30,

  // CZK → EUR conversion (operator-tunable). 1 EUR ≈ 25 CZK for B2B used-
  // vehicle 2026 baseline; refine via operator_settings.czk_eur_rate later.
  CZK_EUR_RATE:            25,

  // Cap on vehicles per reply to prevent runaway extraction on giant bodies.
  MAX_VEHICLES_PER_REPLY:  10,

  // Year sanity window — matches VehicleCaptureModal YEAR_MIN/YEAR_MAX.
  YEAR_MIN: 1980,
  YEAR_MAX: 2030,

  // Cache TTL (seconds) for /api/replies/:id/extracted-vehicles BFF route.
  CACHE_TTL_SECONDS: 3600,
})

// regex_v2 (2026-05-30): brand dictionary widened to passenger cars/SUVs seen
// in real replies (BMW, Dacia, Jeep, Mazda, Volkswagen) — the business buys
// these too, not only heavy machinery. Version bump invalidates stale empty
// extraction caches.
// regex_v3 (2026-06): extract only the VISIBLE reply (quoted history stripped)
// so a brand in our quoted outbound / a signature footer can't create a
// phantom vehicle. Version bump invalidates stale extraction caches.
export const EXTRACTOR_VERSION = 'regex_v3'

// Negation cues — when present in the same chunk, the chunk's confidence is
// penalized so e.g. "Nemáme bagry na prodej" doesn't surface a phantom row.
const NEGATION_CUES = [
  'nemáme',
  'nemam',
  'nemame',
  'nezájem',
  'nezajem',
  'nepoužívaný',
  'nepouzivany',
  'neprodej',
  'neprodáváme',
  'neprodavame',
  'momentálně nic',
  'momentalne nic',
]

// Helper: escape user input for RegExp (BRANDS contain '-' and '.' edge cases).
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Match the canonical brand label (case-preserving) against the lower-case
// raw match. Returns the official BRANDS entry so output stays consistent
// regardless of how the operator typed it.
function canonicalBrand(rawMatch) {
  const norm = rawMatch.toLowerCase().trim()
  // Brand aliases FIRST — operator-visible normalization. "CAT"→"Caterpillar",
  // "Mercedes-Benz"→"Mercedes". These must run before the exact-catalog match
  // below, because "Mercedes-Benz" is itself a BRANDS entry (kept so the regex
  // matches the long form); without the early return the exact match would
  // surface "Mercedes-Benz" raw and the collapse-to-"Mercedes" alias would be
  // dead code.
  if (norm === 'cat') return 'Caterpillar'
  if (norm === 'mercedes-benz') return 'Mercedes'
  // Direct exact match on the lowercased catalog.
  for (const b of BRANDS) {
    if (b.toLowerCase() === norm) return b
  }
  return rawMatch // fallback — should never trigger given the BRAND_REGEX
}

// Brand regex — case-insensitive global. Multi-word brands ("New Holland",
// "John Deere", "Mercedes-Benz", "Massey Ferguson") must appear first so the
// longer alternative wins over single-token prefixes.
//
// "CAT" appended explicitly: it's not in the BRANDS catalog (too noisy
// standalone) but operators occasionally type it — the canonicalizer maps
// it to Caterpillar.
const BRAND_ALIASES = ['CAT']
const SORTED_BRANDS = [...BRANDS, ...BRAND_ALIASES].sort(
  (a, b) => b.length - a.length
)
const BRAND_REGEX = new RegExp(
  `\\b(${SORTED_BRANDS.map(escapeRegex).join('|')})\\b`,
  'gi'
)

// Body-type regex (longest-first too — "kolový bagr" must outrank "bagr").
const SORTED_BODY_TYPES = [...BODY_TYPES].sort((a, b) => b.length - a.length)
const BODY_TYPE_REGEX = new RegExp(
  `(${SORTED_BODY_TYPES.map(escapeRegex).join('|')})`,
  'gi'
)

// Model regex — alphanumeric tokens of shape:
//   ZX160W, PC160LC, 210LC-3, 922, 160W, PC 160LC (space tolerated only
//   between leading letters and digits, NOT between digits and trailing
//   letters — otherwise "922 PLNĚ" would consume "PLN" into the model).
// Tightened to require at least one digit so plain English words don't match.
const MODEL_REGEX = /\b([A-Z]{1,4}[-\s]?\d{2,4}[A-Z]{0,4}(?:-\d)?|\d{2,4}[A-Z]{0,4}(?:-\d)?)\b/g

// Year regex — three shapes:
//   "r.v. 2018", "rok výroby 2018", "rv 2018", "rok 2018", "(2018)"
const YEAR_REGEX_LABELED = /\b(?:r\.?\s*v\.?|rok\s+výroby|rok|rv)\s*:?\s*(19[89]\d|20[0-3]\d)\b/gi
const YEAR_REGEX_PAREN   = /\((19[89]\d|20[0-3]\d)\)/g

// Word-boundary trailing match uses (?!\w) instead of \b for currency/unit
// regexes — \b is ASCII-only in JS RegExp, so the trailing "č" in "Kč" breaks
// a naive \b. (?!\w) is sufficient: succeeds at end-of-string or punctuation.
const MILEAGE_REGEX   = /(\d{1,3}(?:[\s.]\d{3}){0,2}|\d{4,7})\s*(?:km|kilometr[uůy]?)(?!\w)/gi
const MOTOHOURS_REGEX = /(\d{1,2}(?:[\s.]\d{3}){0,2}|\d{3,7})\s*(?:mth|mh|moto?hod\.?|provozn[íi]ch\s*hod(?:in)?)(?!\w)/gi
const PRICE_EUR_REGEX = /(\d{1,3}(?:[\s.]\d{3}){0,2}|\d{4,7})\s*(?:eur|€)(?!\w)/gi
const PRICE_CZK_REGEX = /(\d{1,3}(?:[\s.]\d{3}){0,2}|\d{4,7})\s*(?:kč|czk|korun)(?!\w)/giu

function parseNumberWithSeparators(raw) {
  if (!raw) return null
  const cleaned = String(raw).replace(/[\s.]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

// Find the closest model token to a brand match position. "Closest" =
// the model whose start is nearest to the brand-match end, within
// MODEL_PROXIMITY_CHARS chars on either side. The model is also normalized
// (strip whitespace) so "PC 160LC" → "PC160LC".
function findNearestModel(chunk, brandEndIdx) {
  const wnd = EXTRACTOR_CONFIG.MODEL_PROXIMITY_CHARS
  const slice = chunk.slice(
    Math.max(0, brandEndIdx - wnd),
    Math.min(chunk.length, brandEndIdx + wnd)
  )
  MODEL_REGEX.lastIndex = 0
  let best = null
  let bestDist = Infinity
  let m
  while ((m = MODEL_REGEX.exec(slice)) !== null) {
    const token = m[1]
    // Discard pure 4-digit years masquerading as models.
    if (/^(?:19[89]\d|20[0-3]\d)$/.test(token)) continue
    // Discard pure km/hours numbers (those are facts, not model codes —
    // they'll be picked up by their dedicated regexes).
    if (/^\d{4,}$/.test(token)) continue
    // Discard a SHORT pure-numeric token that is really a fragment of a
    // larger number or a date — not a model code. This kills the false
    // positives "Mercedes 200" (from "200 000 tachometr"), "Dacia 10"
    // (from "10/2026"), etc., while keeping genuine short numeric models
    // like "Caterpillar 312" / "DAF 105" (those are NOT followed by more
    // digits and NOT adjacent to a date slash).
    if (/^\d{1,3}$/.test(token)) {
      const end = m.index + token.length
      const after = slice.slice(end, end + 2)
      const before2 = slice.slice(Math.max(0, m.index - 2), m.index)
      const before = slice[m.index - 1] || ''
      // followed by (optional sep +) another digit → leading part of "200 000"
      if (/^[\s.,]?\d/.test(after)) continue
      // preceded by digit (+ optional sep, incl. "-") → trailing part of a
      // bigger number ("200 000") or a URL-slug run ("…35s18-30-automat").
      // The "-" only counts after a DIGIT, so a model after a word-dash like
      // "caterpillar-cat-312-kolovy" (preceded by "t-") is still kept.
      if (/\d[\s.,-]?$/.test(before2)) continue
      // adjacent to "/" → date fragment like "10/2026" or "2026/10"
      if (after[0] === '/' || before === '/') continue
    }
    const matchStartInChunk = Math.max(0, brandEndIdx - wnd) + m.index
    const dist = Math.abs(matchStartInChunk - brandEndIdx)
    if (dist < bestDist) {
      bestDist = dist
      best = token.replace(/\s+/g, '') // "PC 160LC" → "PC160LC"
    }
  }
  return best
}

function chunkBody(body) {
  if (!body || typeof body !== 'string') return []
  // Split on sentence-ish punctuation + line breaks + bullet separators
  // commonly used by CZ sellers (" - ", " / "). Commas are NOT split-points
  // because sellers consistently chain facts inside one row:
  //   "Dodávka Mercedes Sprinter r.v. 2018, 280 000 km, 12 000 EUR"
  // Splitting on "," would shatter that row into 3 chunks with no brand in
  // chunks 2-4 → facts vanish.
  //
  // Periods only split sentences when followed by whitespace AND a
  // capital letter (or end-of-string) — that way "r.v." / "1.850MTH"
  // / "p.č." don't break a chunk apart but real sentence breaks do.
  return body
    .split(/[;\n]|\.\s+(?=[A-ZŠČŘŽŤÚŮÍÁÉĚÝÓ])|\.$|(?:\s[-/]\s)/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
}

function hasNegation(chunk) {
  const lower = chunk.toLowerCase()
  return NEGATION_CUES.some((cue) => lower.includes(cue))
}

// Extract all facts (year / mileage / motohours / price) from a chunk.
// Returns an object with `count` so the caller can compute confidence
// bonus and `factsForVehicle` shallow merge.
function extractFacts(chunk) {
  let year = null
  let mileage_km = null
  let motohours = null
  let price_offered_eur = null

  // Year — labelled first, then parenthesized fallback.
  YEAR_REGEX_LABELED.lastIndex = 0
  const ym = YEAR_REGEX_LABELED.exec(chunk)
  if (ym) {
    const y = Number(ym[1])
    if (y >= EXTRACTOR_CONFIG.YEAR_MIN && y <= EXTRACTOR_CONFIG.YEAR_MAX) year = y
  }
  if (year == null) {
    YEAR_REGEX_PAREN.lastIndex = 0
    const yp = YEAR_REGEX_PAREN.exec(chunk)
    if (yp) {
      const y = Number(yp[1])
      if (y >= EXTRACTOR_CONFIG.YEAR_MIN && y <= EXTRACTOR_CONFIG.YEAR_MAX) year = y
    }
  }

  MILEAGE_REGEX.lastIndex = 0
  const km = MILEAGE_REGEX.exec(chunk)
  if (km) mileage_km = parseNumberWithSeparators(km[1])

  MOTOHOURS_REGEX.lastIndex = 0
  const mh = MOTOHOURS_REGEX.exec(chunk)
  if (mh) motohours = parseNumberWithSeparators(mh[1])

  PRICE_EUR_REGEX.lastIndex = 0
  const eur = PRICE_EUR_REGEX.exec(chunk)
  if (eur) {
    price_offered_eur = parseNumberWithSeparators(eur[1])
  } else {
    // CZK fallback — convert to EUR using configured rate.
    PRICE_CZK_REGEX.lastIndex = 0
    const czk = PRICE_CZK_REGEX.exec(chunk)
    if (czk) {
      const czkNum = parseNumberWithSeparators(czk[1])
      if (czkNum != null) {
        price_offered_eur = Math.round(czkNum / EXTRACTOR_CONFIG.CZK_EUR_RATE)
      }
    }
  }

  const count =
    (year != null ? 1 : 0) +
    (mileage_km != null ? 1 : 0) +
    (motohours != null ? 1 : 0) +
    (price_offered_eur != null ? 1 : 0)

  return { year, mileage_km, motohours, price_offered_eur, count }
}

function findBodyType(chunk) {
  BODY_TYPE_REGEX.lastIndex = 0
  let best = null
  let m
  while ((m = BODY_TYPE_REGEX.exec(chunk)) !== null) {
    const candidate = m[1].toLowerCase()
    // Longest match wins so "kolový bagr" beats "bagr".
    if (!best || candidate.length > best.length) {
      best = candidate
    }
  }
  return best
}

// Van/LCV model names catalogued in BRANDS (machineryDict) that double-match
// after a real brand — "Renault Master" otherwise yields two phantom vehicles
// (make=Renault + make=Master). When one of these sits immediately after a
// real brand it's that brand's MODEL, not a second unit. Standalone occurrences
// ("prodám sprinter") are kept so recall doesn't regress.
const MODEL_BRANDS = new Set(['master', 'movano', 'sprinter', 'transit', 'crafter', 'ducato'])
// Max gap (chars) between a real brand's end and a following model-brand's start
// to treat them as one "Brand Model" phrase (covers a single space/hyphen).
const MODEL_BRAND_ADJACENCY_CHARS = 3

function buildVehicleFromChunk(chunk) {
  // Find ALL brand matches in this chunk — a single chunk may legitimately
  // mention several brands (chunking didn't split it but the seller listed
  // multiple units inline). Each brand match yields its own candidate.
  BRAND_REGEX.lastIndex = 0
  const candidates = []
  let bm
  while ((bm = BRAND_REGEX.exec(chunk)) !== null) {
    const brandRaw = bm[1]
    const brandEnd = bm.index + brandRaw.length
    candidates.push({ brandRaw, brandStart: bm.index, brandEnd })
  }
  if (candidates.length === 0) return []

  // Collapse a model-brand immediately following a real brand into that brand's
  // model: "Renault Master" → ONE vehicle {make:Renault, model:Master}.
  const collapsed = []
  for (const c of candidates) {
    const prev = collapsed[collapsed.length - 1]
    if (prev
        && MODEL_BRANDS.has(c.brandRaw.toLowerCase())
        && !MODEL_BRANDS.has(prev.brandRaw.toLowerCase())
        && c.brandStart - prev.brandEnd >= 0
        && c.brandStart - prev.brandEnd <= MODEL_BRAND_ADJACENCY_CHARS) {
      prev.forcedModel = c.brandRaw
      prev.brandEnd = c.brandEnd
      continue
    }
    collapsed.push(c)
  }

  const body_type = findBodyType(chunk)
  const negation = hasNegation(chunk)

  return collapsed.map(({ brandRaw, brandEnd, forcedModel }) => {
    const make = canonicalBrand(brandRaw)
    let model = forcedModel ? canonicalBrand(forcedModel) : findNearestModel(chunk, brandEnd)
    // Collapse a double-brand artefact: "DAF 105" can surface as model
    // "DAF105" (the make leaks into the model token). Strip the make prefix
    // so "DAF DAF105" → {make:DAF, model:105}. Guard against producing an
    // empty model when the token IS exactly the make.
    if (model && make) {
      const m = model.toLowerCase()
      const b = make.toLowerCase()
      if (m !== b && m.startsWith(b)) {
        const stripped = model.slice(make.length).replace(/^[\s-]+/, '')
        model = stripped || model
      }
    }
    const facts = extractFacts(chunk)

    const patterns = ['brand']
    if (model) patterns.push('model')
    if (facts.year != null) patterns.push('year')
    if (facts.mileage_km != null) patterns.push('mileage')
    if (facts.motohours != null) patterns.push('motohours')
    if (facts.price_offered_eur != null) patterns.push('price')
    if (body_type) patterns.push('body_type')

    let confidence = EXTRACTOR_CONFIG.CONFIDENCE_BRAND
    if (model) confidence += EXTRACTOR_CONFIG.CONFIDENCE_MODEL
    const factBonus = Math.min(
      facts.count * EXTRACTOR_CONFIG.CONFIDENCE_PER_FACT,
      EXTRACTOR_CONFIG.CONFIDENCE_FACT_CAP
    )
    confidence += factBonus
    if (negation) confidence -= EXTRACTOR_CONFIG.CONFIDENCE_NEGATION_PEN

    // Clamp to [0, 1] — confidence is a probability-shaped score.
    confidence = Math.max(0, Math.min(1, confidence))

    return {
      make,
      model: model || null,
      year: facts.year,
      mileage_km: facts.mileage_km,
      motohours: facts.motohours,
      price_offered_eur: facts.price_offered_eur,
      body_type,
      confidence: Math.round(confidence * 100) / 100,
      matched_text: chunk.slice(0, 200), // truncate for transport
      matched_patterns: patterns,
    }
  })
}

// Dedupe: keep the highest-confidence row per (make, model, year) key.
function dedupe(vehicles) {
  const byKey = new Map()
  for (const v of vehicles) {
    const key = `${v.make}|${v.model || ''}|${v.year || ''}`
    const existing = byKey.get(key)
    if (!existing || v.confidence > existing.confidence) {
      byKey.set(key, v)
    }
  }
  return Array.from(byKey.values())
}

/**
 * Extract vehicle candidates from a reply body + subject.
 *
 * @param {string} body  Reply body text (may include HTML — only sense-y
 *                       plain text is needed; the caller should pass
 *                       body_text not body_html when available).
 * @param {string} [subject]  Subject line. Concatenated to the body so
 *                            single-line replies ("Re: Hitachi 160W") still
 *                            yield a match.
 * @returns {{
 *   vehicles: Array<{
 *     make: string,
 *     model: string|null,
 *     year: number|null,
 *     mileage_km: number|null,
 *     motohours: number|null,
 *     price_offered_eur: number|null,
 *     body_type: string|null,
 *     confidence: number,
 *     matched_text: string,
 *     matched_patterns: string[],
 *   }>,
 *   extractor_version: string,
 * }}
 */
export function extractVehicles(body, subject) {
  // Strip the quoted reply-history first: a brand named in OUR quoted outbound
  // or in a footer/signature must not create a phantom vehicle. (2 of 15
  // captured rows were phantom — e.g. "Atlas" pulled from quoted text in a
  // reply that only offered a VW Sharan + Ford Transit.) Subject stays whole.
  const visibleBody = stripQuotedReply(body || '')
  const combined = [subject || '', visibleBody].filter(Boolean).join('\n')
  if (!combined.trim()) {
    return { vehicles: [], extractor_version: EXTRACTOR_VERSION }
  }

  const chunks = chunkBody(combined)
  const raw = []
  for (const chunk of chunks) {
    raw.push(...buildVehicleFromChunk(chunk))
  }

  // Drop low-confidence rows (negation-contaminated brand-only mentions
  // typically land here at ~0.30).
  const above = raw.filter(
    (v) => v.confidence >= EXTRACTOR_CONFIG.CONFIDENCE_MIN_REPORT
  )

  const deduped = dedupe(above)

  // Sort by confidence descending so the UI dropdown surfaces the strongest
  // candidate first.
  deduped.sort((a, b) => b.confidence - a.confidence)

  return {
    vehicles: deduped.slice(0, EXTRACTOR_CONFIG.MAX_VEHICLES_PER_REPLY),
    extractor_version: EXTRACTOR_VERSION,
  }
}
