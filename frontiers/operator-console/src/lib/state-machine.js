// state-machine.js — Pure helpers for state-machine invariant checking.
// Used by HX2 (anti-thrash), HX8 (formal invariants), HXX8 (advanced invariants).
//
// No dependencies, deterministic with seed.
// Mailbox state machine reference: services/campaigns/sender/engine.go
//   states: active | paused | warming | retired | needs_human

/**
 * Directed graph of allowed transitions between states.
 *
 * @example
 *   const sg = new StateGraph(['active', 'paused'])
 *   sg.addEdge('active', 'paused', { reason: 'breaker_tripped' })
 *   sg.canTransition('active', 'paused') // true
 */
export class StateGraph {
  /**
   * @param {string[]} states  Allowed states for this graph.
   */
  constructor(states) {
    if (!Array.isArray(states) || states.length === 0) {
      throw new Error('StateGraph: states must be a non-empty array')
    }
    this.states = [...states]
    this.stateSet = new Set(states)
    /** @type {Map<string, Array<{ to: string, meta: object }>>} */
    this.outgoing = new Map()
    /** @type {Set<string>} */
    this.absorbing = new Set()
    for (const s of states) {
      this.outgoing.set(s, [])
    }
  }

  /**
   * Register a directed transition from → to with optional metadata.
   * @param {string} from
   * @param {string} to
   * @param {object} [meta]
   */
  addEdge(from, to, meta = {}) {
    if (!this.stateSet.has(from)) {
      throw new Error(`addEdge: unknown state '${from}'`)
    }
    if (!this.stateSet.has(to)) {
      throw new Error(`addEdge: unknown state '${to}'`)
    }
    const edges = this.outgoing.get(from)
    // Avoid duplicate edges (idempotent on (from, to)).
    if (!edges.some((e) => e.to === to)) {
      edges.push({ to, meta: { ...meta } })
    }
  }

  /**
   * @param {string} from
   * @param {string} to
   * @returns {boolean}
   */
  canTransition(from, to) {
    if (!this.stateSet.has(from) || !this.stateSet.has(to)) return false
    const edges = this.outgoing.get(from) || []
    return edges.some((e) => e.to === to)
  }

  /**
   * @param {string} from
   * @returns {string[]} successor state names
   */
  successors(from) {
    if (!this.stateSet.has(from)) return []
    return (this.outgoing.get(from) || []).map((e) => e.to)
  }

  /**
   * Mark a state as absorbing (no outgoing transitions allowed).
   * Existing outgoing edges remain in the graph but are flagged.
   * @param {string} state
   */
  markAbsorbing(state) {
    if (!this.stateSet.has(state)) {
      throw new Error(`markAbsorbing: unknown state '${state}'`)
    }
    this.absorbing.add(state)
  }

  /**
   * @returns {string[]} states that have been marked absorbing.
   */
  absorbingStates() {
    return [...this.absorbing]
  }
}

/**
 * Mulberry32 deterministic PRNG. Pure, dependency-free.
 * @param {number} seed
 * @returns {() => number} a function returning a float in [0, 1).
 */
function mulberry32(seed) {
  let t = seed >>> 0
  return function next() {
    t = (t + 0x6D2B79F5) >>> 0
    let r = t
    r = Math.imul(r ^ (r >>> 15), r | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * BFS depth-bounded enumeration of all reachable state sequences.
 * Each enumerated trace is fed to the predicate; sequences that fail are
 * collected as violations.
 *
 * Absorbing states halt expansion of their branch (no outgoing edges traversed).
 *
 * @param {StateGraph} sg
 * @param {string} startState
 * @param {number} [maxDepth=10]
 * @param {(trace: string[]) => boolean} [predicate=() => true]
 * @returns {{ violations: string[][] }}
 */
export function exhaustiveCheck(sg, startState, maxDepth = 10, predicate = () => true) {
  if (!(sg instanceof StateGraph)) {
    throw new Error('exhaustiveCheck: first arg must be a StateGraph')
  }
  if (!sg.stateSet.has(startState)) {
    throw new Error(`exhaustiveCheck: unknown startState '${startState}'`)
  }
  if (typeof maxDepth !== 'number' || maxDepth < 0) {
    throw new Error('exhaustiveCheck: maxDepth must be a non-negative number')
  }

  const violations = []
  // Queue holds traces (each trace is a list of states).
  /** @type {string[][]} */
  const queue = [[startState]]

  while (queue.length > 0) {
    const trace = queue.shift()
    let predicateResult
    try {
      predicateResult = predicate(trace)
    } catch (err) {
      // Predicate errors are recorded as violations carrying the same trace.
      violations.push([...trace])
      continue
    }
    if (predicateResult === false) {
      violations.push([...trace])
    }
    // Stop expanding past maxDepth (depth = hops from start = trace.length - 1).
    if (trace.length - 1 >= maxDepth) continue
    const last = trace[trace.length - 1]
    // Absorbing states halt expansion.
    if (sg.absorbing.has(last)) continue
    const succ = sg.successors(last)
    for (const next of succ) {
      queue.push([...trace, next])
    }
  }

  return { violations }
}

/**
 * Sampled traversal for graphs too large for exhaustive enumeration.
 * Deterministic when called with the same seed.
 *
 * If the current state has no outgoing edges (or is absorbing with no edges),
 * traversal terminates early.
 *
 * @param {StateGraph} sg
 * @param {string} startState
 * @param {number} [length=100]
 * @param {number} [seed=42]
 * @returns {string[]} trace
 */
export function randomTraversal(sg, startState, length = 100, seed = 42) {
  if (!(sg instanceof StateGraph)) {
    throw new Error('randomTraversal: first arg must be a StateGraph')
  }
  if (!sg.stateSet.has(startState)) {
    throw new Error(`randomTraversal: unknown startState '${startState}'`)
  }
  const rng = mulberry32(seed)
  const trace = [startState]
  let current = startState
  for (let i = 0; i < length; i++) {
    if (sg.absorbing.has(current)) break
    const succ = sg.successors(current)
    if (succ.length === 0) break
    const idx = Math.floor(rng() * succ.length)
    current = succ[idx]
    trace.push(current)
  }
  return trace
}

/**
 * Predicate-based assertion over all reachable traces from startState
 * up to opts.maxDepth (default 10). Throws with a counterexample trace on failure.
 *
 * @param {StateGraph} sg
 * @param {string} startState
 * @param {(trace: string[]) => boolean} predicate
 * @param {{ maxDepth?: number }} [opts]
 */
export function assertInvariant(sg, startState, predicate, opts = {}) {
  const { maxDepth = 10 } = opts
  const { violations } = exhaustiveCheck(sg, startState, maxDepth, predicate)
  if (violations.length > 0) {
    const counter = violations[0]
    throw new Error(
      `Invariant violated. Counterexample trace (${violations.length} total): ${counter.join(' → ')}`
    )
  }
}

/**
 * Assert that `to` is reachable from `from` via some path. Self-loops
 * (from === to with an explicit self-edge) count as reachable.
 *
 * @param {StateGraph} sg
 * @param {string} from
 * @param {string} to
 */
export function assertReachable(sg, from, to) {
  if (!(sg instanceof StateGraph)) {
    throw new Error('assertReachable: first arg must be a StateGraph')
  }
  if (!sg.stateSet.has(from)) {
    throw new Error(`assertReachable: unknown state '${from}'`)
  }
  if (!sg.stateSet.has(to)) {
    throw new Error(`assertReachable: unknown state '${to}'`)
  }

  // Self-reachability requires an explicit self-loop; otherwise BFS from
  // successors covers it.
  if (from === to && sg.canTransition(from, to)) return

  const visited = new Set()
  const queue = [from]
  while (queue.length > 0) {
    const node = queue.shift()
    for (const next of sg.successors(node)) {
      if (next === to) return
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  throw new Error(`'${to}' is not reachable from '${from}'`)
}

/**
 * Assert that a state is absorbing — once entered, no outgoing transitions
 * lead anywhere. Self-loops are tolerated (a self-loop is the canonical way
 * to model an absorbing state in some formalisms), but transitions to any
 * other state cause failure.
 *
 * @param {StateGraph} sg
 * @param {string} state
 */
export function assertAbsorbing(sg, state) {
  if (!(sg instanceof StateGraph)) {
    throw new Error('assertAbsorbing: first arg must be a StateGraph')
  }
  if (!sg.stateSet.has(state)) {
    throw new Error(`assertAbsorbing: unknown state '${state}'`)
  }
  const succ = sg.successors(state)
  const escapes = succ.filter((s) => s !== state)
  if (escapes.length > 0) {
    throw new Error(
      `State '${state}' is not absorbing — has outgoing transitions to: ${escapes.join(', ')}`
    )
  }
}
