// state-machine.test.js — Tests for state-machine invariant helpers.
// Used by HX2 (anti-thrash), HX8 (formal invariants), HXX8 (advanced invariants).
// TDD RED first.

import { describe, it, expect } from 'vitest'
import {
  StateGraph,
  exhaustiveCheck,
  randomTraversal,
  assertInvariant,
  assertReachable,
  assertAbsorbing,
} from '../../../src/lib/state-machine.js'

describe('StateGraph — basic API', () => {
  it('addEdge registers a transition between states', () => {
    const sg = new StateGraph(['active', 'paused'])
    sg.addEdge('active', 'paused', { reason: 'breaker_tripped' })
    expect(sg.canTransition('active', 'paused')).toBe(true)
  })

  it('canTransition returns false for unregistered transitions', () => {
    const sg = new StateGraph(['active', 'paused'])
    sg.addEdge('active', 'paused')
    expect(sg.canTransition('paused', 'active')).toBe(false)
  })

  it('canTransition returns false for unknown states', () => {
    const sg = new StateGraph(['active', 'paused'])
    sg.addEdge('active', 'paused')
    expect(sg.canTransition('active', 'nonexistent')).toBe(false)
    expect(sg.canTransition('nonexistent', 'paused')).toBe(false)
  })

  it('addEdge throws on unknown state', () => {
    const sg = new StateGraph(['active', 'paused'])
    expect(() => sg.addEdge('active', 'nonexistent')).toThrow(/unknown state/i)
    expect(() => sg.addEdge('nonexistent', 'paused')).toThrow(/unknown state/i)
  })
})

describe('exhaustiveCheck — depth-bounded BFS enumeration', () => {
  it('respects maxDepth bound', () => {
    const sg = new StateGraph(['a', 'b', 'c'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'c')
    sg.addEdge('c', 'a')
    // Predicate that records max trace length seen.
    let maxLen = 0
    exhaustiveCheck(sg, 'a', 3, (trace) => {
      if (trace.length > maxLen) maxLen = trace.length
      return true
    })
    // Depth 3 means the BFS visits sequences of length up to 1 + 3 = 4 states (start + 3 hops).
    expect(maxLen).toBeLessThanOrEqual(4)
  })

  it('reports violations when predicate fails', () => {
    const sg = new StateGraph(['a', 'b', 'c'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'c')
    // Predicate fails when trace ends in 'c'.
    const result = exhaustiveCheck(sg, 'a', 5, (trace) => {
      return trace[trace.length - 1] !== 'c'
    })
    expect(result.violations.length).toBeGreaterThan(0)
    // Counter-example trace must end in 'c'.
    expect(result.violations[0][result.violations[0].length - 1]).toBe('c')
  })

  it('returns empty violations when predicate always holds', () => {
    const sg = new StateGraph(['a', 'b'])
    sg.addEdge('a', 'b')
    const result = exhaustiveCheck(sg, 'a', 5, () => true)
    expect(result.violations).toEqual([])
  })
})

describe('randomTraversal — sampled traversal', () => {
  it('produces deterministic output with the same seed', () => {
    const sg = new StateGraph(['a', 'b', 'c'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'c')
    sg.addEdge('c', 'a')
    sg.addEdge('a', 'c')
    const t1 = randomTraversal(sg, 'a', 20, 42)
    const t2 = randomTraversal(sg, 'a', 20, 42)
    expect(t1).toEqual(t2)
  })

  it('produces different output with a different seed', () => {
    const sg = new StateGraph(['a', 'b', 'c'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'c')
    sg.addEdge('c', 'a')
    sg.addEdge('a', 'c')
    const t1 = randomTraversal(sg, 'a', 50, 42)
    const t2 = randomTraversal(sg, 'a', 50, 1337)
    // With this graph and 50 hops, two different seeds should diverge.
    expect(t1).not.toEqual(t2)
  })

  it('respects length bound and only follows valid edges', () => {
    const sg = new StateGraph(['a', 'b', 'c'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'c')
    sg.addEdge('c', 'a')
    const trace = randomTraversal(sg, 'a', 10, 7)
    expect(trace.length).toBeLessThanOrEqual(11) // start + 10 hops
    expect(trace[0]).toBe('a')
    for (let i = 1; i < trace.length; i++) {
      expect(sg.canTransition(trace[i - 1], trace[i])).toBe(true)
    }
  })
})

describe('assertInvariant — predicate-based invariant', () => {
  it('passes when invariant holds for all reachable traces', () => {
    const sg = new StateGraph(['a', 'b'])
    sg.addEdge('a', 'b')
    expect(() =>
      assertInvariant(sg, 'a', (trace) => trace.length <= 100, { maxDepth: 5 })
    ).not.toThrow()
  })

  it('throws with a counterexample trace when invariant fails', () => {
    const sg = new StateGraph(['a', 'b', 'c'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'c')
    let err
    try {
      assertInvariant(sg, 'a', (trace) => !trace.includes('c'), { maxDepth: 5 })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    // The error message must include the counterexample trace.
    expect(err.message).toMatch(/c/)
    expect(err.message).toMatch(/counterexample|trace|→/i)
  })

  it('throws on absorbing state with a self-violating predicate', () => {
    const sg = new StateGraph(['a', 'b'])
    sg.addEdge('a', 'b')
    sg.markAbsorbing('b')
    expect(() =>
      assertInvariant(sg, 'a', (trace) => !trace.includes('b'), { maxDepth: 3 })
    ).toThrow()
  })
})

describe('assertReachable — start → end reachability', () => {
  it('passes when target is reachable in multiple hops', () => {
    const sg = new StateGraph(['a', 'b', 'c', 'd'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'c')
    sg.addEdge('c', 'd')
    expect(() => assertReachable(sg, 'a', 'd')).not.toThrow()
  })

  it('throws when target is unreachable', () => {
    const sg = new StateGraph(['a', 'b', 'c'])
    sg.addEdge('a', 'b')
    // c has no incoming edge.
    expect(() => assertReachable(sg, 'a', 'c')).toThrow(/unreachable|not reachable/i)
  })

  it('handles self-loops as reachable', () => {
    const sg = new StateGraph(['a'])
    sg.addEdge('a', 'a')
    expect(() => assertReachable(sg, 'a', 'a')).not.toThrow()
  })
})

describe('assertAbsorbing — once-entered, no exit', () => {
  it('passes for a state with no outgoing edges', () => {
    const sg = new StateGraph(['a', 'b', 'retired'])
    sg.addEdge('a', 'retired')
    sg.addEdge('b', 'retired')
    expect(() => assertAbsorbing(sg, 'retired')).not.toThrow()
  })

  it('throws when the state has outgoing edges', () => {
    const sg = new StateGraph(['a', 'b'])
    sg.addEdge('a', 'b')
    sg.addEdge('b', 'a')
    expect(() => assertAbsorbing(sg, 'b')).toThrow(/not absorbing|outgoing/i)
  })
})

describe('Mailbox state machine — TLA+-style invariants', () => {
  // Real states from BOARD line 220+: features/outreach/campaigns/sender/engine.go.
  const mailboxStates = ['active', 'paused', 'warming', 'retired', 'needs_human']

  function buildMailboxGraph() {
    const sg = new StateGraph(mailboxStates)
    // Lifecycle transitions per engine.go semantics.
    sg.addEdge('warming', 'active', { reason: 'warmup_complete' })
    sg.addEdge('active', 'paused', { reason: 'breaker_tripped' })
    sg.addEdge('paused', 'active', { reason: 'cooldown_expired' })
    sg.addEdge('paused', 'needs_human', { reason: 'escalation' })
    sg.addEdge('paused', 'retired', { reason: 'permanent_failure' })
    sg.addEdge('needs_human', 'active', { reason: 'human_unblocked' })
    sg.addEdge('needs_human', 'retired', { reason: 'human_retired' })
    sg.addEdge('active', 'retired', { reason: 'manual_decommission' })
    sg.addEdge('warming', 'paused', { reason: 'warmup_failed' })
    sg.markAbsorbing('retired')
    return sg
  }

  it('retired is absorbing — no escape once entered', () => {
    const sg = buildMailboxGraph()
    expect(() => assertAbsorbing(sg, 'retired')).not.toThrow()
  })

  it('from active, needs_human is reachable in ≤3 hops', () => {
    const sg = buildMailboxGraph()
    // active → paused → needs_human (2 hops) — well under 3.
    expect(() => assertReachable(sg, 'active', 'needs_human')).not.toThrow()
    // Verify hop count via BFS-shortest-path probe.
    const result = exhaustiveCheck(sg, 'active', 3, (trace) => {
      // Predicate "always true" — we only care that some trace reaches needs_human.
      return true
    })
    // Reachability already asserted above; here we ensure depth-3 BFS observed needs_human.
    let foundDepth = -1
    exhaustiveCheck(sg, 'active', 3, (trace) => {
      if (trace.includes('needs_human') && foundDepth === -1) {
        foundDepth = trace.length - 1 // hops from start
      }
      return true
    })
    expect(foundDepth).toBeGreaterThan(0)
    expect(foundDepth).toBeLessThanOrEqual(3)
  })

  it('needs_human cannot be reached without first transitioning through paused', () => {
    const sg = buildMailboxGraph()
    // Invariant: every trace ending in 'needs_human' must contain 'paused' earlier.
    const result = exhaustiveCheck(sg, 'active', 6, (trace) => {
      const idx = trace.lastIndexOf('needs_human')
      if (idx <= 0) return true // no needs_human in trace, or it's the start (impossible here)
      // Must have seen 'paused' before this point.
      const prefix = trace.slice(0, idx)
      return prefix.includes('paused')
    })
    expect(result.violations).toEqual([])
  })

  it('exhaustiveCheck on the 5-state mailbox graph at depth 10 completes <100ms', () => {
    const sg = buildMailboxGraph()
    const start = performance.now()
    exhaustiveCheck(sg, 'active', 10, () => true)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
  })
})
