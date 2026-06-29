// AV-F5-A — prospect scoring library (linear_v1).
//
// Pure, side-effect-free function. Given one contact row and (optionally) one
// joined company row, compute a 0-100 prospect_score plus a factor breakdown
// for explainability. The cron + backfill call this in a tight loop.
//
// Model: deterministic linear combination with named weights (no magic
// numbers — feedback_no_magic_thresholds T0). All thresholds live as
// exported constants so the operator can tune later without code edits.
//
// Total possible: 50 + 10 + 15 + 5 + 10 + 10 = 100 → already in 0-100,
// then clamped just in case future weights bump it.
//
//   prospect_score = clamp(0, 100,
//       ICP_TIER_BASE        * icp_tier_weight        // 50  — primary signal
//     + EMAIL_QUALITY_BASE   * email_quality_weight   // 10
//     + NEVER_CONTACTED_BASE * never_contacted_weight // 15  — bias toward fresh
//     + RECENCY_BASE         * recency_weight         //  5
//     + SECTOR_MATCH_BASE    * sector_match_weight    // 10
//     + FLEET_SIGNAL_BASE    * fleet_signal_weight    // 10
//   )
//
// Excludes:
//   - email_status in ('bounced', 'invalid', 'suppressed') → score=0, excluded=true
//   - crm_client_id IS NOT NULL → score=null, excluded=true (already in CRM)
//
// HARD rules:
//   - feedback_no_magic_thresholds T0 — all thresholds named constants
//   - feedback_no_speculation T0      — every factor cites its data source
//
// Schema citations (verified 2026-05-19 against PROD `\d contacts` + `\d companies`):
//   contacts.email_status      (NULL | 'valid' | 'bounce_hold' | 'invalid' …)
//   contacts.email_confidence  (double precision)
//   contacts.last_contacted    (timestamptz)
//   contacts.created_at        (timestamptz)
//   contacts.crm_client_id     (bigint NULL → unsent, NOT NULL → already in CRM)
//   companies.icp_tier         ('ideal'|'good'|'marginal'|'irrelevant'|NULL)
//   companies.sector_primary   (TEXT — matches QueryBuilder SECTOR_OPTIONS)
//   companies.category_path    (TEXT)
//   companies.name             (TEXT)
//
// 13-sector dictionary mirrors morningReadiness.js + QueryBuilder.jsx so the
// "sector match" signal aligns with the operator's existing segmentation UI.

export const SCORER_VERSION = 'linear_v1'

// ── Component bases (max contribution per factor) ────────────────────────────
export const ICP_TIER_BASE        = 50
export const EMAIL_QUALITY_BASE   = 10
export const NEVER_CONTACTED_BASE = 15
export const RECENCY_BASE         = 5
export const SECTOR_MATCH_BASE    = 10
export const FLEET_SIGNAL_BASE    = 10

// ── ICP tier weights ─────────────────────────────────────────────────────────
export const ICP_TIER_WEIGHT_IDEAL      = 1.0
export const ICP_TIER_WEIGHT_GOOD       = 0.7
export const ICP_TIER_WEIGHT_MARGINAL   = 0.3
export const ICP_TIER_WEIGHT_IRRELEVANT = 0.05
export const ICP_TIER_WEIGHT_UNKNOWN    = 0.2  // companies.icp_tier IS NULL or no JOIN

// ── Email quality weights ───────────────────────────────────────────────────
export const EMAIL_QUALITY_WEIGHT_VERIFIED        = 1.0
export const EMAIL_QUALITY_WEIGHT_HIGH_CONFIDENCE = 0.7
export const EMAIL_QUALITY_WEIGHT_UNKNOWN         = 0.4
export const EMAIL_CONFIDENCE_HIGH_THRESHOLD      = 0.7

// ── Never-contacted weights ─────────────────────────────────────────────────
export const NEVER_CONTACTED_WEIGHT_FRESH       = 1.0
export const NEVER_CONTACTED_WEIGHT_AGED        = 0.6
export const NEVER_CONTACTED_WEIGHT_COOLDOWN    = 0.0
export const COOLDOWN_DAYS                      = 90

// ── Recency weights ─────────────────────────────────────────────────────────
export const RECENCY_WEIGHT_VERY_RECENT = 1.0
export const RECENCY_WEIGHT_RECENT      = 0.5
export const RECENCY_WEIGHT_OLD         = 0.2
export const RECENCY_VERY_RECENT_DAYS   = 30
export const RECENCY_RECENT_DAYS        = 180

// ── Sector match weights ────────────────────────────────────────────────────
export const SECTOR_MATCH_WEIGHT_FULL    = 1.0
export const SECTOR_MATCH_WEIGHT_PARTIAL = 0.5
export const SECTOR_MATCH_WEIGHT_NONE    = 0.0

// ── Fleet signal weights ────────────────────────────────────────────────────
export const FLEET_SIGNAL_WEIGHT_MATCH   = 1.0
export const FLEET_SIGNAL_WEIGHT_NONE    = 0.3  // baseline — could still be a seller

// ── Email statuses that DISQUALIFY (force score=0, excluded=true) ───────────
export const EXCLUDED_EMAIL_STATUSES = ['bounced', 'invalid', 'suppressed']
export const VERIFIED_EMAIL_STATUSES = ['verified', 'valid']

// ── Sector dictionary — matches morningReadiness.js + QueryBuilder.jsx ──────
// Each sector code is the canonical companies.sector_primary value the
// segmentation UI exposes. Full match: contact joins a company whose
// sector_primary appears here. Partial match: company.category_path
// contains a code as substring (e.g. category_path='B/machinery/parts').
export const TARGET_SECTOR_CODES = Object.freeze([
  'machinery',
  'metalwork',
  'construction',
  'agriculture',
  'transport',
  'automotive',
  'woodwork',
  'plastics',
  'food_processing',
  'chemicals',
  'waste',
  'energy',
  'printing',
])

// ── Fleet signal regex — operator + machinery + heavy-vehicle keywords ──────
// Czech roots intentional. Operator + machinery keywords on company.name OR
// category_path → 1.0 (they OPERATE machinery → potential seller of used kit).
// Baseline 0.3 keeps a non-match contact in the pool — could still convert.
export const FLEET_SIGNAL_REGEX = /doprava|spedice|stavebn|technika|stroj|servis|opravy|n[aá]kladn|kamion|bagr|t[eě][zž]ba|jeř[aá]b|zem[eě]d/i

// ── ms-per-day helper ───────────────────────────────────────────────────────
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Compute the ICP tier weight from companies.icp_tier.
 * @param {string|null|undefined} icpTier
 * @returns {number}
 */
export function icpTierWeight(icpTier) {
  switch (icpTier) {
    case 'ideal':      return ICP_TIER_WEIGHT_IDEAL
    case 'good':       return ICP_TIER_WEIGHT_GOOD
    case 'marginal':   return ICP_TIER_WEIGHT_MARGINAL
    case 'irrelevant': return ICP_TIER_WEIGHT_IRRELEVANT
    default:           return ICP_TIER_WEIGHT_UNKNOWN
  }
}

/**
 * Compute the email-quality weight from contact.email_status + email_confidence.
 * Caller MUST check {@link isExcludedEmailStatus} first — this function only
 * scores VALID-class statuses.
 *
 * @param {{ email_status?: string|null, email_confidence?: number|null }} contact
 * @returns {number}
 */
export function emailQualityWeight(contact) {
  const status = contact?.email_status
  const conf = Number(contact?.email_confidence)
  if (status && VERIFIED_EMAIL_STATUSES.includes(status)) {
    return EMAIL_QUALITY_WEIGHT_VERIFIED
  }
  if (Number.isFinite(conf) && conf >= EMAIL_CONFIDENCE_HIGH_THRESHOLD) {
    return EMAIL_QUALITY_WEIGHT_HIGH_CONFIDENCE
  }
  return EMAIL_QUALITY_WEIGHT_UNKNOWN
}

/**
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isExcludedEmailStatus(status) {
  return Boolean(status) && EXCLUDED_EMAIL_STATUSES.includes(status)
}

/**
 * Compute the never-contacted weight from contact.last_contacted.
 * @param {string|Date|null|undefined} lastContacted
 * @param {Date} [now]
 * @returns {number}
 */
export function neverContactedWeight(lastContacted, now = new Date()) {
  if (!lastContacted) return NEVER_CONTACTED_WEIGHT_FRESH
  const ts = new Date(lastContacted).getTime()
  if (!Number.isFinite(ts)) return NEVER_CONTACTED_WEIGHT_FRESH
  const ageDays = (now.getTime() - ts) / MS_PER_DAY
  if (ageDays > COOLDOWN_DAYS) return NEVER_CONTACTED_WEIGHT_AGED
  return NEVER_CONTACTED_WEIGHT_COOLDOWN
}

/**
 * Compute the recency weight from contact.created_at.
 * @param {string|Date|null|undefined} createdAt
 * @param {Date} [now]
 * @returns {number}
 */
export function recencyWeight(createdAt, now = new Date()) {
  if (!createdAt) return RECENCY_WEIGHT_OLD
  const ts = new Date(createdAt).getTime()
  if (!Number.isFinite(ts)) return RECENCY_WEIGHT_OLD
  const ageDays = (now.getTime() - ts) / MS_PER_DAY
  if (ageDays <= RECENCY_VERY_RECENT_DAYS) return RECENCY_WEIGHT_VERY_RECENT
  if (ageDays <= RECENCY_RECENT_DAYS) return RECENCY_WEIGHT_RECENT
  return RECENCY_WEIGHT_OLD
}

/**
 * Compute the sector match weight.
 * Full match: companies.sector_primary in TARGET_SECTOR_CODES.
 * Partial:    companies.category_path contains one of the codes.
 * None:       neither.
 *
 * @param {{ sector_primary?: string|null, category_path?: string|null }|null|undefined} company
 * @returns {number}
 */
export function sectorMatchWeight(company) {
  if (!company) return SECTOR_MATCH_WEIGHT_NONE
  const primary = company.sector_primary
  if (primary && TARGET_SECTOR_CODES.includes(primary)) {
    return SECTOR_MATCH_WEIGHT_FULL
  }
  const path = String(company.category_path || '').toLowerCase()
  if (path) {
    for (const code of TARGET_SECTOR_CODES) {
      if (path.includes(code)) return SECTOR_MATCH_WEIGHT_PARTIAL
    }
  }
  return SECTOR_MATCH_WEIGHT_NONE
}

/**
 * Compute the fleet-signal weight from regex match on company.name OR
 * company.category_path.
 *
 * @param {{ name?: string|null, category_path?: string|null }|null|undefined} company
 * @returns {number}
 */
export function fleetSignalWeight(company) {
  if (!company) return FLEET_SIGNAL_WEIGHT_NONE
  const haystack = `${company.name || ''} ${company.category_path || ''}`
  if (FLEET_SIGNAL_REGEX.test(haystack)) return FLEET_SIGNAL_WEIGHT_MATCH
  return FLEET_SIGNAL_WEIGHT_NONE
}

/**
 * Clamp a number into [lo, hi].
 * @param {number} lo
 * @param {number} hi
 * @param {number} x
 * @returns {number}
 */
function clamp(lo, hi, x) {
  if (x < lo) return lo
  if (x > hi) return hi
  return x
}

/**
 * Score a prospect (one contact + optionally its company JOIN).
 *
 * Returns:
 *   { score, factors, scorer_version }
 *
 * Where:
 *   score          : number  — 0-100 (or 0 when excluded; NULL if already in CRM)
 *   factors        : object  — per-weight breakdown + raw_components + flags
 *   scorer_version : string  — SCORER_VERSION ('linear_v1')
 *
 * Operates only on its arguments — no DB I/O, no Date.now() outside parameter
 * defaulting. Caller is responsible for the JOIN and for persisting the result.
 *
 * @param {{
 *   crm_client_id?: number|null,
 *   email_status?: string|null,
 *   email_confidence?: number|null,
 *   last_contacted?: string|Date|null,
 *   created_at?: string|Date|null,
 * }} contact
 * @param {{
 *   icp_tier?: string|null,
 *   sector_primary?: string|null,
 *   category_path?: string|null,
 *   name?: string|null,
 * }|null} [company]
 * @param {{ now?: Date }} [opts]
 */
export function scoreProspect(contact, company = null, opts = {}) {
  const now = opts.now || new Date()

  // ── Hard gates ──────────────────────────────────────────────────────────
  // Already in CRM → no point scoring (F5-B Top-N excludes these anyway).
  if (contact?.crm_client_id != null) {
    return {
      score: null,
      factors: {
        excluded: true,
        excluded_reason: 'crm_client_id_set',
        scorer_version: SCORER_VERSION,
      },
      scorer_version: SCORER_VERSION,
    }
  }

  // Bounced / invalid / suppressed → emit explicit zero so dashboards don't
  // sort them above unscored rows.
  if (isExcludedEmailStatus(contact?.email_status)) {
    return {
      score: 0,
      factors: {
        excluded: true,
        excluded_reason: `email_status_${contact.email_status}`,
        scorer_version: SCORER_VERSION,
      },
      scorer_version: SCORER_VERSION,
    }
  }

  // ── Per-factor weights ──────────────────────────────────────────────────
  const wIcp      = icpTierWeight(company?.icp_tier)
  const wEmail    = emailQualityWeight(contact)
  const wNever    = neverContactedWeight(contact?.last_contacted, now)
  const wRecency  = recencyWeight(contact?.created_at, now)
  const wSector   = sectorMatchWeight(company)
  const wFleet    = fleetSignalWeight(company)

  // ── Raw component contributions ─────────────────────────────────────────
  const cIcp      = ICP_TIER_BASE        * wIcp
  const cEmail    = EMAIL_QUALITY_BASE   * wEmail
  const cNever    = NEVER_CONTACTED_BASE * wNever
  const cRecency  = RECENCY_BASE         * wRecency
  const cSector   = SECTOR_MATCH_BASE    * wSector
  const cFleet    = FLEET_SIGNAL_BASE    * wFleet

  const raw = cIcp + cEmail + cNever + cRecency + cSector + cFleet
  const score = Math.round(clamp(0, 100, raw) * 100) / 100  // NUMERIC(5,2) friendly

  return {
    score,
    factors: {
      icp_tier_weight: wIcp,
      email_quality_weight: wEmail,
      never_contacted_weight: wNever,
      recency_weight: wRecency,
      sector_match_weight: wSector,
      fleet_signal_weight: wFleet,
      raw_components: {
        icp: Math.round(cIcp * 100) / 100,
        email: Math.round(cEmail * 100) / 100,
        never: Math.round(cNever * 100) / 100,
        recency: Math.round(cRecency * 100) / 100,
        sector: Math.round(cSector * 100) / 100,
        fleet: Math.round(cFleet * 100) / 100,
      },
      excluded: false,
      scorer_version: SCORER_VERSION,
    },
    scorer_version: SCORER_VERSION,
  }
}
