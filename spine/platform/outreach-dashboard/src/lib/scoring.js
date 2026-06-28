/**
 * Composite scoring — dashboard-owned, independent of Go's best_targeting_score.
 * Pure functions: given company + send stats + config → composite score 0–100.
 *
 * Axes (positive):
 *   icp         — ICP tier (ideal=1, good=0.6, marginal=0.3, irrelevant=0, unscored=0.2)
 *   email       — email_confidence / 100  (0..1)
 *   engagement  — aggregate reply/open/click with recency decay (0..1)
 *   size        — velikost_firmy fit (small-mid=1, micro=0.5, large=0.7, unknown=0.3)
 *   recency     — 1 if last_contacted in halflife window, decays exp(-days/halflife)
 *   sector      — sector_confidence (0..1)
 *
 * Penalties (multiplicative on positive sum):
 *   bounce_penalty        — total_bounced / max(total_sent,1)
 *   unsub_penalty         — status='unsubscribed' or blacklisted
 *   inactive_penalty      — datum_zaniku set | v_likvidaci | v_insolvenci
 *   free_webmail_penalty  — email domain is free webmail
 *
 * Output 0–100. Tiers: S(≥80) A(65..79) B(45..64) C(25..44) D(<25).
 */

export const DEFAULT_WEIGHTS = Object.freeze({
  icp: 30,
  email: 20,
  engagement: 20,
  size: 10,
  recency: 10,
  sector: 10,
  bounce_penalty: 15,
  unsub_penalty: 25,
  inactive_penalty: 10,
  free_webmail_penalty: 5,
  fatigue_penalty: 8,
  recency_halflife_days: 30,
  fatigue_threshold: 3,
  fatigue_saturation: 7,
})

const ICP_TIER_VALUE = {
  ideal: 1.0,
  good: 0.6,
  marginal: 0.3,
  irrelevant: 0.0,
  unscored: 0.2,
}

const SIZE_VALUE = {
  'micro': 0.5,
  'small': 1.0,
  'medium': 1.0,
  'large': 0.7,
  'enterprise': 0.6,
}

const FREE_WEBMAIL_DOMAINS = new Set([
  'gmail.com','googlemail.com','seznam.cz','post.cz','centrum.cz','atlas.cz',
  'email.cz','volny.cz','tiscali.cz','quick.cz','yahoo.com','yahoo.co.uk',
  'ymail.com','rocketmail.com','outlook.com','hotmail.com','live.com','msn.com',
  'icloud.com','me.com','mac.com','protonmail.com','proton.me','pm.me',
  'aol.com','gmx.com','gmx.de','mail.com','zoho.com','tutanota.com','fastmail.com',
])

function clamp01(x) { return Math.max(0, Math.min(1, x)) }
function clamp100(x) { return Math.max(0, Math.min(100, Math.round(x))) }

function axisIcp(c)        { return ICP_TIER_VALUE[c.icp_tier] ?? 0.2 }
function axisEmail(c)      { return Number.isFinite(c.email_confidence) ? clamp01(c.email_confidence / 100) : 0 }
function axisSize(c)       { return SIZE_VALUE[String(c.velikost_firmy || '').toLowerCase()] ?? 0.3 }
function axisSector(c)     { return clamp01(Number(c.sector_confidence) || 0) }

/**
 * Beta-binomial posterior mean:
 *   rate = (successes + alpha) / (trials + alpha + beta)
 * where {alpha, beta} come from prior rate p0 with strength K:
 *   alpha = p0 * K, beta = (1 - p0) * K
 * Small K → data dominates, large K → prior dominates. K=20 ≈ "20 virtual sends"
 * of prior evidence — shrinks 1/1=100% toward global avg on low sample.
 */
export function bayesianRate(successes, trials, priorRate, priorStrength) {
  const p0 = Math.max(0, Math.min(1, priorRate))
  const K  = Math.max(0.001, priorStrength)
  const alpha = p0 * K
  const beta  = (1 - p0) * K
  return (successes + alpha) / (trials + alpha + beta)
}

export const ENGAGEMENT_PRIORS = Object.freeze({
  replyRate:    0.03,   // 3% reply — typical B2B cold outreach baseline
  openRate:     0.25,   // 25% open — rough cold-email baseline
  priorStrength: 20,    // K — virtual sample count the prior carries
})

/**
 * @param {object} c            company row
 * @param {object} [priors]     override priors (e.g. sector-specific agg from DB)
 *                              { replyRate, openRate, priorStrength }
 */
export function axisEngagement(c, priors = ENGAGEMENT_PRIORS) {
  const sent    = Number(c.total_sent) || 0
  const replied = Number(c.total_replied) || 0
  const opened  = Number(c.total_opened) || 0
  const { replyRate: rp, openRate: op, priorStrength: K } = { ...ENGAGEMENT_PRIORS, ...priors }
  const shrunkReply = bayesianRate(replied, sent, rp, K)
  const shrunkOpen  = bayesianRate(opened,  sent, op, K)
  return clamp01(0.7 * shrunkReply + 0.3 * shrunkOpen)
}

export function axisRecency(c, halflifeDays = 30) {
  if (!c.last_contacted) return 0.5
  const days = (Date.now() - new Date(c.last_contacted).getTime()) / 86400000
  if (!Number.isFinite(days)) return 0.5
  if (days < 0) return 1 // future timestamp (clock skew / just-contacted) → max recency
  return Math.pow(0.5, days / halflifeDays)
}

export function bouncePenaltyRatio(c) {
  const sent    = Number(c.total_sent) || 0
  const bounced = Number(c.total_bounced) || 0
  if (!sent) return 0
  return clamp01(bounced / sent)
}

/**
 * Cross-campaign fatigue: how saturated is this contact in the last 60d.
 * Below `threshold` sends → 0 (cooldown met). Above `saturation` → 1.
 * Linear ramp between. Reads `c.recent_60d_count` (precomputed by server).
 * Smooth ramp avoids cliff-edge artifacts where the 3rd send drops the
 * score by a fixed amount and the 4th does nothing.
 */
export function fatiguePenaltyRatio(c, threshold = 3, saturation = 7) {
  const n   = Number(c.recent_60d_count) || 0
  const lo  = Math.max(0, Number(threshold) - 1)   // start ramping at threshold
  const hi  = Math.max(lo + 1, Number(saturation)) // avoid /0
  if (n <= lo) return 0
  if (n >= hi) return 1
  return (n - lo) / (hi - lo)
}

function isUnsubscribed(c) {
  const s = String(c.contact_status || '').toLowerCase()
  return s === 'unsubscribed' || s === 'blacklisted'
}

function isInactive(c) {
  return Boolean(c.datum_zaniku) || c.v_likvidaci === true || c.v_insolvenci === true
}

function isFreeWebmail(email) {
  if (!email || typeof email !== 'string') return false
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  return FREE_WEBMAIL_DOMAINS.has(email.slice(at + 1).toLowerCase())
}

export function scoreTier(score) {
  if (score >= 80) return 'S'
  if (score >= 65) return 'A'
  if (score >= 45) return 'B'
  if (score >= 25) return 'C'
  return 'D'
}

/**
 * @param {object} c  company row (accepts Go + dashboard columns + send stats)
 * @param {object} w  weights (defaults to DEFAULT_WEIGHTS)
 * @param {object} [opts.engagementPriors]  sector/global priors for shrinkage
 * @returns {{score:number, tier:string, components:object}}
 */
export function computeCompositeScore(c, w = DEFAULT_WEIGHTS, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(w || {}) }
  const halflife = Math.max(1, Number(weights.recency_halflife_days) || 30)

  const icp        = axisIcp(c)
  const email      = axisEmail(c)
  const engagement = axisEngagement(c, opts.engagementPriors)
  const size       = axisSize(c)
  const recency    = axisRecency(c, halflife)
  const sector     = axisSector(c)

  const positive =
    weights.icp        * icp +
    weights.email      * email +
    weights.engagement * engagement +
    weights.size       * size +
    weights.recency    * recency +
    weights.sector     * sector

  const bounceRatio  = bouncePenaltyRatio(c)
  const fatigueRatio = fatiguePenaltyRatio(c, weights.fatigue_threshold, weights.fatigue_saturation)
  const penalty =
    weights.bounce_penalty       * bounceRatio +
    weights.unsub_penalty        * (isUnsubscribed(c) ? 1 : 0) +
    weights.inactive_penalty     * (isInactive(c) ? 1 : 0) +
    weights.free_webmail_penalty * (isFreeWebmail(c.email) ? 1 : 0) +
    (Number(weights.fatigue_penalty) || 0) * fatigueRatio

  const maxPositive =
    weights.icp + weights.email + weights.engagement +
    weights.size + weights.recency + weights.sector
  const raw100 = maxPositive > 0 ? (positive / maxPositive) * 100 : 0
  const score  = clamp100(raw100 - penalty)

  return {
    score,
    tier: scoreTier(score),
    components: {
      icp:        +(icp * weights.icp).toFixed(2),
      email:      +(email * weights.email).toFixed(2),
      engagement: +(engagement * weights.engagement).toFixed(2),
      size:       +(size * weights.size).toFixed(2),
      recency:    +(recency * weights.recency).toFixed(2),
      sector:     +(sector * weights.sector).toFixed(2),
      penalties: {
        bounce:       +(weights.bounce_penalty * bounceRatio).toFixed(2),
        unsub:        isUnsubscribed(c) ? weights.unsub_penalty : 0,
        inactive:     isInactive(c) ? weights.inactive_penalty : 0,
        free_webmail: isFreeWebmail(c.email) ? weights.free_webmail_penalty : 0,
        fatigue:      +((Number(weights.fatigue_penalty) || 0) * fatigueRatio).toFixed(2),
      },
      axes_raw: {
        icp: +icp.toFixed(3),
        email: +email.toFixed(3),
        engagement: +engagement.toFixed(3),
        size: +size.toFixed(3),
        recency: +recency.toFixed(3),
        sector: +sector.toFixed(3),
      },
    },
  }
}

/**
 * Relative deal-size proxy. Heavy machinery dealer can sell ~10x more to a
 * mid-sized factory than a micro shop. Numbers chosen so the EV ranking
 * favors a 50% prob mid-sized over a 100% prob micro (3 > 1).
 * Tuned empirically — adjust when historical close-value data lands.
 */
export const SIZE_DEAL_PROXY = Object.freeze({
  micro:      1,
  small:      3,
  medium:     8,
  large:     20,
  enterprise: 50,
})
const SIZE_DEAL_DEFAULT = 2  // unknown size — slightly above micro
const SIZE_DEAL_MAX     = 50 // for normalization to 0..100

/**
 * Expected value score = P(reply / convert) × size_proxy, normalized to 0..100.
 * Use this when you want to rank "biggest opportunities" not "best leads".
 *
 * propensity is the converted composite_score (0..100 → 0..1). For a more
 * accurate model later, replace with calibrated ML predictor output.
 *
 * @param {object} c             company row
 * @param {object} [w]           weights (currently unused, accepted for symmetry)
 * @param {object} [opts]        same opts as computeCompositeScore
 * @returns {{ev_score:number, propensity:number, size_proxy:number, deal_value_estimate:number}}
 */
export function computeExpectedValueScore(c, w = DEFAULT_WEIGHTS, opts = {}) {
  const composite = computeCompositeScore(c, w, opts)
  const propensity = composite.score / 100
  const sizeKey = String(c.velikost_firmy || '').toLowerCase()
  const size_proxy = SIZE_DEAL_PROXY[sizeKey] ?? SIZE_DEAL_DEFAULT
  const ev_raw = propensity * size_proxy
  const ev_score = clamp100((ev_raw / SIZE_DEAL_MAX) * 100)
  return {
    ev_score,
    propensity: +propensity.toFixed(3),
    size_proxy,
    deal_value_estimate: +ev_raw.toFixed(2),
    composite_score: composite.score,
    composite_tier: composite.tier,
  }
}

export function tierColor(tier) {
  switch (tier) {
    case 'S': return 'var(--green)'
    case 'A': return 'var(--green)'
    case 'B': return 'var(--yellow)'
    case 'C': return 'var(--orange)'
    default:  return 'var(--muted)'
  }
}

export function scoreColor(s) {
  if (typeof s !== 'number') return 'var(--muted)'
  if (s >= 65) return 'var(--green)'
  if (s >= 45) return 'var(--yellow)'
  if (s >= 25) return 'var(--orange)'
  return 'var(--red)'
}
