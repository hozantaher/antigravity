// HXX5 — Two-phase heal-action rollback.
//
// Every heal action goes through APPLY → VERIFY → COMMIT|ROLLBACK.
// Verify polls a caller-supplied metric over an observation window
// (default 5 min). If the metric degrades by more than `epsilon`, the
// transaction rolls back to the pre-heal snapshot.
//
// Companion `HealStrategyScorer` tracks per-strategy commit/rollback
// outcomes over a rolling window of the last 10 attempts. Strategies
// whose rollback rate exceeds 0.5 are flagged for demotion so the
// orchestrator stops picking them.
//
// Pure JS, no I/O — drop-in for unit tests and dashboard runtime.

const DEFAULT_OBSERVATION_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_EPSILON = 0.01
const ROLLING_WINDOW_SIZE = 10
const DEMOTE_THRESHOLD = 0.5

/**
 * Defensive deep-freeze. Same shape as `heal-fixtures.js`, kept inline so
 * this module has no internal cross-imports.
 *
 * @template T
 * @param {T} obj
 * @returns {Readonly<T>}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj
  if (Object.isFrozen(obj)) return obj
  for (const key of Object.keys(obj)) {
    const val = obj[key]
    if (val !== null && typeof val === 'object') deepFreeze(val)
  }
  return Object.freeze(obj)
}

/**
 * JSON-shaped deep clone. Strips functions, undefined, and breaks shared
 * references so the result is safe to expose to callers as fresh state.
 *
 * @param {any} v
 */
function cloneJsonish(v) {
  if (v === null || v === undefined) return v
  if (typeof v === 'function') return undefined
  if (Array.isArray(v)) return v.map(cloneJsonish).filter(x => x !== undefined)
  if (typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v)) {
      const cloned = cloneJsonish(v[k])
      if (cloned !== undefined) out[k] = cloned
    }
    return out
  }
  return v
}

/**
 * Default scope falls back to `${strategy}:${entity_id}` when the caller
 * doesn't supply one. This still gives per-entity isolation for parallel
 * heals on different mailboxes / proxies.
 *
 * @param {{ strategy: string, entity_id: string|number, scope?: string }} action
 */
function deriveScope(action) {
  if (action.scope && typeof action.scope === 'string') return action.scope
  return `${action.strategy}:${action.entity_id}`
}

/**
 * Metric contract — supports two shapes:
 *
 *   1. Score metric (arity 1): `(state) => number`
 *      Framework computes delta = metric(current) - metric(baseline).
 *
 *   2. Delta metric (arity ≥ 2): `(current, baseline) => number`
 *      Caller computes the delta directly. Useful when the meaningful
 *      "improvement" needs both states (e.g. ratio, weighted blend).
 *
 * Either way, positive delta means "things got better". `NaN` or a thrown
 * error → rollback (refuse to commit a state we can't measure).
 *
 * @typedef {(currentState: any, baselineState?: any) => number} MetricFn
 */

/**
 * Compute the observed delta. Resolves the metric arity at the call site so
 * the same scorer can be reused for either contract.
 *
 * @param {MetricFn} metric
 * @param {any} current
 * @param {any} baseline
 * @returns {number}
 */
function computeDelta(metric, current, baseline) {
  if (metric.length >= 2) {
    return metric(current, baseline)
  }
  // Arity 1 — framework owns the diff.
  const cur = metric(current)
  const base = metric(baseline)
  return cur - base
}

/**
 * @typedef {object} HealHandle
 * @property {string} id              Unique handle id (transaction-local).
 * @property {string} strategy
 * @property {string|number} entity_id
 * @property {string} scope
 * @property {number} began_at_ms
 * @property {Readonly<any>} snapshot
 * @property {Array<{ t_ms: number, delta: number }>} delta_history
 * @property {boolean} disposed
 */

/**
 * @typedef {object} VerifyResult
 * @property {'commit'|'rollback'|'pending'} decision
 * @property {number} delta
 */

export class HealTransaction {
  /**
   * @param {object} opts
   * @param {MetricFn} opts.metric
   * @param {() => number} [opts.now]
   * @param {number} [opts.observationWindow_ms]
   * @param {number} [opts.epsilon]
   * @param {(src: any) => any} [opts.snapshotter]  Custom snapshotter.
   */
  constructor({
    metric,
    now = () => Date.now(),
    observationWindow_ms = DEFAULT_OBSERVATION_WINDOW_MS,
    epsilon = DEFAULT_EPSILON,
    snapshotter,
  } = {}) {
    if (typeof metric !== 'function') {
      throw new Error('HealTransaction: metric must be a function (state, baseline) => number')
    }
    if (typeof now !== 'function') {
      throw new Error('HealTransaction: now must be a function returning ms')
    }
    if (typeof observationWindow_ms !== 'number' || observationWindow_ms < 0) {
      throw new Error('HealTransaction: observationWindow_ms must be a non-negative number')
    }
    if (typeof epsilon !== 'number' || epsilon < 0) {
      throw new Error('HealTransaction: epsilon must be a non-negative number')
    }
    this._metric = metric
    this._now = now
    this._window_ms = observationWindow_ms
    this._epsilon = epsilon
    this._snapshotter = typeof snapshotter === 'function' ? snapshotter : null
    /** @type {Map<string, HealHandle>} key=handle.id */
    this._handles = new Map()
    /** @type {Map<string, string>} key=scope → handle.id */
    this._scopeIndex = new Map()
    this._nextId = 1
  }

  /**
   * Phase 1: capture baseline + open the transaction.
   *
   * @param {any} state
   * @param {{ strategy: string, entity_id: string|number, scope?: string }} healAction
   * @returns {HealHandle}
   */
  begin(state, healAction) {
    if (state === null || state === undefined) {
      throw new Error('HealTransaction.begin: state is required')
    }
    if (!healAction || typeof healAction !== 'object') {
      throw new Error('HealTransaction.begin: healAction is required')
    }
    if (!healAction.strategy || typeof healAction.strategy !== 'string') {
      throw new Error('HealTransaction.begin: healAction.strategy must be a non-empty string')
    }
    if (healAction.entity_id === undefined || healAction.entity_id === null) {
      throw new Error('HealTransaction.begin: healAction.entity_id is required')
    }

    const scope = deriveScope(healAction)
    if (this._scopeIndex.has(scope)) {
      throw new Error(`HealTransaction.begin: heal already in flight for scope=${scope} (nested begin not allowed)`)
    }

    const cloned = this._snapshotter ? this._snapshotter(state) : cloneJsonish(state)
    const snapshot = deepFreeze(cloned)

    const id = `tx-${this._nextId++}`
    /** @type {HealHandle} */
    const handle = {
      id,
      strategy: healAction.strategy,
      entity_id: healAction.entity_id,
      scope,
      began_at_ms: this._now(),
      snapshot,
      delta_history: [],
      disposed: false,
    }
    this._handles.set(id, handle)
    this._scopeIndex.set(scope, id)
    return handle
  }

  /**
   * Phase 2: poll the metric. Decision is `pending` until the observation
   * window elapses; then `commit` or `rollback` based on delta vs epsilon.
   *
   * Decision rule:
   *   delta >= -epsilon → commit (improvement OR within tolerance)
   *   delta <  -epsilon → rollback
   *
   * @param {HealHandle} handle
   * @param {any} currentState
   * @returns {VerifyResult}
   */
  verify(handle, currentState) {
    this._assertLiveHandle(handle)

    const now = this._now()
    const elapsed = now - handle.began_at_ms

    let delta
    try {
      delta = computeDelta(this._metric, currentState, handle.snapshot)
    } catch (err) {
      // Metric blew up → treat as rollback signal so we don't commit
      // a state we can't measure.
      handle.delta_history.push({ t_ms: now, delta: NaN })
      return { decision: 'rollback', delta: NaN }
    }

    if (typeof delta !== 'number' || Number.isNaN(delta)) {
      handle.delta_history.push({ t_ms: now, delta: NaN })
      return { decision: 'rollback', delta: NaN }
    }

    handle.delta_history.push({ t_ms: now, delta })

    if (elapsed < this._window_ms) {
      return { decision: 'pending', delta }
    }

    if (delta < -this._epsilon) {
      return { decision: 'rollback', delta }
    }
    return { decision: 'commit', delta }
  }

  /**
   * Phase 3a: commit. Removes the handle from active tracking.
   *
   * @param {HealHandle} handle
   */
  commit(handle) {
    this._assertLiveHandle(handle)
    handle.disposed = true
    this._handles.delete(handle.id)
    this._scopeIndex.delete(handle.scope)
  }

  /**
   * Phase 3b: rollback. Returns a fresh clone of the pre-heal snapshot and
   * disposes the handle. Caller is responsible for applying the restored
   * state to whichever live system was healed (mailbox row, proxy pool, …).
   *
   * @param {HealHandle} handle
   * @returns {any} restored state (deep-equal to begin() input)
   */
  rollback(handle) {
    this._assertLiveHandle(handle)
    const restored = cloneJsonish(handle.snapshot)
    handle.disposed = true
    this._handles.delete(handle.id)
    this._scopeIndex.delete(handle.scope)
    return restored
  }

  /**
   * Number of in-flight transactions across all scopes.
   * @returns {number}
   */
  activeCount() {
    return this._handles.size
  }

  /**
   * @param {HealHandle} handle
   */
  _assertLiveHandle(handle) {
    if (!handle || typeof handle !== 'object') {
      throw new Error('HealTransaction: invalid handle')
    }
    if (handle.disposed || !this._handles.has(handle.id)) {
      throw new Error(`HealTransaction: handle disposed or unknown handle id=${handle?.id ?? '<none>'}`)
    }
  }
}

/**
 * HealStrategyScorer — rolling-window outcome tracker per strategy.
 *
 * Window size is fixed at 10. `shouldDemote` reports true when the
 * rollback rate over the active window exceeds 0.5. With fewer than
 * `ROLLING_WINDOW_SIZE` recorded outcomes, demotion is suppressed
 * regardless of the rate (refuse to demote on weak signal).
 */
export class HealStrategyScorer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowSize=10]
   * @param {number} [opts.demoteThreshold=0.5]
   */
  constructor({ windowSize = ROLLING_WINDOW_SIZE, demoteThreshold = DEMOTE_THRESHOLD } = {}) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new Error('HealStrategyScorer: windowSize must be a positive integer')
    }
    if (typeof demoteThreshold !== 'number' || demoteThreshold < 0 || demoteThreshold > 1) {
      throw new Error('HealStrategyScorer: demoteThreshold must be in [0,1]')
    }
    this._windowSize = windowSize
    this._demoteThreshold = demoteThreshold
    /** @type {Map<string, Array<'commit'|'rollback'>>} */
    this._history = new Map()
  }

  /**
   * @param {string} strategy
   * @param {'commit'|'rollback'} outcome
   */
  recordOutcome(strategy, outcome) {
    if (!strategy || typeof strategy !== 'string') {
      throw new Error('HealStrategyScorer.recordOutcome: strategy required (non-empty string)')
    }
    if (outcome !== 'commit' && outcome !== 'rollback') {
      throw new Error(`HealStrategyScorer.recordOutcome: outcome must be 'commit' or 'rollback', got ${outcome}`)
    }
    const list = this._history.get(strategy) ?? []
    list.push(outcome)
    while (list.length > this._windowSize) list.shift()
    this._history.set(strategy, list)
  }

  /**
   * @param {string} strategy
   * @returns {number}  rollback share of the rolling window, 0..1
   */
  rollbackRate(strategy) {
    const list = this._history.get(strategy)
    if (!list || list.length === 0) return 0
    let rollbacks = 0
    for (const o of list) if (o === 'rollback') rollbacks += 1
    return rollbacks / list.length
  }

  /**
   * Demote only when there's enough signal AND the rate crosses the threshold.
   * Empty / sparse history → false (don't punish strategies we haven't tested).
   *
   * @param {string} strategy
   * @returns {boolean}
   */
  shouldDemote(strategy) {
    const list = this._history.get(strategy)
    if (!list || list.length < this._windowSize) return false
    return this.rollbackRate(strategy) > this._demoteThreshold
  }

  /**
   * Internal accessor used by property tests (rolling-window invariant).
   *
   * @param {string} strategy
   * @returns {number}
   */
  historyLength(strategy) {
    return this._history.get(strategy)?.length ?? 0
  }
}
