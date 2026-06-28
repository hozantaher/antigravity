// HX1 — Cascading dependency recovery (DAG order).
// 5-stage chain:  anti-trace ← relay ← sender ← bff-cron ← reporter
// (reporter depends on bff-cron, bff-cron on sender, …, anti-trace at root)
//
// When root fails, all downstream pause. Recovery applies in topological
// order: anti-trace heals first, then relay, then sender, etc. No premature
// retry — sender does not probe SMTP before relay /healthz green.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  buildDependencyDAG,
  cascadeFailure,
  cascadeRecovery,
  topologicalHealOrder,
  isHealReadyFor,
} from '../../../src/lib/heal-cascade.js'

const NODES = ['anti_trace', 'relay', 'sender', 'bff_cron', 'reporter']

function buildProductionDAG() {
  // Edges represent "depends on" — relay depends on anti_trace, etc.
  return buildDependencyDAG([
    ['relay',     'anti_trace'],
    ['sender',    'relay'],
    ['bff_cron',  'sender'],
    ['reporter',  'bff_cron'],
  ])
}

describe('HX1 — Dependency DAG construction', () => {
  it('builds 5-node DAG with 4 edges', () => {
    const dag = buildProductionDAG()
    expect(dag.nodes).toEqual(expect.arrayContaining(NODES))
    expect(dag.nodes.length).toBe(5)
  })

  it('rejects cyclic graph', () => {
    expect(() => buildDependencyDAG([
      ['a', 'b'],
      ['b', 'a'],
    ])).toThrow(/cycl/i)
  })

  it('rejects self-loop', () => {
    expect(() => buildDependencyDAG([['a', 'a']])).toThrow()
  })
})

describe('HX1 — topologicalHealOrder', () => {
  it('returns roots first, leaves last', () => {
    const dag = buildProductionDAG()
    const order = topologicalHealOrder(dag)
    expect(order[0]).toBe('anti_trace')
    expect(order[order.length - 1]).toBe('reporter')
  })

  it('respects all edge constraints (each node after its deps)', () => {
    const dag = buildProductionDAG()
    const order = topologicalHealOrder(dag)
    const idx = name => order.indexOf(name)
    expect(idx('anti_trace')).toBeLessThan(idx('relay'))
    expect(idx('relay')).toBeLessThan(idx('sender'))
    expect(idx('sender')).toBeLessThan(idx('bff_cron'))
    expect(idx('bff_cron')).toBeLessThan(idx('reporter'))
  })

  it('disconnected components ordered independently', () => {
    const dag = buildDependencyDAG([
      ['a', 'b'],   // a depends on b
      ['c', 'd'],   // c depends on d
    ])
    const order = topologicalHealOrder(dag)
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'))
    expect(order.indexOf('d')).toBeLessThan(order.indexOf('c'))
  })
})

describe('HX1 — Cascading failure propagation', () => {
  it('failure at root marks all downstream as unhealthy', () => {
    const state = cascadeFailure(buildProductionDAG(), 'anti_trace')
    expect(state.unhealthy).toEqual(expect.arrayContaining(NODES))
    expect(state.unhealthy.length).toBe(5)
  })

  it('failure at relay marks 4 nodes (relay + downstream)', () => {
    const state = cascadeFailure(buildProductionDAG(), 'relay')
    expect(state.unhealthy.sort()).toEqual(['bff_cron', 'relay', 'reporter', 'sender'])
  })

  it('failure at leaf (reporter) marks only reporter', () => {
    const state = cascadeFailure(buildProductionDAG(), 'reporter')
    expect(state.unhealthy).toEqual(['reporter'])
  })

  it('failure at middle node propagates downstream', () => {
    const state = cascadeFailure(buildProductionDAG(), 'sender')
    expect(state.unhealthy.sort()).toEqual(['bff_cron', 'reporter', 'sender'])
  })

  it('upstream nodes unaffected when downstream fails', () => {
    const state = cascadeFailure(buildProductionDAG(), 'sender')
    expect(state.unhealthy.includes('anti_trace')).toBe(false)
    expect(state.unhealthy.includes('relay')).toBe(false)
  })
})

describe('HX1 — Cascading recovery in topological order', () => {
  it('recovery from total outage proceeds in topological order', () => {
    const dag = buildProductionDAG()
    const failed = cascadeFailure(dag, 'anti_trace')
    const recovery = cascadeRecovery(dag, failed.unhealthy)
    // recovery is the order in which heal actions should be applied
    expect(recovery[0]).toBe('anti_trace')
    expect(recovery[recovery.length - 1]).toBe('reporter')
  })

  it('isHealReadyFor: leaf cannot heal until upstream healed', () => {
    const dag = buildProductionDAG()
    const stillUnhealthy = ['relay', 'sender', 'bff_cron', 'reporter']  // anti_trace already healed
    expect(isHealReadyFor('relay',    dag, stillUnhealthy)).toBe(true)
    expect(isHealReadyFor('sender',   dag, stillUnhealthy)).toBe(false)
    expect(isHealReadyFor('reporter', dag, stillUnhealthy)).toBe(false)
  })

  it('all roots ready when nothing depends on them', () => {
    const dag = buildProductionDAG()
    expect(isHealReadyFor('anti_trace', dag, NODES)).toBe(true)
  })

  it('partial recovery: heal anti_trace+relay → sender ready', () => {
    const dag = buildProductionDAG()
    const stillUnhealthy = ['sender', 'bff_cron', 'reporter']
    expect(isHealReadyFor('sender',   dag, stillUnhealthy)).toBe(true)
    expect(isHealReadyFor('bff_cron', dag, stillUnhealthy)).toBe(false)
  })
})

describe('HX1 — Properties', () => {
  it('topologicalHealOrder always respects edges', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(
        fc.constantFrom(...NODES),
        fc.constantFrom(...NODES)
      ), { minLength: 0, maxLength: 6 }),
      (rawEdges) => {
        // De-dup + filter self-loops
        const edges = rawEdges.filter(([a, b]) => a !== b)
        // Skip if would create cycle (test other cases)
        try {
          const dag = buildDependencyDAG(edges)
          const order = topologicalHealOrder(dag)
          for (const [from, to] of edges) {
            const fromIdx = order.indexOf(from)
            const toIdx   = order.indexOf(to)
            if (toIdx >= 0 && fromIdx >= 0 && toIdx >= fromIdx) return false
          }
          return true
        } catch (e) {
          // cyclic — skip
          return /cycl/i.test(e.message)
        }
      }),
      { numRuns: 200 }
    )
  })

  it('cascadeFailure: every unhealthy node is transitively dependent on root', () => {
    const dag = buildProductionDAG()
    // Build transitive-dependents reachability set per BFS once.
    const transitiveDependents = (start) => {
      const seen = new Set([start])
      const queue = [start]
      while (queue.length) {
        const n = queue.shift()
        for (const dep of dag.dependentsOf(n)) {
          if (!seen.has(dep)) { seen.add(dep); queue.push(dep) }
        }
      }
      return seen
    }
    fc.assert(
      fc.property(fc.constantFrom(...NODES), (root) => {
        const state = cascadeFailure(dag, root)
        const expected = transitiveDependents(root)
        if (state.unhealthy.length !== expected.size) return false
        return state.unhealthy.every(n => expected.has(n))
      }),
      { numRuns: 100 }
    )
  })

  it('isHealReadyFor: never returns true for node with unhealed deps', () => {
    const dag = buildProductionDAG()
    fc.assert(
      fc.property(
        fc.subarray(NODES, { minLength: 0, maxLength: NODES.length }),
        fc.constantFrom(...NODES),
        (unhealthy, target) => {
          const ready = isHealReadyFor(target, dag, unhealthy)
          if (!ready) return true
          // ready=true means all deps healed (not in unhealthy)
          const deps = dag.depsOf(target)
          return deps.every(d => !unhealthy.includes(d))
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('HX1 — No premature retry invariant', () => {
  it('sender heal blocked while anti_trace still unhealthy', () => {
    const dag = buildProductionDAG()
    const unhealthy = ['anti_trace', 'relay', 'sender']
    expect(isHealReadyFor('sender', dag, unhealthy)).toBe(false)
  })

  it('full chain heal: each step waits for predecessor', () => {
    const dag = buildProductionDAG()
    let unhealthy = [...NODES]
    const healed = []
    while (unhealthy.length > 0) {
      const ready = unhealthy.filter(n => isHealReadyFor(n, dag, unhealthy))
      if (ready.length === 0) throw new Error('deadlock')
      // Heal one at a time — first ready
      const next = ready[0]
      healed.push(next)
      unhealthy = unhealthy.filter(n => n !== next)
    }
    // First healed should be anti_trace, last reporter
    expect(healed[0]).toBe('anti_trace')
    expect(healed[healed.length - 1]).toBe('reporter')
  })
})
