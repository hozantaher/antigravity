/**
 * data_quality_score (DQS) — measures how rich + fresh our knowledge is
 * about a company. Used as a multiplier on the composite/EV score so
 * thinly-known companies don't beat well-enriched ones on noisy axes.
 *
 * Inputs:
 *   company  — base row (email, website, sector, velikost_firmy, address,
 *              ico, datum_zaniku, v_likvidaci, v_insolvenci)
 *   facts    — array of { field, value, fetched_at } from company_current_facts
 *
 * Output:
 *   { dqs: 0..1, signals: { [name]: { present, fresh, weight, contribution } },
 *     score_raw, score_max, multiplier }
 *
 * Multiplier is the value to multiply composite_score / EV by:
 *     multiplier = MIN_FLOOR + (1 - MIN_FLOOR) * dqs
 * Floor ≠ 0 so that a zero-data company still scores something — the floor
 * acknowledges public registry presence is itself signal.
 */

export const SIGNAL_WEIGHTS = Object.freeze({
  // base company fields (from ARES / firmy.cz / manual)
  has_email:          1.5,
  has_website:        1.0,
  has_sector:         1.0,
  has_size:           0.8,
  has_address:        0.5,
  is_active_entity:   1.5,
  // enrichment facts (from parsers)
  has_mx_provider:    1.0,
  has_spf:            0.6,
  has_dmarc:          0.6,
  has_revenue:        1.2,
  has_employee_count: 0.8,
  has_tech_stack:     0.8,
  has_tendr_history:  0.6,
  has_statutari:      0.7,
})

export const STALENESS = Object.freeze({
  fresh_days:  90,    // 0..90 days → factor 1.0
  stale_days:  365,   // linear decay 90..365 → 1.0..0.4
  expired_factor: 0.4,// floor for >365 days
})

export const MIN_MULTIPLIER_FLOOR = 0.5

const MAX_RAW = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0)

function clamp01(x) { return Math.max(0, Math.min(1, x)) }

function nonEmpty(s) {
  return s !== null && s !== undefined && String(s).trim().length > 0
}

function ageDays(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return Infinity
  const t = (fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt)).getTime()
  if (!Number.isFinite(t)) return Infinity
  return Math.max(0, (now - t) / 86400000)
}

export function stalenessFactor(fetchedAt, now = Date.now()) {
  const days = ageDays(fetchedAt, now)
  if (days <= STALENESS.fresh_days) return 1
  if (days >= STALENESS.stale_days) return STALENESS.expired_factor
  const span = STALENESS.stale_days - STALENESS.fresh_days
  const t = (days - STALENESS.fresh_days) / span
  return 1 + (STALENESS.expired_factor - 1) * t
}

function presence(signal, company, factMap) {
  switch (signal) {
    case 'has_email':         return { present: nonEmpty(company.email), fresh: 1 }
    case 'has_website':       return { present: nonEmpty(company.website || company.web), fresh: 1 }
    case 'has_sector':        return { present: nonEmpty(company.sector || company.odvetvi), fresh: 1 }
    case 'has_size':          return { present: nonEmpty(company.velikost_firmy || company.size), fresh: 1 }
    case 'has_address':       return { present: nonEmpty(company.address || company.adresa || company.mesto), fresh: 1 }
    case 'is_active_entity': {
      const dead = company.datum_zaniku || company.v_likvidaci || company.v_insolvenci
      return { present: !dead && nonEmpty(company.ico), fresh: 1 }
    }
    case 'has_mx_provider': {
      const f = factMap.get('mx_provider')
      const v = f?.value
      return { present: nonEmpty(v) && v !== 'none' && v !== 'unknown', fresh: stalenessFactor(f?.fetched_at) }
    }
    case 'has_spf': {
      const f = factMap.get('spf')
      return { present: !!f?.value?.has_spf, fresh: stalenessFactor(f?.fetched_at) }
    }
    case 'has_dmarc': {
      const f = factMap.get('dmarc')
      return { present: !!f?.value?.has_dmarc, fresh: stalenessFactor(f?.fetched_at) }
    }
    case 'has_revenue': {
      const f = factMap.get('revenue') || factMap.get('annual_revenue')
      return { present: Number(f?.value) > 0, fresh: stalenessFactor(f?.fetched_at) }
    }
    case 'has_employee_count': {
      const f = factMap.get('employee_count') || factMap.get('employees')
      return { present: Number(f?.value) > 0, fresh: stalenessFactor(f?.fetched_at) }
    }
    case 'has_tech_stack': {
      const f = factMap.get('tech_stack')
      const v = f?.value
      return { present: Array.isArray(v) ? v.length > 0 : nonEmpty(v), fresh: stalenessFactor(f?.fetched_at) }
    }
    case 'has_tendr_history': {
      const f = factMap.get('tendr_history') || factMap.get('public_tenders')
      const v = f?.value
      return { present: Array.isArray(v) ? v.length > 0 : Number(v) > 0, fresh: stalenessFactor(f?.fetched_at) }
    }
    case 'has_statutari': {
      const f = factMap.get('statutari') || factMap.get('directors')
      const v = f?.value
      return { present: Array.isArray(v) ? v.length > 0 : nonEmpty(v), fresh: stalenessFactor(f?.fetched_at) }
    }
    default:
      return { present: false, fresh: 0 }
  }
}

/**
 * @param {object} company
 * @param {Array<{field:string,value:any,fetched_at?:string|Date}>} facts
 * @returns {{dqs:number, signals:object, score_raw:number, score_max:number, multiplier:number}}
 */
export function computeDataQuality(company = {}, facts = []) {
  const factMap = new Map((facts || []).map(f => [f.field, f]))
  const signals = {}
  let raw = 0
  for (const [signal, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    const { present, fresh } = presence(signal, company, factMap)
    const contribution = present ? weight * fresh : 0
    raw += contribution
    signals[signal] = { present, fresh, weight, contribution }
  }
  const dqs = clamp01(raw / MAX_RAW)
  const multiplier = MIN_MULTIPLIER_FLOOR + (1 - MIN_MULTIPLIER_FLOOR) * dqs
  return { dqs, signals, score_raw: raw, score_max: MAX_RAW, multiplier }
}

computeDataQuality.version = 'dqs_v1'
