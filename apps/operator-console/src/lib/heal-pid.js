// HXX3 — PID-style self-tuning of heal cooldown.
// Adjusts cooldown_ms based on rolling commit/rollback rate vs target.
// Damping limits per-update step size; bounded between 5min and 24h.

export const COOLDOWN_BOUNDS_MS = Object.freeze({
  min: 5 * 60 * 1000,         // 5 min
  max: 24 * 60 * 60 * 1000,   // 24 h
})
export const DEFAULT_TARGET_SUCCESS_RATE = 0.8
const DEFAULT_INITIAL_COOLDOWN_MS = 30 * 60 * 1000  // 30 min
const DEFAULT_DAMPING = 0.3
const DEFAULT_MAX_HISTORY = 100

function clampCooldown(ms) {
  return Math.max(COOLDOWN_BOUNDS_MS.min, Math.min(COOLDOWN_BOUNDS_MS.max, ms))
}

export class PIDController {
  constructor(opts = {}) {
    const damping = opts.damping ?? DEFAULT_DAMPING
    if (!(damping > 0 && damping < 1)) {
      throw new Error('PIDController: damping must be in (0, 1)')
    }
    const target = opts.target_success_rate ?? DEFAULT_TARGET_SUCCESS_RATE
    if (!(target > 0 && target < 1)) {
      throw new Error('PIDController: target_success_rate must be in (0, 1)')
    }
    this.damping = damping
    this.target_success_rate = target
    this.cooldown_ms = clampCooldown(opts.initial_cooldown_ms ?? DEFAULT_INITIAL_COOLDOWN_MS)
    this.history = []
    this.max_history = opts.max_history ?? DEFAULT_MAX_HISTORY
  }

  recordOutcome(outcome) {
    if (outcome !== 'commit' && outcome !== 'rollback') return
    this.history.push(outcome)
    if (this.history.length > this.max_history) this.history.shift()
    this._update()
  }

  _update() {
    const N = this.history.length
    if (N === 0) return
    const commits = this.history.filter(o => o === 'commit').length
    const rate = commits / N
    // Error: positive when rate above target → can shrink cooldown
    //        negative when rate below target → must grow cooldown
    const error = rate - this.target_success_rate
    // Step size proportional to error × damping × current cooldown
    const adjustment = -error * this.damping * this.cooldown_ms
    // Negative adjustment grows cooldown; positive shrinks. So:
    //   error > 0 (rate high)  → adjustment negative-of-positive → grows? wait
    // Re-derive: we want error > 0 → SHRINK cooldown. So adjustment should be negative.
    //   adjustment = -error × damping × cd → error>0 → adj<0 → cd-adj? no, cd += adj
    //   so cd += -error × damping × cd = cd * (1 - error * damping)
    // For error=+0.2, damping=0.3 → cd *= (1 - 0.06) = 0.94 ✓ shrinks
    // For error=-0.2, damping=0.3 → cd *= (1 + 0.06) = 1.06 ✓ grows
    this.cooldown_ms = clampCooldown(this.cooldown_ms + adjustment)
  }
}
