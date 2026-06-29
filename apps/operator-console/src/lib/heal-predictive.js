// HXX4 — Predictive pre-emptive heal via Bayesian (Mahalanobis-1D) anomaly detection.
//
// Pure JS, no I/O. Deterministic given the same observation sequence.
// Used by the operational watchdog loop to distinguish "degrading" from
// "outright failed" health, and to fire pre-emptive heals (proxy rotate,
// mailbox swap, etc.) before user-visible failure.
//
// Why not full HMM with Baum-Welch? For 1-D ops metrics (latency, error
// rate, queue depth) a single-variate Mahalanobis distance is statistically
// equivalent to a |z|-score and trivial to reason about. We keep the
// hidden-state semantics (healthy / degrading / failed) but compute the
// emission likelihood as a normal score.
//
// Numerics: rolling mean+variance maintained via Welford's online algorithm,
// with eviction when the rolling window exceeds `baseline_window`.
//
// State machine:
//   healthy   → degrading  when |score| > anomaly_threshold for 3 consecutive obs
//   degrading → failed     when |score| > fail_threshold (any single obs)
//   degrading → healthy    when |score| < 1 for 5 consecutive obs (recovery)
//   failed    → healthy    only via reset() (operator/auto-heal acknowledged)

const DEFAULT_BASELINE_WINDOW = 100
const DEFAULT_ANOMALY_THRESHOLD = 2
const DEFAULT_FAIL_THRESHOLD = 5
const DEGRADING_TRIGGER_COUNT = 3
const RECOVERY_COUNT = 5
const RECOVERY_THRESHOLD = 1

/** @typedef {'healthy'|'degrading'|'failed'} DetectorState */

export class AnomalyDetector {
  /**
   * @param {object} [opts]
   * @param {number} [opts.baseline_window=100] rolling window cap
   * @param {number} [opts.anomaly_threshold=2] σ multiplier to enter degrading
   * @param {number} [opts.fail_threshold=5]    σ multiplier to enter failed
   */
  constructor({
    baseline_window = DEFAULT_BASELINE_WINDOW,
    anomaly_threshold = DEFAULT_ANOMALY_THRESHOLD,
    fail_threshold = DEFAULT_FAIL_THRESHOLD,
  } = {}) {
    if (!(baseline_window > 0)) {
      throw new Error('AnomalyDetector: baseline_window must be > 0')
    }
    if (!(anomaly_threshold > 0)) {
      throw new Error('AnomalyDetector: anomaly_threshold must be > 0')
    }
    if (!(fail_threshold > anomaly_threshold)) {
      throw new Error('AnomalyDetector: fail_threshold must be > anomaly_threshold')
    }
    this.baseline_window = baseline_window
    this.anomaly_threshold = anomaly_threshold
    this.fail_threshold = fail_threshold

    /** @type {DetectorState} */
    this._state = 'healthy'
    /** @type {number[]} rolling buffer for eviction-driven recompute */
    this._window = []
    // Welford running stats over the current window.
    this._n = 0
    this._mean = 0
    this._m2 = 0 // sum of squared deviations
    this._lastScore = 0
    // Streak counters
    this._consecAbove = 0   // anomaly_threshold streak (for degrading entry)
    this._consecBelow = 0   // recovery streak
  }

  /**
   * Observe a metric value. Non-finite values are skipped.
   * @param {number} value
   */
  observe(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return

    // Score is computed BEFORE adding the new value to the window, so we
    // judge the new observation against the current baseline distribution.
    const score = this._scoreOf(value)
    this._lastScore = score

    // Update window + Welford.
    this._addToWindow(value)

    // State transitions.
    const absScore = Math.abs(score)
    const above = absScore > this.anomaly_threshold
    const below = absScore < RECOVERY_THRESHOLD

    if (this._state === 'healthy') {
      if (absScore > this.fail_threshold) {
        // Per spec: from healthy, even a huge spike must transit through
        // degrading first (3 obs guard prevents a single noise spike from
        // tripping a hard failure). So we step the streak rather than jump.
        this._consecAbove = Math.min(this._consecAbove + 1, DEGRADING_TRIGGER_COUNT)
      } else if (above) {
        this._consecAbove += 1
      } else {
        this._consecAbove = 0
      }
      if (this._consecAbove >= DEGRADING_TRIGGER_COUNT) {
        this._state = 'degrading'
        this._consecAbove = 0
        this._consecBelow = 0
      }
      return
    }

    if (this._state === 'degrading') {
      if (absScore > this.fail_threshold) {
        this._state = 'failed'
        this._consecAbove = 0
        this._consecBelow = 0
        return
      }
      if (below) {
        this._consecBelow += 1
        if (this._consecBelow >= RECOVERY_COUNT) {
          this._state = 'healthy'
          this._consecAbove = 0
          this._consecBelow = 0
        }
      } else {
        this._consecBelow = 0
      }
      return
    }

    // 'failed' is sticky until reset()
  }

  /** @returns {DetectorState} */
  state() {
    return this._state
  }

  /**
   * Pre-emptive heal triggers iff state === 'degrading' (early warning,
   * pre-failure). Once 'failed', the heal is reactive, not pre-emptive.
   */
  shouldPreemptiveHeal() {
    return this._state === 'degrading'
  }

  /** Reset state to 'healthy' (post-heal). Baseline window is preserved. */
  reset() {
    this._state = 'healthy'
    this._consecAbove = 0
    this._consecBelow = 0
  }

  /**
   * @returns {{ mean:number, stddev:number, lastScore:number }}
   */
  metrics() {
    const variance = this._n > 0 ? this._m2 / this._n : 0
    const stddev = Math.sqrt(variance)
    return {
      mean: this._mean,
      stddev,
      lastScore: this._lastScore,
    }
  }

  // ---------- private ----------

  /**
   * @private
   * @param {number} x
   * @returns {number} z-score against current baseline (0 when stddev=0)
   */
  _scoreOf(x) {
    if (this._n < 2) return 0
    const variance = this._m2 / this._n
    if (!Number.isFinite(variance) || variance <= 0) return 0
    const stddev = Math.sqrt(variance)
    if (stddev === 0) return 0
    return (x - this._mean) / stddev
  }

  /**
   * @private
   * @param {number} value
   */
  _addToWindow(value) {
    this._window.push(value)
    if (this._window.length > this.baseline_window) {
      // FIFO eviction: drop oldest, recompute Welford from scratch over
      // remaining window (O(window) per eviction; window ≤ 100 by default,
      // so cost is bounded). Avoids numerical drift from sliding subtractions.
      this._window.shift()
      this._recomputeStats()
    } else {
      this._welfordAdd(value)
    }
  }

  /**
   * @private
   * @param {number} x
   */
  _welfordAdd(x) {
    this._n += 1
    const delta = x - this._mean
    this._mean += delta / this._n
    const delta2 = x - this._mean
    this._m2 += delta * delta2
  }

  /** @private */
  _recomputeStats() {
    this._n = 0
    this._mean = 0
    this._m2 = 0
    for (const v of this._window) this._welfordAdd(v)
  }
}

/**
 * Compute the false-positive rate of an AnomalyDetector over a fixed
 * observation sequence. A "false positive" is any non-healthy state at an
 * observation index that is NOT in `knownFailures`.
 *
 * @param {AnomalyDetector} detector
 * @param {ReadonlyArray<number>} observations
 * @param {ReadonlyArray<number>} knownFailures observation indices that *should* alarm
 * @returns {number} FPR in [0,1]
 */
export function falsePositiveRate(detector, observations, knownFailures) {
  if (!Array.isArray(observations) || observations.length === 0) return 0
  const failureSet = new Set(Array.isArray(knownFailures) ? knownFailures : [])
  let alarms = 0
  let candidates = 0
  for (let i = 0; i < observations.length; i++) {
    detector.observe(observations[i])
    if (failureSet.has(i)) {
      // True positives don't count toward FPR; reset to avoid contaminating
      // the rest of the sequence.
      detector.reset()
      continue
    }
    candidates += 1
    if (detector.state() !== 'healthy') {
      alarms += 1
      detector.reset()
    }
  }
  return candidates === 0 ? 0 : alarms / candidates
}
