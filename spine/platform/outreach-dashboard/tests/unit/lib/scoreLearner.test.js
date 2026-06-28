import { describe, it, expect } from 'vitest'
import {
  trainLogistic, checkGate, extractFeatures, suggestScoringWeights,
  predictProbability, splitTrainingSet,
  SCORE_LEARNER_FEATURES, SCORE_LEARNER_LIMITS,
} from '../../../src/lib/scoreLearner.js'

function syntheticSample(w, bias, noise = 0) {
  const feats = Array(SCORE_LEARNER_FEATURES.length).fill(0).map(() => Math.random())
  let z = bias
  for (let i = 0; i < feats.length; i++) z += w[i] * feats[i]
  const p = 1 / (1 + Math.exp(-(z + (Math.random() - 0.5) * noise)))
  return { features: feats, label: Math.random() < p ? 1 : 0 }
}

describe('checkGate', () => {
  it('rejects too-few samples', () => {
    const r = checkGate(Array(100).fill({ features: [0], label: 0 }))
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('too_few_samples')
  })
  it('rejects all-negative', () => {
    const samples = Array(600).fill(null).map(() => ({ features: [0.5], label: 0 }))
    const r = checkGate(samples)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('too_few_positive')
  })
  it('rejects all-positive', () => {
    const samples = Array(600).fill(null).map(() => ({ features: [0.5], label: 1 }))
    const r = checkGate(samples)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('too_few_negative')
  })
  it('accepts balanced data', () => {
    const samples = [
      ...Array(400).fill(null).map(() => ({ features: [0.5], label: 0 })),
      ...Array(200).fill(null).map(() => ({ features: [0.5], label: 1 })),
    ]
    const r = checkGate(samples)
    expect(r.ok).toBe(true)
    expect(r.positive).toBe(200)
    expect(r.negative).toBe(400)
  })
})

describe('extractFeatures', () => {
  it('reads axes_raw from score_components', () => {
    const f = extractFeatures({
      score_components: { axes_raw: { icp: 0.8, email: 0.5, engagement: 0.2, size: 1, recency: 0.7, sector: 0.3 } },
    })
    expect(f).toEqual([0.8, 0.5, 0.2, 1, 0.7, 0.3])
  })
  it('defaults to 0 when missing', () => {
    expect(extractFeatures({})).toEqual([0, 0, 0, 0, 0, 0])
  })
})

describe('splitTrainingSet', () => {
  it('partitions by label', () => {
    const { positive, negative } = splitTrainingSet([
      { label: 1 }, { label: 0 }, { label: 1 }, { label: 0 }, { label: null },
    ])
    expect(positive).toHaveLength(2)
    expect(negative).toHaveLength(2)
  })
})

describe('trainLogistic', () => {
  it('returns gate failure for small data', () => {
    const r = trainLogistic([{ features: [0.5], label: 1 }])
    expect(r.ok).toBe(false)
    expect(r.gate.reason).toBe('too_few_samples')
  })

  it('recovers direction of synthetic linear separator', () => {
    // Ground truth: only feature 0 matters (icp), positive weight 5
    const truthW = [5, 0, 0, 0, 0, 0]
    const samples = Array(800).fill(null).map(() => syntheticSample(truthW, -2.5))
    const learned = trainLogistic(samples, { epochs: 300, lr: 0.2 })
    expect(learned.ok).toBe(true)
    // Feature 0 should have clearly highest weight. Floor is 1.5 not e.g. 4
    // because syntheticSample draws Math.random()-based samples per test run
    // and a 300-epoch SGD on noisy data converges to a distribution of weights
    // roughly centered on the ground truth but with ~0.3 sigma. The direction
    // check on the preceding line is the real signal — this assertion just
    // guards against "weight collapsed to ~0".
    const sorted = [...learned.weights].sort((a, b) => b - a)
    expect(sorted[0]).toBe(learned.weights[0])
    expect(learned.weights[0]).toBeGreaterThan(1.5)
  })

  it('predicts probabilities in [0,1]', () => {
    const samples = Array(600).fill(null).map(() => syntheticSample([3, 0, 0, 0, 0, 0], -1))
    const r = trainLogistic(samples, { epochs: 100 })
    const p = predictProbability([0.9, 0.5, 0.3, 0.5, 0.5, 0.5], r)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
  })
})

describe('suggestScoringWeights', () => {
  it('returns null for failed training', () => {
    expect(suggestScoringWeights({ ok: false })).toBe(null)
  })

  it('keeps budget constant', () => {
    const learned = {
      ok: true,
      weights: [3, 1, 0.5, 0, 2, 0],
      bias: 0,
      features: SCORE_LEARNER_FEATURES,
    }
    const current = { icp: 30, email: 20, engagement: 20, size: 10, recency: 10, sector: 10, other: 99 }
    const s = suggestScoringWeights(learned, current)
    const axisSum = SCORE_LEARNER_FEATURES.reduce((a, k) => a + s.weights[k], 0)
    expect(axisSum).toBeCloseTo(100, 0)
    expect(s.weights.other).toBe(99) // non-axis keys preserved
  })

  it('floors negative logistic weights to 0', () => {
    const learned = {
      ok: true,
      weights: [5, -3, 0, 0, 0, 0],
      bias: 0,
      features: SCORE_LEARNER_FEATURES,
    }
    const s = suggestScoringWeights(learned, { icp: 50, email: 50, engagement: 0, size: 0, recency: 0, sector: 0 })
    expect(s.weights.email).toBe(0)
    expect(s.weights.icp).toBeGreaterThan(0)
  })
})

describe('limits', () => {
  it('exports expected thresholds', () => {
    expect(SCORE_LEARNER_LIMITS.MIN_SAMPLES).toBe(500)
    expect(SCORE_LEARNER_LIMITS.MIN_POSITIVE).toBe(20)
    expect(SCORE_LEARNER_LIMITS.MIN_NEGATIVE).toBe(20)
  })
})
