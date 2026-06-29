/**
 * Cohort engine — hierarchical priors with sample-size fallback.
 *
 * For a given (sector, size, icp_tier) target, walk:
 *   1. sector × size × icp_tier   (most specific)
 *   2. sector × size
 *   3. sector
 *   4. global                     (last resort)
 * picking the first level that meets `minSample`. This stops sparse
 * cohorts from hallucinating priors out of 1–2 sends — but lets a
 * dense ICP-specific cohort dominate when the data exists.
 *
 * Stats shape per cohort: { sends, replies, opens, clicks, bounces, conversions }.
 * Returned priors are observed rates with no shrinkage — the caller
 * (scoring.js bayesianRate) handles smoothing.
 */

export const COHORT_LEVELS = Object.freeze([
  { id: 'sector_size_icp', keys: ['sector', 'size', 'icp_tier'] },
  { id: 'sector_size',     keys: ['sector', 'size'] },
  { id: 'sector',          keys: ['sector'] },
  { id: 'global',          keys: [] },
])

export const DEFAULT_MIN_SAMPLE = 200

function cohortKey(company, level) {
  return level.keys.map(k => {
    const v = company[k]
    if (v === null || v === undefined || v === '') return '*'
    return String(v).toLowerCase()
  }).join('|')
}

function rates(stats) {
  const sends = Math.max(0, Number(stats?.sends) || 0)
  if (sends === 0) {
    return { replyRate: 0, openRate: 0, clickRate: 0, bounceRate: 0, conversionRate: 0 }
  }
  const safe = (n) => Math.max(0, Math.min(sends, Number(n) || 0)) / sends
  return {
    replyRate:      safe(stats.replies),
    openRate:       safe(stats.opens),
    clickRate:      safe(stats.clicks),
    bounceRate:     safe(stats.bounces),
    conversionRate: safe(stats.conversions),
  }
}

/**
 * Find the most-specific cohort with sufficient sample.
 *
 * @param {object} company           must expose sector/size/icp_tier
 * @param {Map<string,object>} byKey { 'sector_size_icp:saas|small|ideal' → stats }
 * @param {number} [minSample]
 * @returns {{level:string, key:string, sample:number, rates:object} | null}
 */
export function findCohort(company, byKey, minSample = DEFAULT_MIN_SAMPLE) {
  if (!company) return null
  for (const level of COHORT_LEVELS) {
    const key = cohortKey(company, level)
    const lookupKey = `${level.id}:${key}`
    const stats = byKey.get ? byKey.get(lookupKey) : byKey[lookupKey]
    if (!stats) continue
    const sample = Number(stats.sends) || 0
    if (sample >= minSample) {
      return { level: level.id, key, sample, rates: rates(stats) }
    }
  }
  return null
}

/**
 * Group raw send rows into per-cohort aggregates keyed by `${level}:${key}`.
 * `rows` shape: { sector, size, icp_tier, sends, replies, opens, clicks, bounces, conversions }
 * Each row = one company's lifetime totals.
 */
export function aggregateCohorts(rows) {
  const byKey = new Map()
  for (const r of rows || []) {
    for (const level of COHORT_LEVELS) {
      const k = `${level.id}:${cohortKey(r, level)}`
      const a = byKey.get(k) || { sends: 0, replies: 0, opens: 0, clicks: 0, bounces: 0, conversions: 0 }
      a.sends       += Number(r.sends)       || 0
      a.replies     += Number(r.replies)     || 0
      a.opens       += Number(r.opens)       || 0
      a.clicks      += Number(r.clicks)      || 0
      a.bounces     += Number(r.bounces)     || 0
      a.conversions += Number(r.conversions) || 0
      byKey.set(k, a)
    }
  }
  return byKey
}
