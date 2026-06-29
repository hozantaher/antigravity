/**
 * Segmentation diagnostics — entropy, mutual information, lift.
 *
 * Used to ask: "Which feature actually moves reply rate?"
 *   - entropy: dispersion of a categorical distribution (0=concentrated, log2(k)=uniform)
 *   - mutual_information: bits a feature carries about the outcome
 *   - lift: per-bucket P(positive|bucket) / P(positive_global)
 *
 * Inputs are arrays of rows, each row { feature: string|null, outcome: 0|1 }.
 * Wider call sites can iterate over multiple features and rank by MI.
 *
 * Why not just look at conversion rate?
 *   Naive top-bucket conversion is biased by sample size; lift + significance
 *   bound (Wilson interval) keeps tiny buckets from looking magical.
 */

const LN2 = Math.log(2)

function log2(x) { return Math.log(x) / LN2 }

function safeProbs(counts, total) {
  if (total <= 0) return []
  const out = []
  for (const c of counts) {
    if (c > 0) out.push(c / total)
  }
  return out
}

/**
 * Shannon entropy over a probability vector. Returns 0 for degenerate dists.
 * @param {number[]} probs — must sum to ~1 (renormalized internally)
 */
export function entropy(probs) {
  if (!probs || probs.length === 0) return 0
  const sum = probs.reduce((a, b) => a + (Number(b) || 0), 0)
  if (sum <= 0) return 0
  let h = 0
  for (const p of probs) {
    const q = (Number(p) || 0) / sum
    if (q > 0) h -= q * log2(q)
  }
  return h
}

/**
 * Mutual information I(X; Y) given a joint count Map<`x|y`, count>.
 *
 * @param {Map<string, number>} joint
 * @param {string[]} xLevels — distinct values of X
 * @param {string[]} yLevels — distinct values of Y (typically ['0','1'])
 * @returns {number} bits
 */
export function mutualInformation(joint, xLevels, yLevels) {
  let total = 0
  for (const c of joint.values()) total += c
  if (total <= 0) return 0
  const px = new Map(xLevels.map(x => [x, 0]))
  const py = new Map(yLevels.map(y => [y, 0]))
  for (const x of xLevels) {
    for (const y of yLevels) {
      const c = joint.get(`${x}|${y}`) || 0
      px.set(x, (px.get(x) || 0) + c)
      py.set(y, (py.get(y) || 0) + c)
    }
  }
  let mi = 0
  for (const x of xLevels) {
    for (const y of yLevels) {
      const c = joint.get(`${x}|${y}`) || 0
      if (c === 0) continue
      const pxy = c / total
      const pxv = (px.get(x) || 0) / total
      const pyv = (py.get(y) || 0) / total
      if (pxv > 0 && pyv > 0) mi += pxy * log2(pxy / (pxv * pyv))
    }
  }
  return Math.max(0, mi)
}

/**
 * Wilson score interval (95%) for a binomial rate. Stops tiny buckets from
 * appearing as outliers.
 */
export function wilson95(successes, trials) {
  const n = Math.max(0, trials)
  if (n === 0) return { lower: 0, upper: 1, p: 0 }
  const z = 1.96
  const p = successes / n
  const denom = 1 + z * z / n
  const center = (p + z * z / (2 * n)) / denom
  const halfWidth = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
  return { lower: Math.max(0, center - halfWidth), upper: Math.min(1, center + halfWidth), p }
}

/**
 * Per-bucket lift table for one feature.
 *
 * @param {Array<{feature:any,outcome:number}>} rows
 * @param {number} [minBucketSize=30]
 * @returns {{
 *   feature_levels: number,
 *   global_rate: number,
 *   total: number,
 *   mutual_information: number,
 *   buckets: Array<{level:string,n:number,positives:number,rate:number,
 *                   lift:number,wilson:{lower:number,upper:number}}>
 * }}
 */
export function featureLift(rows, minBucketSize = 30) {
  const safe = (rows || []).filter(r => r && r.feature !== undefined && r.feature !== null)
  const total = safe.length
  if (total === 0) {
    return { feature_levels: 0, global_rate: 0, total: 0, mutual_information: 0, buckets: [] }
  }
  let positives = 0
  const byLevel = new Map()
  for (const r of safe) {
    const k = String(r.feature)
    const o = Number(r.outcome) > 0 ? 1 : 0
    const cell = byLevel.get(k) || { n: 0, positives: 0 }
    cell.n += 1
    cell.positives += o
    byLevel.set(k, cell)
    if (o === 1) positives += 1
  }
  const global_rate = positives / total
  const buckets = []
  const joint = new Map()
  const yLevels = ['0', '1']
  const xLevels = []
  for (const [level, { n, positives: p }] of byLevel.entries()) {
    if (n < minBucketSize) continue
    xLevels.push(level)
    joint.set(`${level}|0`, n - p)
    joint.set(`${level}|1`, p)
    const rate = n > 0 ? p / n : 0
    const lift = global_rate > 0 ? rate / global_rate : 0
    const wilson = wilson95(p, n)
    buckets.push({ level, n, positives: p, rate, lift, wilson })
  }
  buckets.sort((a, b) => b.lift - a.lift)
  const mi = xLevels.length > 0 ? mutualInformation(joint, xLevels, yLevels) : 0
  return {
    feature_levels: xLevels.length,
    global_rate,
    total,
    mutual_information: mi,
    buckets,
  }
}

/**
 * Multi-feature ranker — returns a table of features sorted by MI desc.
 *
 * @param {Array<object>} companyRows — each row has feature columns + 'outcome'
 * @param {string[]} featureNames
 * @param {number} [minBucketSize=30]
 */
export function rankFeaturesByMI(companyRows, featureNames, minBucketSize = 30) {
  const out = []
  for (const f of featureNames) {
    const lift = featureLift(
      (companyRows || []).map(r => ({ feature: r[f], outcome: r.outcome })),
      minBucketSize,
    )
    out.push({
      feature: f,
      mi: lift.mutual_information,
      levels: lift.feature_levels,
      total: lift.total,
      top_lift: lift.buckets[0]?.lift ?? 0,
      bottom_lift: lift.buckets.at(-1)?.lift ?? 0,
    })
  }
  out.sort((a, b) => b.mi - a.mi)
  return out
}

featureLift.version = 'diag_v1'
