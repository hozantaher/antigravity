/**
 * Adaptive refresh policy — decides when to re-enrich a company.
 *
 * Source TTL is the *baseline* freshness. We multiply it by a tier factor:
 *   S (top 5%)    → 0.3   refresh ~3x more often
 *   A             → 0.5
 *   B (default)   → 1.0
 *   C             → 1.6
 *   D / unscored  → 2.5
 *
 * Rationale:
 *   - S/A targets matter most → keep their data freshest.
 *   - D targets rarely move → don't burn rate-limit budget on them.
 *   - dead entities (datum_zaniku / v_likvidaci / v_insolvenci) → never refresh.
 *
 * Floors:
 *   - effective_ttl is clamped to [MIN_DAYS, MAX_DAYS] so a "refresh every 2 days"
 *     bug can't hammer a third-party API in dev.
 */

export const TIER_TTL_FACTOR = Object.freeze({
  S: 0.3,
  A: 0.5,
  B: 1.0,
  C: 1.6,
  D: 2.5,
})

export const DEFAULT_TIER_FACTOR = 2.0  // unscored / unknown
export const MIN_DAYS = 7
export const MAX_DAYS = 365 * 2

function clampDays(d) {
  return Math.max(MIN_DAYS, Math.min(MAX_DAYS, d))
}

export function tierFactor(tier) {
  if (!tier) return DEFAULT_TIER_FACTOR
  return TIER_TTL_FACTOR[String(tier).toUpperCase()] ?? DEFAULT_TIER_FACTOR
}

export function effectiveTtlDays(tier, sourceTtlDays) {
  const base = Number(sourceTtlDays)
  if (!Number.isFinite(base) || base <= 0) return MAX_DAYS
  return clampDays(base * tierFactor(tier))
}

/**
 * @param {object} args
 * @param {string|null} args.tier       — score_tier (S/A/B/C/D) or null
 * @param {number} args.sourceTtlDays   — base TTL from enrichment_sources
 * @param {Date|string|null} args.lastFetchedAt
 * @param {boolean} [args.deadEntity=false]
 * @param {Date} [args.now=new Date()]
 * @returns {{ effective_ttl_days:number, due:boolean,
 *             next_due_at:Date|null, age_days:number, reason:string }}
 */
export function evaluateRefresh({ tier, sourceTtlDays, lastFetchedAt, deadEntity = false, now = new Date() }) {
  const effective_ttl_days = effectiveTtlDays(tier, sourceTtlDays)
  if (deadEntity) {
    return { effective_ttl_days, due: false, next_due_at: null, age_days: 0, reason: 'dead_entity' }
  }
  if (!lastFetchedAt) {
    return { effective_ttl_days, due: true, next_due_at: now, age_days: Infinity, reason: 'never_fetched' }
  }
  const t = (lastFetchedAt instanceof Date ? lastFetchedAt : new Date(lastFetchedAt)).getTime()
  if (!Number.isFinite(t)) {
    return { effective_ttl_days, due: true, next_due_at: now, age_days: Infinity, reason: 'invalid_fetched_at' }
  }
  const ageMs = now.getTime() - t
  const age_days = Math.max(0, ageMs / 86400000)
  const ttlMs = effective_ttl_days * 86400000
  const next_due_at = new Date(t + ttlMs)
  if (ageMs >= ttlMs) {
    return { effective_ttl_days, due: true, next_due_at, age_days, reason: 'stale' }
  }
  return { effective_ttl_days, due: false, next_due_at, age_days, reason: 'fresh' }
}

/**
 * Bulk evaluator — scans rows and yields refresh jobs to enqueue.
 *
 * `rows` shape:
 *   { company_id, ico, score_tier, dead_entity,
 *     source, source_ttl_days, last_fetched_at }
 *
 * Returns an array of { company_id, source, scheduled_at } for the caller
 * to upsert into enrichment_jobs.
 */
export function planRefreshJobs(rows, { now = new Date() } = {}) {
  const jobs = []
  for (const row of rows || []) {
    const r = evaluateRefresh({
      tier: row.score_tier,
      sourceTtlDays: row.source_ttl_days,
      lastFetchedAt: row.last_fetched_at,
      deadEntity: !!row.dead_entity,
      now,
    })
    if (r.due) {
      jobs.push({
        company_id: row.company_id,
        source: row.source,
        scheduled_at: now,
        reason: r.reason,
        effective_ttl_days: r.effective_ttl_days,
      })
    }
  }
  return jobs
}

planRefreshJobs.version = 'refresh_v1'
