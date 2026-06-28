/**
 * Lookalike scoring — cosine similarity of a company's feature vector
 * against the centroid of "converters" (companies that have replied).
 *
 * Pure functions, no DB. Caller fetches rows + facts and assembles input.
 *
 * Feature vector — numeric, length matches FEATURE_NAMES:
 *   icp_value           — ideal=1, good=0.7, marginal=0.3, irrelevant=0, unscored=0.5
 *   size_value          — small/medium=1, large=0.7, enterprise=0.4, micro=0.2, unknown=0.5
 *   email_confidence    — 0..1
 *   sector_confidence   — 0..1
 *   composite_score     — 0..1 (composite_score/100)
 *   engagement_score    — 0..1
 *   has_website         — 0|1
 *   has_email           — 0|1
 *   mx_enterprise       — 1 if MX provider in enterprise/tech tier else 0
 *   spf_strict          — 0|1
 *   dmarc_strict        — 1 if quarantine/reject else 0
 *
 * MX/SPF/DMARC pulled from optional facts map { field → value }.
 *
 * Centroid is the mean of feature vectors over converters. Cosine of
 * candidate × centroid → 0..1 (centroid is non-negative so cosine is too).
 */

export const FEATURE_NAMES = Object.freeze([
  'icp_value', 'size_value', 'email_confidence', 'sector_confidence',
  'composite_score', 'engagement_score', 'has_website', 'has_email',
  'mx_enterprise', 'spf_strict', 'dmarc_strict',
])

const ICP_VALUE  = { ideal: 1.0, good: 0.7, marginal: 0.3, irrelevant: 0.0, unscored: 0.5 }
const SIZE_VALUE = { micro: 0.2, small: 1.0, medium: 1.0, large: 0.7, enterprise: 0.4 }
const ENTERPRISE_MX = new Set(['google_workspace','microsoft_365','mailgun','sendgrid','aws_ses'])

function num(x, fallback = 0) {
  const n = Number(x)
  return Number.isFinite(n) ? n : fallback
}

function clamp01(x) { return Math.max(0, Math.min(1, x)) }

/**
 * Build a feature vector. `company` should have icp_tier, velikost_firmy,
 * email, website, email_confidence, sector_confidence, composite_score,
 * engagement_score. `facts` is optional Map<field, value>.
 */
export function featureVector(company = {}, facts) {
  const factMap = facts instanceof Map
    ? facts
    : new Map((Array.isArray(facts) ? facts : []).map(f => [f.field, f.value]))
  const mx = factMap.get('mx_provider')
  const spf = factMap.get('spf')
  const dmarc = factMap.get('dmarc')
  return [
    ICP_VALUE[String(company.icp_tier || '').toLowerCase()] ?? 0.5,
    SIZE_VALUE[String(company.velikost_firmy || '').toLowerCase()] ?? 0.5,
    clamp01(num(company.email_confidence) / 100),
    clamp01(num(company.sector_confidence)),
    clamp01(num(company.composite_score) / 100),
    clamp01(num(company.engagement_score)),
    company.website ? 1 : 0,
    company.email   ? 1 : 0,
    ENTERPRISE_MX.has(String(mx || '').toLowerCase()) ? 1 : 0,
    spf?.spf_strict ? 1 : 0,
    (dmarc?.dmarc_policy === 'reject' || dmarc?.dmarc_policy === 'quarantine') ? 1 : 0,
  ]
}

export function dot(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function magnitude(v) {
  let s = 0
  for (const x of v) s += x * x
  return Math.sqrt(s)
}

export function cosine(a, b) {
  const ma = magnitude(a)
  const mb = magnitude(b)
  if (ma === 0 || mb === 0) return 0
  return dot(a, b) / (ma * mb)
}

export function centroid(vectors) {
  if (!vectors || vectors.length === 0) return null
  const dim = vectors[0].length
  const sum = new Array(dim).fill(0)
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i] || 0
  }
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length
  return sum
}

/**
 * @param {object} candidate     — company row
 * @param {object|null} centroidVec
 * @param {Array|Map} [facts]
 * @returns {{ score:number, similarity:number, components:object }}
 */
export function lookalikeScore(candidate, centroidVec, facts) {
  if (!centroidVec || centroidVec.length === 0) {
    return { score: 0, similarity: 0, components: {} }
  }
  const v = featureVector(candidate, facts)
  const sim = Math.max(0, cosine(v, centroidVec))
  const components = Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, v[i]]))
  // Stretch [0,1] cosine to [0,100] integer score for UI parity.
  return { score: Math.round(sim * 100), similarity: sim, components }
}

lookalikeScore.version = 'lookalike_v1'
