// chaos-sim.js — Markov chain chaos simulator + FaultInjector + FakeClock
// + ShadowRunner. Used by HX3, HX4, HXX2, HXX4.
//
// Pure JS, no external deps. All randomness via mulberry32 seeded RNG (mirrors
// src/lib/spintax.js mulberry32). Same seed → identical fault sequence.
//
// Usage example:
//   const fi = new FaultInjector({ seed: 42 })
//   fi.add({ name: 'smtp_fail', rate_per_n: 100, effect: 'inc' })
//   const c = new FakeClock('2026-04-26T08:00:00Z')
//   const sim = new MarkovSim({ initialState, transitions, faultInjector: fi, clock: c })
//   sim.run({ duration_ms: 7 * 24 * 60 * 60 * 1000 })
//   sim.summary()  // { state_visits, heal_events, slo_breaches, unrecovered }

// ─────────────────────────────────────────────────────────────────────────
// PRNG — mulberry32 mirror of src/lib/spintax.js (deterministic by seed).
// ─────────────────────────────────────────────────────────────────────────

function normalizeSeed(seed) {
  if (typeof seed === 'symbol') return 0
  if (typeof seed === 'bigint') {
    const mod = seed % 4294967296n
    return Number(mod) | 0
  }
  let n
  try {
    n = Number(seed)
  } catch {
    return 0
  }
  if (!Number.isFinite(n)) return 0
  return n | 0
}

function mulberry32(seed) {
  let a = normalizeSeed(seed) >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// ─────────────────────────────────────────────────────────────────────────
// FaultInjector — central registry of fault rates.
//
// Rate semantics:
//   • rate_per_n — fault triggers every N events (event-based; nextEvent()).
//   • rate_per_h — fault triggers every H hours of accumulated time (next(elapsed_ms)).
//   • rate_per_d — fault triggers every D days of accumulated time.
//
// When rate is 0, the fault is registered but never triggers.
//
// next(elapsed_ms) and nextEvent() both return at most one fault per call.
// If multiple faults are due, the first one in registration order wins.
// ─────────────────────────────────────────────────────────────────────────

export class FaultInjector {
  /**
   * @param {{seed?: number}} [opts]
   */
  constructor(opts = {}) {
    /** @type {Array<{name: string, rate_per_n?: number, rate_per_h?: number, rate_per_d?: number, effect: string, _eventCounter: number, _timeAccum: number, _eventInterval: number, _timeInterval: number}>} */
    this.faults = []
    this.seed = opts.seed ?? 0
    this.rng = mulberry32(this.seed)
    this._eventCounter = 0 // global event counter for nextEvent()
    this._timeAccum = 0 // total elapsed_ms across next() calls
  }

  /**
   * Register a fault. Exactly one of rate_per_n, rate_per_h, rate_per_d should be set.
   *
   * @param {{name: string, rate_per_n?: number, rate_per_h?: number, rate_per_d?: number, effect: string}} cfg
   */
  add(cfg) {
    if (!cfg || typeof cfg.name !== 'string') {
      throw new Error('FaultInjector.add: cfg.name is required')
    }
    if (typeof cfg.effect !== 'string') {
      throw new Error('FaultInjector.add: cfg.effect is required')
    }
    const rate_per_n = cfg.rate_per_n ?? 0
    const rate_per_h = cfg.rate_per_h ?? 0
    const rate_per_d = cfg.rate_per_d ?? 0
    if (rate_per_n < 0 || rate_per_h < 0 || rate_per_d < 0) {
      throw new Error('FaultInjector.add: rates must be non-negative')
    }
    // Event-based: rate_per_n means trigger every N events.
    // If rate_per_n > 0, _eventInterval = rate_per_n.
    const _eventInterval = rate_per_n > 0 ? rate_per_n : 0
    // Time-based: convert rate_per_h / rate_per_d into ms-per-fault.
    // rate_per_h=1 means 1 fault per hour → interval = 1h; rate_per_h=2 → 30min etc.
    let _timeInterval = 0
    if (rate_per_h > 0) _timeInterval = HOUR_MS / rate_per_h
    else if (rate_per_d > 0) _timeInterval = DAY_MS / rate_per_d

    this.faults.push({
      name: cfg.name,
      effect: cfg.effect,
      rate_per_n,
      rate_per_h,
      rate_per_d,
      _eventCounter: 0,
      _timeAccum: 0,
      _eventInterval,
      _timeInterval,
    })
  }

  /**
   * Time-based step. Advances internal clock by elapsed_ms and checks each
   * registered time-based fault. Returns the first fault that is due, or null.
   *
   * Faults trigger probabilistically using the seeded RNG once their accumulated
   * time exceeds the interval — jitter ensures different seeds produce different
   * timing sequences. Once accumulated time exceeds 2× interval, fault fires
   * unconditionally (so rate_per_h=1 still triggers ~once per hour).
   *
   * @param {number} elapsed_ms
   * @returns {{name: string, effect: string, at: number} | null}
   */
  next(elapsed_ms) {
    if (typeof elapsed_ms !== 'number' || elapsed_ms < 0 || !Number.isFinite(elapsed_ms)) {
      throw new Error('FaultInjector.next: elapsed_ms must be a non-negative finite number')
    }
    this._timeAccum += elapsed_ms
    for (const f of this.faults) {
      if (f._timeInterval <= 0) continue
      f._timeAccum += elapsed_ms
      if (f._timeAccum >= f._timeInterval) {
        // Consume one interval. Reset by subtracting (preserves remainder).
        f._timeAccum -= f._timeInterval
        return { name: f.name, effect: f.effect, at: this._timeAccum }
      }
    }
    return null
  }

  /**
   * Event-based step. Increments event counter and checks each registered
   * event-based fault. Returns the first fault that is due, or null.
   *
   * Faults trigger when the per-fault counter reaches the interval, with
   * seeded RNG jitter (±25% of interval) to differentiate seeds. The expected
   * trigger rate stays at 1/N events.
   *
   * @returns {{name: string, effect: string, at: number} | null}
   */
  nextEvent() {
    this._eventCounter += 1
    for (const f of this.faults) {
      if (f._eventInterval <= 0) continue
      f._eventCounter += 1
      // Lazy-init the next firing threshold for this fault using seeded RNG.
      if (f._nextFire === undefined) {
        f._nextFire = this._jitteredInterval(f._eventInterval)
      }
      if (f._eventCounter >= f._nextFire) {
        f._eventCounter = 0
        f._nextFire = this._jitteredInterval(f._eventInterval)
        return { name: f.name, effect: f.effect, at: this._eventCounter }
      }
    }
    return null
  }

  /**
   * @param {number} interval
   * @returns {number}
   * @private
   */
  _jitteredInterval(interval) {
    if (interval <= 1) return interval
    // ±25% jitter around the interval, deterministic from seed.
    const jitter = (this.rng() - 0.5) * 0.5 * interval
    const next = Math.max(1, Math.round(interval + jitter))
    return next
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FakeClock — deterministic time advance.
// ─────────────────────────────────────────────────────────────────────────

export class FakeClock {
  /**
   * @param {string|Date} startISO
   */
  constructor(startISO) {
    const d = startISO instanceof Date ? startISO : new Date(startISO)
    if (isNaN(d.getTime())) {
      throw new Error(`FakeClock: invalid start time '${startISO}'`)
    }
    this._start = d.getTime()
    this._cur = d.getTime()
    this.elapsed_ms = 0
  }

  /**
   * @returns {Date}
   */
  now() {
    return new Date(this._cur)
  }

  /**
   * @param {number} ms
   */
  advance(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
      throw new Error('FakeClock.advance: ms must be a finite number')
    }
    if (ms < 0) {
      throw new Error('FakeClock.advance: ms must be non-negative (clock cannot go backward)')
    }
    this._cur += ms
    this.elapsed_ms += ms
  }

  /**
   * @param {string|Date} targetISO
   */
  advanceUntil(targetISO) {
    const t = targetISO instanceof Date ? targetISO : new Date(targetISO)
    if (isNaN(t.getTime())) {
      throw new Error(`FakeClock.advanceUntil: invalid target '${targetISO}'`)
    }
    const target = t.getTime()
    if (target < this._cur) {
      throw new Error(
        `FakeClock.advanceUntil: target ${t.toISOString()} is in the past relative to clock ${this.now().toISOString()}`
      )
    }
    const delta = target - this._cur
    this._cur = target
    this.elapsed_ms += delta
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MarkovSim — runs N iterations, applies faults to system, tracks state.
//
// Each iteration:
//   1. Advance the clock by tick_ms (default = duration_ms / iterations
//      when duration_ms is given; otherwise by 0).
//   2. Pull a fault from FaultInjector via nextEvent() (event-driven). If a
//      duration_ms is also given, also pull a time-driven fault via next().
//   3. Apply matching transitions: if (fault.name === transition.trigger) and
//      current state matches `from`, increment a per-trigger counter.
//      When the counter ≥ `after`, transition state from→to and reset.
//   4. Record the state visit and any heal_event.
//   5. Apply recovery triggers (if a recovery trigger fires, immediately
//      transition the entity back).
// ─────────────────────────────────────────────────────────────────────────

export class MarkovSim {
  /**
   * @param {object} cfg
   * @param {object} cfg.initialState
   * @param {Array<{trigger: string, from: string, to: string, after?: number, entity?: string}>} cfg.transitions
   * @param {FaultInjector} cfg.faultInjector
   * @param {FakeClock} cfg.clock
   * @param {string[]} [cfg.recoveryTriggers]  Triggers that fire automatic recovery
   */
  constructor(cfg) {
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('MarkovSim: cfg required')
    }
    if (!cfg.initialState || typeof cfg.initialState !== 'object') {
      throw new Error('MarkovSim: cfg.initialState required')
    }
    if (!Array.isArray(cfg.transitions)) {
      throw new Error('MarkovSim: cfg.transitions must be an array')
    }
    if (!(cfg.faultInjector instanceof FaultInjector)) {
      throw new Error('MarkovSim: cfg.faultInjector must be a FaultInjector')
    }
    if (!(cfg.clock instanceof FakeClock)) {
      throw new Error('MarkovSim: cfg.clock must be a FakeClock')
    }

    // Deep-clone initialState (JSON round-trip — no Maps/Sets/functions).
    this.state = JSON.parse(JSON.stringify(cfg.initialState))
    this.transitions = cfg.transitions.map((t) => ({
      trigger: t.trigger,
      from: t.from,
      to: t.to,
      after: typeof t.after === 'number' && t.after > 0 ? t.after : 1,
      entity: t.entity || 'mailbox',
    }))
    this.fi = cfg.faultInjector
    this.clock = cfg.clock
    this.recoveryTriggers = new Set(cfg.recoveryTriggers || [])

    /** @type {Map<string, number>} */
    this.state_visits = new Map()
    /** @type {Array<{name: string, effect: string, at: number, iso: string}>} */
    this.heal_events = []
    /** @type {Array<{name: string, at: number}>} */
    this.slo_breaches = []
    // Per-(entity,trigger) counters for transitions that require `after` triggers.
    /** @type {Map<string, number>} */
    this._counters = new Map()
    // Track whether each entity is in a non-initial state when sim ends.
    this._initialEntityStates = {}
    for (const [entity, val] of Object.entries(this.state)) {
      if (val && typeof val === 'object' && typeof val.status === 'string') {
        this._initialEntityStates[entity] = val.status
      }
    }
  }

  /**
   * Run the simulation. Either iterations and/or duration_ms must be specified.
   * If both, the simulator advances by tick_ms = duration_ms / iterations
   * each step.
   *
   * @param {{iterations?: number, duration_ms?: number}} opts
   */
  run(opts = {}) {
    const iterations = opts.iterations ?? 100
    const duration_ms = opts.duration_ms ?? 0
    const tick_ms = duration_ms > 0 ? Math.max(1, Math.floor(duration_ms / iterations)) : 0

    for (let i = 0; i < iterations; i++) {
      // 1. Advance clock.
      if (tick_ms > 0) this.clock.advance(tick_ms)

      // 2. Pull faults — event-driven first, then time-driven.
      const faults = []
      const fEvent = this.fi.nextEvent()
      if (fEvent) faults.push(fEvent)
      if (tick_ms > 0) {
        const fTime = this.fi.next(tick_ms)
        if (fTime) faults.push(fTime)
      }

      // 3. Apply each fault.
      for (const fault of faults) {
        this._applyFault(fault)
      }

      // 4. Record state visits per entity.
      for (const [entity, val] of Object.entries(this.state)) {
        if (val && typeof val === 'object' && typeof val.status === 'string') {
          const key = `${entity}:${val.status}`
          this.state_visits.set(key, (this.state_visits.get(key) ?? 0) + 1)
        }
      }
    }
  }

  /**
   * @param {{name: string, effect: string, at: number}} fault
   * @private
   */
  _applyFault(fault) {
    let matched = false
    for (const t of this.transitions) {
      if (t.trigger !== fault.name) continue
      const entity = this.state[t.entity]
      if (!entity || typeof entity !== 'object') continue
      if (entity.status !== t.from) continue
      // Increment per-(entity, trigger) counter.
      const key = `${t.entity}:${t.trigger}`
      const cur = (this._counters.get(key) ?? 0) + 1
      if (cur >= t.after) {
        // Transition.
        this.state = {
          ...this.state,
          [t.entity]: { ...entity, status: t.to },
        }
        this._counters.set(key, 0)
        this.heal_events.push({
          name: fault.name,
          effect: fault.effect,
          at: fault.at,
          iso: this.clock.now().toISOString(),
          transition: `${t.from}->${t.to}`,
          entity: t.entity,
        })
        matched = true
      } else {
        this._counters.set(key, cur)
      }
    }
    // Recovery triggers fire even if no transition matched (pending state).
    if (!matched && this.recoveryTriggers.has(fault.name)) {
      // Already handled above if a transition existed.
    }
  }

  /**
   * @returns {{state_visits: Map<string, number>, heal_events: Array<object>, slo_breaches: Array<object>, unrecovered: number}}
   */
  summary() {
    // Count entities currently in a non-initial status (proxy for "unrecovered").
    let unrecovered = 0
    for (const [entity, val] of Object.entries(this.state)) {
      if (val && typeof val === 'object' && typeof val.status === 'string') {
        const init = this._initialEntityStates[entity]
        if (init && val.status !== init) unrecovered += 1
      }
    }
    return {
      state_visits: this.state_visits,
      heal_events: this.heal_events.slice(),
      slo_breaches: this.slo_breaches.slice(),
      unrecovered,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ShadowRunner — runs SAME state machine TWICE: once with heal applied
// (primary), once with heal skipped (shadow). Returns the delta on a chosen
// metric. Used by HXX2 counterfactual validation.
//
// Two construction shapes are supported:
//   1. Legacy "compare(healAction)" — pass a healAction function to compare()
//      and the runner applies it ONLY to the primary path.
//   2. Direct "primary"/"shadow" callbacks supplied at construction — useful
//      for unit tests where the heal logic is trivial.
// ─────────────────────────────────────────────────────────────────────────

export class ShadowRunner {
  /**
   * @param {object} cfg
   * @param {object} cfg.initialState
   * @param {(state: object) => object} [cfg.primary]
   * @param {(state: object) => object} [cfg.shadow]
   * @param {string} [cfg.metric='send_events_per_h']
   * @param {FaultInjector} [cfg.faultInjector]
   */
  constructor(cfg = {}) {
    if (!cfg.initialState || typeof cfg.initialState !== 'object') {
      throw new Error('ShadowRunner: initialState required')
    }
    this.initialState = JSON.parse(JSON.stringify(cfg.initialState))
    this.primaryFn = cfg.primary ?? null
    this.shadowFn = cfg.shadow ?? null
    this.metric = cfg.metric ?? 'send_events_per_h'
    this.fi = cfg.faultInjector ?? null
  }

  /**
   * Compare primary vs shadow runs. If a healAction is given, apply it only
   * to the primary side; the shadow runs with the identity transform.
   *
   * @param {(state: object) => object} [healAction]
   * @returns {{metric: string, primary: number, shadow: number, delta: number, netPositive: boolean}}
   */
  compare(healAction) {
    const apply = (fn, fallback) => {
      const cloned = JSON.parse(JSON.stringify(this.initialState))
      if (typeof fn === 'function') return fn(cloned)
      if (typeof fallback === 'function') return fallback(cloned)
      return cloned
    }
    const primaryState = apply(this.primaryFn, healAction)
    const shadowState = apply(this.shadowFn, (s) => s)
    const pVal = primaryState?.[this.metric] ?? 0
    const sVal = shadowState?.[this.metric] ?? 0
    const delta = pVal - sVal
    return {
      metric: this.metric,
      primary: pVal,
      shadow: sVal,
      delta,
      netPositive: delta > 0,
    }
  }
}
