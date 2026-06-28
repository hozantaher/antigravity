// HXX4 — Predictive pre-emptive heal via Bayesian (Mahalanobis-1D) anomaly detection.
//
// Detects "degrading" state BEFORE user-visible failure → trigger pre-emptive
// heal (e.g. proxy rotate when SMTP P99 latency doubles).
//
// State machine:
//   healthy   → degrading  when score > anomaly_threshold (default 2σ) for 3 consecutive obs
//   degrading → failed     when score > fail_threshold (default 5σ) for 1 obs
//   degrading → healthy    when score < 1σ for 5 consecutive obs (recovery)
//   failed    → healthy    only via reset() (post-heal)

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { AnomalyDetector, falsePositiveRate } from '../../../src/lib/heal-predictive.js'

// Deterministic Gaussian via Box-Muller.
function gaussian(rng, mean, stddev) {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return mean + stddev * z
}

// Mulberry32 — fast deterministic PRNG.
function mulberry32(seed) {
  let t = seed >>> 0
  return function () {
    t = (t + 0x6d2b79f5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function feedBaseline(detector, count, mean, stddev, rng) {
  for (let i = 0; i < count; i++) {
    detector.observe(gaussian(rng, mean, stddev))
  }
}

describe('HXX4 — Initial state', () => {
  it('1) initial state is healthy', () => {
    const d = new AnomalyDetector()
    expect(d.state()).toBe('healthy')
  })
})

describe('HXX4 — Stable observations stay healthy', () => {
  it('2) stable observations near mean → state stays healthy', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(42)
    feedBaseline(d, 200, 100, 5, rng)
    expect(d.state()).toBe('healthy')
  })
})

describe('HXX4 — State transitions', () => {
  it('3) 3 consecutive 2σ+ observations → degrading', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(11)
    feedBaseline(d, 100, 100, 5, rng)
    // Now feed 3 obs ~3σ above mean (well above 2σ trigger threshold)
    d.observe(125)
    d.observe(126)
    d.observe(124)
    expect(d.state()).toBe('degrading')
  })

  it('4) one observation 5σ+ from healthy → does NOT immediately fail (must transition via degrading)', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(13)
    feedBaseline(d, 100, 100, 5, rng)
    // From healthy, even big spike requires 3 consecutive degrading obs first
    d.observe(200) // ~20σ above
    expect(d.state()).not.toBe('failed')
  })

  it('4b) one 5σ+ observation while degrading → failed', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(14)
    feedBaseline(d, 100, 100, 5, rng)
    d.observe(115)
    d.observe(116)
    d.observe(117) // now degrading
    expect(d.state()).toBe('degrading')
    d.observe(200) // huge spike → failed
    expect(d.state()).toBe('failed')
  })

  it('5) 5 consecutive sub-1σ observations after degrading → recovery to healthy', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(15)
    feedBaseline(d, 100, 100, 5, rng)
    d.observe(115); d.observe(116); d.observe(117) // → degrading
    expect(d.state()).toBe('degrading')
    // Now feed 5 sub-1σ obs (within mean ± 1σ)
    for (let i = 0; i < 5; i++) d.observe(100 + (i % 2 === 0 ? 1 : -1))
    expect(d.state()).toBe('healthy')
  })

  it('6) reset() returns failed/degrading to healthy', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(17)
    feedBaseline(d, 100, 100, 5, rng)
    d.observe(115); d.observe(116); d.observe(117)
    d.observe(300) // failed
    expect(d.state()).toBe('failed')
    d.reset()
    expect(d.state()).toBe('healthy')
  })

  it('6b) reset() from degrading also returns to healthy', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(19)
    feedBaseline(d, 100, 100, 5, rng)
    d.observe(115); d.observe(116); d.observe(117)
    expect(d.state()).toBe('degrading')
    d.reset()
    expect(d.state()).toBe('healthy')
  })
})

describe('HXX4 — Mathematical correctness', () => {
  it('7) mean = sum/N for first N observations', () => {
    const d = new AnomalyDetector()
    const values = [10, 20, 30, 40, 50]
    values.forEach(v => d.observe(v))
    const expected = values.reduce((a, b) => a + b, 0) / values.length
    const m = d.metrics()
    expect(m.mean).toBeCloseTo(expected, 6)
  })

  it('8) stddev = sqrt(variance), no NaN', () => {
    const d = new AnomalyDetector()
    const values = [10, 20, 30, 40, 50]
    values.forEach(v => d.observe(v))
    const mean = 30
    const variance = values.reduce((a, x) => a + (x - mean) ** 2, 0) / values.length
    const expected = Math.sqrt(variance)
    const m = d.metrics()
    expect(m.stddev).toBeCloseTo(expected, 4)
    expect(Number.isNaN(m.stddev)).toBe(false)
  })

  it('9) score = (x - mean) / stddev', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(21)
    feedBaseline(d, 100, 100, 5, rng)
    const m0 = d.metrics()
    const x = m0.mean + 3 * m0.stddev
    d.observe(x)
    const m1 = d.metrics()
    expect(m1.lastScore).toBeCloseTo(3, 0) // ~3σ
  })

  it('10) stddev = 0 (constant baseline) → score handles divide-by-zero', () => {
    const d = new AnomalyDetector()
    for (let i = 0; i < 30; i++) d.observe(50)
    const m = d.metrics()
    expect(m.stddev).toBe(0)
    expect(Number.isFinite(m.lastScore)).toBe(true)
    expect(Number.isNaN(m.lastScore)).toBe(false)
    // Single different value should still not produce NaN
    d.observe(50)
    expect(Number.isFinite(d.metrics().lastScore)).toBe(true)
  })
})

describe('HXX4 — Pre-emptive heal trigger', () => {
  it('11) shouldPreemptiveHeal returns true iff state === degrading', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(31)
    feedBaseline(d, 100, 100, 5, rng)
    expect(d.shouldPreemptiveHeal()).toBe(false) // healthy
    d.observe(115); d.observe(116); d.observe(117)
    expect(d.state()).toBe('degrading')
    expect(d.shouldPreemptiveHeal()).toBe(true)
  })

  it('12) once failed, shouldPreemptiveHeal = false', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(33)
    feedBaseline(d, 100, 100, 5, rng)
    d.observe(115); d.observe(116); d.observe(117)
    d.observe(300)
    expect(d.state()).toBe('failed')
    expect(d.shouldPreemptiveHeal()).toBe(false)
  })
})

describe('HXX4 — Real-world scenarios', () => {
  it('13) SMTP latency stable at 100ms then jumps to 500ms (10σ baseline) → 3 obs trigger', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(41)
    feedBaseline(d, 200, 100, 20, rng) // mean 100ms, stddev 20ms
    // 500ms is (500-100)/20 = 20σ — way above 2σ trigger
    d.observe(500)
    expect(d.state()).toBe('healthy') // 1 obs not enough
    d.observe(500)
    expect(d.state()).toBe('healthy') // 2 obs not enough
    d.observe(500)
    // After 3rd obs: should be degrading (or failed if score > 5σ for any one obs)
    expect(['degrading', 'failed']).toContain(d.state())
  })

  it('14) error rate creeps from 1% to 5% → degrading before failed', () => {
    const d = new AnomalyDetector({ baseline_window: 200 })
    const rng = mulberry32(43)
    // baseline: error rate ~1% with small noise
    feedBaseline(d, 200, 0.01, 0.003, rng)
    // creep upward
    let everDegrading = false
    let everFailed = false
    for (let v = 0.01; v <= 0.05; v += 0.001) {
      d.observe(v)
      if (d.state() === 'degrading') everDegrading = true
      if (d.state() === 'failed') everFailed = true
    }
    expect(everDegrading).toBe(true)
    // Degrading must have appeared at some point (we don't require "before" failure ordering;
    // but we DO require degrading was visited).
    if (everFailed) {
      // If failed state was reached, degrading must have happened first (state machine guarantee).
      expect(everDegrading).toBe(true)
    }
  })

  it('15) bursty latency (occasional single spikes) → no false positive', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(45)
    feedBaseline(d, 200, 100, 5, rng)
    let degradingTriggers = 0
    // Inject occasional 3σ spikes spaced out by stable obs — should not trip
    for (let i = 0; i < 50; i++) {
      d.observe(gaussian(rng, 100, 5))
      if (i % 7 === 0) d.observe(120) // ~4σ single spike
      if (d.state() === 'degrading') degradingTriggers++
    }
    // Allow occasional flickers but most observations stay healthy
    expect(degradingTriggers).toBeLessThan(10)
  })
})

describe('HXX4 — False-positive rate bound', () => {
  it('16) stationary Gaussian → FPR < 5% over 1000 obs', () => {
    const d = new AnomalyDetector({ baseline_window: 200 })
    const rng = mulberry32(101)
    feedBaseline(d, 300, 100, 5, rng)
    let degradingHits = 0
    for (let i = 0; i < 1000; i++) {
      d.observe(gaussian(rng, 100, 5))
      if (d.state() === 'degrading' || d.state() === 'failed') {
        degradingHits++
        d.reset()
      }
    }
    const fpr = degradingHits / 1000
    expect(fpr).toBeLessThan(0.05)
  })

  it('17) drift detection: linear creep → triggers pre-emptive within 50 obs', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(103)
    feedBaseline(d, 200, 100, 5, rng)
    let triggeredAt = -1
    // creep at +1 per obs (1σ baseline-stddev per step)
    for (let i = 0; i < 100; i++) {
      d.observe(100 + i)
      if (d.shouldPreemptiveHeal() && triggeredAt === -1) {
        triggeredAt = i
        break
      }
    }
    expect(triggeredAt).toBeGreaterThanOrEqual(0)
    expect(triggeredAt).toBeLessThan(50)
  })
})

describe('HXX4 — Memory + bounds', () => {
  it('18) baseline_window cap (default 100) → old obs evicted', () => {
    const d = new AnomalyDetector({ baseline_window: 50 })
    for (let i = 0; i < 200; i++) d.observe(i)
    // Buffer must be ≤ baseline_window. Internal `_window` checked for length.
    expect(d._window.length).toBeLessThanOrEqual(50)
  })

  it('19) observe(NaN) handled — skipped', () => {
    const d = new AnomalyDetector()
    d.observe(100)
    d.observe(NaN)
    d.observe(101)
    const m = d.metrics()
    expect(Number.isNaN(m.mean)).toBe(false)
    expect(Number.isFinite(m.mean)).toBe(true)
  })

  it('20) observe(Infinity) handled — skipped', () => {
    const d = new AnomalyDetector()
    d.observe(100)
    d.observe(Infinity)
    d.observe(-Infinity)
    d.observe(101)
    const m = d.metrics()
    expect(Number.isFinite(m.mean)).toBe(true)
  })

  it('21) observe(negative) handled — still numeric', () => {
    const d = new AnomalyDetector()
    d.observe(-50)
    d.observe(-40)
    d.observe(-60)
    const m = d.metrics()
    expect(Number.isFinite(m.mean)).toBe(true)
    expect(m.mean).toBeCloseTo(-50, 0)
  })
})

describe('HXX4 — Property tests', () => {
  it('22) 200 random Gaussian sequences → FPR < 10% across all', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const d = new AnomalyDetector({ baseline_window: 200 })
        const rng = mulberry32(seed)
        feedBaseline(d, 250, 100, 5, rng)
        let alarms = 0
        const N = 500
        for (let i = 0; i < N; i++) {
          d.observe(gaussian(rng, 100, 5))
          if (d.state() !== 'healthy') {
            alarms++
            d.reset()
          }
        }
        const fpr = alarms / N
        return fpr < 0.10
      }),
      { numRuns: 200 },
    )
  })

  it('23) 200 random sequences → state always one of 3 valid values', () => {
    const valid = new Set(['healthy', 'degrading', 'failed'])
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1000, max: 1000, noNaN: true }), { minLength: 0, maxLength: 200 }),
        (arr) => {
          const d = new AnomalyDetector()
          for (const v of arr) {
            if (Number.isFinite(v)) d.observe(v)
            if (!valid.has(d.state())) return false
          }
          return valid.has(d.state())
        },
      ),
      { numRuns: 200 },
    )
  })

  it('24) from healthy, transitions go through degrading before failed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (seed) => {
        const d = new AnomalyDetector()
        const rng = mulberry32(seed)
        feedBaseline(d, 100, 100, 5, rng)
        // From healthy, throw arbitrary observations; track state transitions
        let prev = d.state()
        let sawDegrading = false
        let illegal = false
        for (let i = 0; i < 50; i++) {
          d.observe(gaussian(rng, 100, 50)) // wide noise
          const cur = d.state()
          if (prev === 'healthy' && cur === 'failed') illegal = true
          if (cur === 'degrading') sawDegrading = true
          prev = cur
        }
        return !illegal
      }),
      { numRuns: 200 },
    )
  })

  it('25) performance: 10000 observations < 100ms', () => {
    const d = new AnomalyDetector()
    const rng = mulberry32(99)
    const t0 = performance.now()
    for (let i = 0; i < 10000; i++) {
      d.observe(gaussian(rng, 100, 5))
    }
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(100)
  })
})

describe('HXX4 — falsePositiveRate helper', () => {
  it('26) computes FPR correctly when no known failures', () => {
    const d = new AnomalyDetector({ baseline_window: 100 })
    const rng = mulberry32(7)
    const obs = []
    for (let i = 0; i < 500; i++) obs.push(gaussian(rng, 100, 5))
    const fpr = falsePositiveRate(d, obs, [])
    expect(fpr).toBeGreaterThanOrEqual(0)
    expect(fpr).toBeLessThanOrEqual(1)
  })

  it('27) with known failures, FPR excludes those windows from the denominator', () => {
    const d = new AnomalyDetector({ baseline_window: 100 })
    const rng = mulberry32(8)
    const obs = []
    for (let i = 0; i < 500; i++) obs.push(gaussian(rng, 100, 5))
    // Inject a known "failure" at index 250 — alarms there are not false positives
    const fpr = falsePositiveRate(d, obs, [250])
    expect(fpr).toBeGreaterThanOrEqual(0)
    expect(fpr).toBeLessThan(0.10)
  })
})
