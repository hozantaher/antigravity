/**
 * Logistic regression score learner.
 * Features: axes_raw values (icp, email, engagement, size, recency, sector)
 * Label:    replied (1 if company has ≥1 reply, else 0)
 *
 * Output: suggested axis weights scaled to match current positive budget.
 *
 * Minimum samples: 500 with ≥20 positive + ≥20 negative.
 * Trains via batch gradient descent with L2 regularization.
 *
 * Pure JS — no external ML dependency. Accuracy is modest but directionally
 * correct (sign + relative magnitude of weights is what matters for ranking).
 */

const FEATURES = ['icp', 'email', 'engagement', 'size', 'recency', 'sector']
const MIN_SAMPLES  = 500
const MIN_POSITIVE = 20
const MIN_NEGATIVE = 20
const DEFAULT_LR   = 0.1
const DEFAULT_L2   = 0.01
const DEFAULT_EPOCHS = 200

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z)
    return 1 / (1 + e)
  }
  const e = Math.exp(z)
  return e / (1 + e)
}

export function extractFeatures(sample) {
  const axes = sample?.score_components?.axes_raw || sample?.axes_raw || {}
  return FEATURES.map(k => Number(axes[k]) || 0)
}

export function splitTrainingSet(samples) {
  const positive = []
  const negative = []
  for (const s of samples) {
    if (s.label === 1) positive.push(s)
    else if (s.label === 0) negative.push(s)
  }
  return { positive, negative }
}

export function checkGate(samples) {
  if (!Array.isArray(samples)) return { ok: false, reason: 'no_samples' }
  if (samples.length < MIN_SAMPLES) return { ok: false, reason: 'too_few_samples', n: samples.length, min: MIN_SAMPLES }
  const { positive, negative } = splitTrainingSet(samples)
  if (positive.length < MIN_POSITIVE) return { ok: false, reason: 'too_few_positive', n: positive.length, min: MIN_POSITIVE }
  if (negative.length < MIN_NEGATIVE) return { ok: false, reason: 'too_few_negative', n: negative.length, min: MIN_NEGATIVE }
  return { ok: true, n: samples.length, positive: positive.length, negative: negative.length }
}

/**
 * Train logistic regression. Returns { weights, bias, loss, gate }.
 *
 * @param {Array<{features:number[]|object, label:0|1}>} samples
 * @param {object} opts  { lr, l2, epochs }
 */
export function trainLogistic(samples, opts = {}) {
  const gate = checkGate(samples)
  if (!gate.ok) return { ok: false, gate }

  const lr     = opts.lr ?? DEFAULT_LR
  const l2     = opts.l2 ?? DEFAULT_L2
  const epochs = opts.epochs ?? DEFAULT_EPOCHS

  const X = samples.map(s => Array.isArray(s.features) ? s.features : extractFeatures(s))
  const y = samples.map(s => Number(s.label) || 0)
  const n = X.length
  const d = X[0]?.length ?? FEATURES.length

  let w = new Array(d).fill(0)
  let b = 0
  let loss = 0

  for (let ep = 0; ep < epochs; ep++) {
    const grad = new Array(d).fill(0)
    let gb = 0
    loss = 0
    for (let i = 0; i < n; i++) {
      let z = b
      for (let j = 0; j < d; j++) z += w[j] * X[i][j]
      const p = sigmoid(z)
      const err = p - y[i]
      for (let j = 0; j < d; j++) grad[j] += err * X[i][j]
      gb += err
      loss += -(y[i] * Math.log(Math.max(p, 1e-12)) + (1 - y[i]) * Math.log(Math.max(1 - p, 1e-12)))
    }
    loss = loss / n
    for (let j = 0; j < d; j++) w[j] = w[j] - lr * (grad[j] / n + l2 * w[j])
    b = b - lr * (gb / n)
  }

  return { ok: true, weights: w, bias: b, loss, gate, features: FEATURES }
}

/**
 * Convert learned logistic weights into scoring axis weights.
 * Keeps same positive-budget total as currentWeights (sum of axis weights).
 * Negative logistic weights → 0 (floor), since we only boost positive axes.
 */
export function suggestScoringWeights(learned, currentWeights) {
  if (!learned?.ok) return null
  const current = currentWeights || {}
  const budget = FEATURES.reduce((s, k) => s + (Number(current[k]) || 0), 0) || 100
  const rawPos = learned.weights.map(w => Math.max(0, w))
  const sum = rawPos.reduce((a, b) => a + b, 0)
  if (sum === 0) return null
  const scaled = rawPos.map(w => Math.round((w / sum) * budget))
  const suggested = { ...current }
  FEATURES.forEach((k, i) => { suggested[k] = scaled[i] })
  return { weights: suggested, raw: Object.fromEntries(FEATURES.map((k, i) => [k, +learned.weights[i].toFixed(4)])) }
}

export function predictProbability(features, learned) {
  if (!learned?.ok) return null
  let z = learned.bias
  for (let j = 0; j < features.length; j++) z += learned.weights[j] * features[j]
  return sigmoid(z)
}

export const SCORE_LEARNER_FEATURES = FEATURES
export const SCORE_LEARNER_LIMITS = Object.freeze({
  MIN_SAMPLES, MIN_POSITIVE, MIN_NEGATIVE,
})
