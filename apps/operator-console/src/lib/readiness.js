/**
 * Engagement readiness — "should we contact this company *right now*?"
 *
 * Complementary to EV (deal size × propensity). EV says "is this worth it?",
 * readiness says "is this the right time?". Plotting EV × readiness gives
 * the dual-axis "right deal, right moment" matrix.
 *
 * Components (each 0..1):
 *   recency_gap      — 1 when last contact was long ago, decays toward 0 as recent.
 *                      Inverted exponential decay over 60-day half-life.
 *   fatigue_inverse  — 1 - fatigue_pressure. Heavily contacted companies → 0.
 *   deliverability   — 0..1 mix of (SPF strict, DMARC strict, MX known, low bounce rate).
 *   suppression_clear— 0 if blacklisted/unsubscribed/dead, else 1.
 *   reachability     — has_email × email_status_ok.
 *
 * Score = weighted sum, normalized to 0..1, then *100 for UI integer parity.
 *
 * `0` means do not send. `100` means send today.
 */

export const READINESS_WEIGHTS = Object.freeze({
  recency_gap:       0.20,
  fatigue_inverse:   0.20,
  deliverability:    0.20,
  suppression_clear: 0.20,
  reachability:      0.20,
})

export const RECENCY_HALFLIFE_DAYS = 60
export const FATIGUE_THRESHOLD = 3
export const FATIGUE_SATURATION = 7

function clamp01(x) { return Math.max(0, Math.min(1, x)) }

function ageDays(iso, now = Date.now()) {
  if (!iso) return Infinity
  const t = (iso instanceof Date ? iso : new Date(iso)).getTime()
  if (!Number.isFinite(t)) return Infinity
  return Math.max(0, (now - t) / 86400000)
}

export function recencyGap(lastContactedAt, now = Date.now(), halflife = RECENCY_HALFLIFE_DAYS) {
  const d = ageDays(lastContactedAt, now)
  if (d === Infinity) return 1
  // Exponential approach to 1 (not decay): freshly contacted=0, never=1
  return clamp01(1 - Math.pow(0.5, d / halflife))
}

export function fatigueInverse(recent60dCount, threshold = FATIGUE_THRESHOLD, saturation = FATIGUE_SATURATION) {
  const n = Math.max(0, Number(recent60dCount) || 0)
  if (n <= threshold) return 1
  if (n >= saturation) return 0
  // Linear ramp from threshold→1.0 to saturation→0.0
  return clamp01(1 - (n - threshold) / (saturation - threshold))
}

export function deliverability(company = {}, factMap) {
  const m = factMap instanceof Map
    ? factMap
    : new Map((Array.isArray(factMap) ? factMap : []).map(f => [f.field, f.value]))
  const spf      = m.get('spf')
  const dmarc    = m.get('dmarc')
  const mxProv   = m.get('mx_provider')
  const sent     = Math.max(0, Number(company.total_sent || 0))
  const bounced  = Math.max(0, Number(company.total_bounced || 0))
  const bounceRate = sent > 0 ? bounced / sent : 0
  const partial = (
    (spf?.spf_strict ? 1 : (spf?.has_spf ? 0.5 : 0))                          * 0.25
    + ((dmarc?.dmarc_policy === 'reject' || dmarc?.dmarc_policy === 'quarantine') ? 1
        : (dmarc?.has_dmarc ? 0.5 : 0))                                        * 0.25
    + (mxProv && mxProv !== 'none' && mxProv !== 'unknown' ? 1 : 0)            * 0.25
    + (1 - Math.min(1, bounceRate * 5))                                        * 0.25  // 20%+ bounce rate → 0
  )
  return clamp01(partial)
}

export function suppressionClear(company = {}) {
  const status = String(company.status || '').toLowerCase()
  if (status === 'blacklisted' || status === 'unsubscribed') return 0
  if (company.datum_zaniku || company.v_likvidaci || company.v_insolvenci) return 0
  return 1
}

export function reachability(company = {}) {
  if (!company.email) return 0
  const s = String(company.email_status || '').toLowerCase()
  if (s === 'invalid') return 0   // verified-undeliverable — never send (vs. merely uncertain)
  if (s === 'risky' || s === 'unverified') return 0.4
  if (s === 'valid' || s === 'ok' || s === 'verified') return 1
  return 0.7  // unknown status but email present
}

/**
 * @param {object} company  — must include last_contacted, recent_60d_count,
 *                            total_sent, total_bounced, status, datum_zaniku,
 *                            v_likvidaci, v_insolvenci, email, email_status
 * @param {Array|Map} [facts]
 * @param {object} [opts]
 * @returns {{ score:number, components:object, weights:object }}
 */
export function computeReadiness(company = {}, facts, opts = {}) {
  const w = { ...READINESS_WEIGHTS, ...(opts.weights || {}) }
  const now = opts.now || Date.now()
  const components = {
    recency_gap:       recencyGap(company.last_contacted, now),
    fatigue_inverse:   fatigueInverse(company.recent_60d_count),
    deliverability:    deliverability(company, facts),
    suppression_clear: suppressionClear(company),
    reachability:      reachability(company),
  }
  const wsum = Object.values(w).reduce((a, b) => a + b, 0) || 1
  let raw = 0
  for (const [k, v] of Object.entries(components)) raw += (w[k] || 0) * v
  const norm = clamp01(raw / wsum)
  return {
    score: Math.round(norm * 100),
    components,
    weights: w,
  }
}

computeReadiness.version = 'readiness_v1'
