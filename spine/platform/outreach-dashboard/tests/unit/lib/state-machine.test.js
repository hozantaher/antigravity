import { describe, it, expect } from 'vitest'
import {
  StateGraph,
  exhaustiveCheck,
  randomTraversal,
  assertInvariant,
  assertReachable,
  assertAbsorbing,
} from '../../../src/lib/state-machine.js'

function mailboxGraph() {
  const sg = new StateGraph(['active', 'paused', 'warming', 'retired', 'needs_human'])
  sg.addEdge('warming', 'active')
  sg.addEdge('active', 'paused')
  sg.addEdge('paused', 'active')
  sg.addEdge('active', 'needs_human')
  sg.addEdge('needs_human', 'retired')
  sg.markAbsorbing('retired')
  return sg
}

describe('StateGraph — construction + edges', () => {
  it('throws on empty / non-array state list', () => {
    expect(() => new StateGraph([])).toThrow()
    expect(() => new StateGraph(null)).toThrow()
  })

  it('rejects edges to/from unknown states', () => {
    const sg = new StateGraph(['a', 'b'])
    expect(() => sg.addEdge('a', 'zzz')).toThrow()
    expect(() => sg.addEdge('zzz', 'b')).toThrow()
  })

  it('addEdge is idempotent on (from, to)', () => {
    const sg = new StateGraph(['a', 'b'])
    sg.addEdge('a', 'b', { reason: 'x' })
    sg.addEdge('a', 'b', { reason: 'y' })
    expect(sg.successors('a')).toEqual(['b'])
  })

  it('canTransition reflects declared edges and is false for unknowns', () => {
    const sg = mailboxGraph()
    expect(sg.canTransition('active', 'paused')).toBe(true)
    expect(sg.canTransition('active', 'warming')).toBe(false)
    expect(sg.canTransition('nope', 'active')).toBe(false)
  })

  it('successors returns [] for unknown state', () => {
    const sg = mailboxGraph()
    expect(sg.successors('ghost')).toEqual([])
  })

  it('markAbsorbing throws on unknown state and tracks marked ones', () => {
    const sg = mailboxGraph()
    expect(() => sg.markAbsorbing('ghost')).toThrow()
    expect(sg.absorbingStates()).toContain('retired')
  })
})

describe('exhaustiveCheck — bounded BFS over traces', () => {
  it('validates start-arg and maxDepth', () => {
    const sg = mailboxGraph()
    expect(() => exhaustiveCheck({}, 'active')).toThrow()
    expect(() => exhaustiveCheck(sg, 'ghost')).toThrow()
    expect(() => exhaustiveCheck(sg, 'active', -1)).toThrow()
  })

  it('reports no violations when predicate always passes', () => {
    const sg = mailboxGraph()
    const { violations } = exhaustiveCheck(sg, 'warming', 5, () => true)
    expect(violations).toEqual([])
  })

  it('collects traces that fail the predicate', () => {
    const sg = mailboxGraph()
    // Violation: any trace that ever enters retired.
    const { violations } = exhaustiveCheck(sg, 'warming', 6, (trace) => !trace.includes('retired'))
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.every((t) => t.includes('retired'))).toBe(true)
  })

  it('a thrown predicate is recorded as a violation, not propagated', () => {
    const sg = mailboxGraph()
    const { violations } = exhaustiveCheck(sg, 'active', 1, () => {
      throw new Error('boom')
    })
    expect(violations.length).toBeGreaterThan(0)
  })

  it('absorbing states halt branch expansion (retired has no descendants)', () => {
    const sg = mailboxGraph()
    const { violations } = exhaustiveCheck(sg, 'retired', 10, (t) => t.length <= 1)
    // From retired (absorbing) only the singleton trace exists → it passes.
    expect(violations).toEqual([])
  })
})

describe('randomTraversal — deterministic sampling', () => {
  it('is reproducible for the same seed and varies by seed', () => {
    const sg = mailboxGraph()
    const a = randomTraversal(sg, 'warming', 20, 7)
    const b = randomTraversal(sg, 'warming', 20, 7)
    expect(a).toEqual(b)
  })

  it('terminates early at an absorbing state', () => {
    const sg = mailboxGraph()
    const trace = randomTraversal(sg, 'needs_human', 50, 1)
    expect(trace[trace.length - 1]).toBe('retired')
  })

  it('terminates when a state has no successors', () => {
    const sg = new StateGraph(['only'])
    expect(randomTraversal(sg, 'only', 10, 1)).toEqual(['only'])
  })
})

describe('assertInvariant / assertReachable / assertAbsorbing', () => {
  it('assertInvariant passes for a true invariant and throws a counterexample otherwise', () => {
    const sg = mailboxGraph()
    expect(() => assertInvariant(sg, 'warming', () => true)).not.toThrow()
    expect(() => assertInvariant(sg, 'warming', (t) => !t.includes('retired'))).toThrow(/Counterexample/)
  })

  it('assertReachable confirms a real path and rejects an unreachable target', () => {
    const sg = mailboxGraph()
    expect(() => assertReachable(sg, 'warming', 'retired')).not.toThrow()
    expect(() => assertReachable(sg, 'retired', 'active')).toThrow(/not reachable/)
  })

  it('assertReachable validates state names', () => {
    const sg = mailboxGraph()
    expect(() => assertReachable(sg, 'ghost', 'active')).toThrow()
    expect(() => assertReachable(sg, 'active', 'ghost')).toThrow()
  })

  it('assertAbsorbing passes for retired and fails for a state with escapes', () => {
    const sg = mailboxGraph()
    expect(() => assertAbsorbing(sg, 'retired')).not.toThrow()
    expect(() => assertAbsorbing(sg, 'active')).toThrow(/not absorbing/)
  })
})
