// HXX1 — Root-cause attribution (multi-hop trace).
// Given a fault signal at any node + the dependency DAG, locate the TRUE root
// cause. Naive heal targets the leaf where the symptom appears (mailbox dark);
// sophisticated heal traces upward to the highest-cost upstream signal that
// could cascade into the symptom.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { buildDependencyDAG } from '../../../src/lib/heal-cascade.js'
import {
  attributeRootCause,
  rankCandidates,
  scoreNode,
} from '../../../src/lib/heal-rootcause.js'

function buildProductionDAG() {
  return buildDependencyDAG([
    ['relay',     'anti_trace'],
    ['sender',    'relay'],
    ['bff_cron',  'sender'],
    ['reporter',  'bff_cron'],
  ])
}

const ALL_HEALTHY = {
  anti_trace: { healthy: true, last_signal: null },
  relay:      { healthy: true, last_signal: null },
  sender:     { healthy: true, last_signal: null },
  bff_cron:   { healthy: true, last_signal: null },
  reporter:   { healthy: true, last_signal: null },
}

describe('HXX1 — scoreNode', () => {
  it('healthy node scores 0', () => {
    expect(scoreNode({ healthy: true })).toBe(0)
  })

  it('unhealthy with high-confidence signal scores high', () => {
    expect(scoreNode({ healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } }))
      .toBeGreaterThan(0)
  })

  it('older signal scores lower (decay)', () => {
    const recent = scoreNode({ healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } })
    const old    = scoreNode({ healthy: false, last_signal: { severity: 'critical', age_ms: 60 * 60 * 1000 } })
    expect(recent).toBeGreaterThan(old)
  })

  it('higher severity scores higher', () => {
    const warn = scoreNode({ healthy: false, last_signal: { severity: 'warn', age_ms: 1000 } })
    const crit = scoreNode({ healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } })
    expect(crit).toBeGreaterThan(warn)
  })

  it('null signal on unhealthy node scores low (uncertainty)', () => {
    expect(scoreNode({ healthy: false, last_signal: null })).toBe(1)
  })
})

describe('HXX1 — attributeRootCause: single-fault scenarios', () => {
  it('all healthy → returns null (no root)', () => {
    const dag = buildProductionDAG()
    expect(attributeRootCause(dag, ALL_HEALTHY, 'reporter')).toBeNull()
  })

  it('only reporter unhealthy → root = reporter', () => {
    const dag = buildProductionDAG()
    const states = {
      ...ALL_HEALTHY,
      reporter: { healthy: false, last_signal: { severity: 'warn', age_ms: 1000 } },
    }
    expect(attributeRootCause(dag, states, 'reporter')?.node).toBe('reporter')
  })

  it('symptom at reporter, only anti_trace shows fault → root = anti_trace', () => {
    const dag = buildProductionDAG()
    const states = {
      ...ALL_HEALTHY,
      anti_trace: { healthy: false, last_signal: { severity: 'critical', age_ms: 5000 } },
      reporter:   { healthy: false, last_signal: null },
    }
    expect(attributeRootCause(dag, states, 'reporter')?.node).toBe('anti_trace')
  })

  it('multi-hop trace: cascade from anti_trace → reporter symptom; identifies root', () => {
    const dag = buildProductionDAG()
    const states = {
      anti_trace: { healthy: false, last_signal: { severity: 'critical', age_ms: 30000 } },
      relay:      { healthy: false, last_signal: { severity: 'critical', age_ms: 25000 } },
      sender:     { healthy: false, last_signal: { severity: 'warn',     age_ms: 20000 } },
      bff_cron:   { healthy: false, last_signal: { severity: 'warn',     age_ms: 15000 } },
      reporter:   { healthy: false, last_signal: null },
    }
    const r = attributeRootCause(dag, states, 'reporter')
    expect(r?.node).toBe('anti_trace')
  })
})

describe('HXX1 — rankCandidates', () => {
  it('returns candidates sorted by score desc', () => {
    const dag = buildProductionDAG()
    const states = {
      ...ALL_HEALTHY,
      anti_trace: { healthy: false, last_signal: { severity: 'critical', age_ms: 5000 } },
      relay:      { healthy: false, last_signal: { severity: 'warn',     age_ms: 5000 } },
      sender:     { healthy: false, last_signal: null },
    }
    const ranked = rankCandidates(dag, states, 'sender')
    // Highest-scoring upstream comes first
    expect(ranked[0].node).toBe('anti_trace')
    expect(ranked[ranked.length - 1].node).toBe('sender')
  })

  it('no candidates when symptom is healthy', () => {
    const dag = buildProductionDAG()
    expect(rankCandidates(dag, ALL_HEALTHY, 'reporter')).toEqual([])
  })

  it('returns only ancestors of symptom (not parallel branches)', () => {
    // For symptom='sender', candidates = sender, relay, anti_trace (NOT bff_cron, NOT reporter)
    const dag = buildProductionDAG()
    const states = {
      ...ALL_HEALTHY,
      anti_trace: { healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } },
      relay:      { healthy: false, last_signal: { severity: 'warn',     age_ms: 1000 } },
      sender:     { healthy: false, last_signal: null },
      bff_cron:   { healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } },
      reporter:   { healthy: false, last_signal: null },
    }
    const ranked = rankCandidates(dag, states, 'sender')
    const nodes = ranked.map(r => r.node)
    expect(nodes).not.toContain('bff_cron')
    expect(nodes).not.toContain('reporter')
    expect(nodes).toContain('sender')
    expect(nodes).toContain('relay')
    expect(nodes).toContain('anti_trace')
  })
})

describe('HXX1 — Heal target selection', () => {
  it('algorithm targets root, not symptom', () => {
    const dag = buildProductionDAG()
    const states = {
      anti_trace: { healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } },
      relay:      { healthy: false, last_signal: { severity: 'warn',     age_ms: 1000 } },
      sender:     { healthy: false, last_signal: null },
      bff_cron:   { healthy: false, last_signal: null },
      reporter:   { healthy: false, last_signal: null },
    }
    const r = attributeRootCause(dag, states, 'reporter')
    // anti_trace root, NOT reporter (where symptom appeared)
    expect(r.node).not.toBe('reporter')
    expect(r.node).toBe('anti_trace')
  })

  it('confidence reported with attribution', () => {
    const dag = buildProductionDAG()
    const states = {
      ...ALL_HEALTHY,
      anti_trace: { healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } },
      reporter:   { healthy: false, last_signal: null },
    }
    const r = attributeRootCause(dag, states, 'reporter')
    expect(r).toHaveProperty('confidence')
    expect(r.confidence).toBeGreaterThan(0)
    expect(r.confidence).toBeLessThanOrEqual(1)
  })

  it('reasoning trace included for explainability', () => {
    const dag = buildProductionDAG()
    const states = {
      ...ALL_HEALTHY,
      anti_trace: { healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } },
      reporter:   { healthy: false, last_signal: null },
    }
    const r = attributeRootCause(dag, states, 'reporter')
    expect(Array.isArray(r.trace)).toBe(true)
    expect(r.trace.length).toBeGreaterThanOrEqual(1)
  })
})

describe('HXX1 — Properties', () => {
  it('property: root is always an ancestor of symptom (or symptom itself)', () => {
    const dag = buildProductionDAG()
    fc.assert(
      fc.property(
        fc.constantFrom('reporter', 'bff_cron', 'sender', 'relay', 'anti_trace'),
        fc.array(fc.constantFrom('reporter', 'bff_cron', 'sender', 'relay', 'anti_trace'),
          { minLength: 1, maxLength: 5 }),
        (symptom, unhealthy) => {
          const states = {}
          for (const n of dag.nodes) {
            states[n] = unhealthy.includes(n)
              ? { healthy: false, last_signal: { severity: 'critical', age_ms: 1000 } }
              : { healthy: true, last_signal: null }
          }
          // Symptom must be unhealthy for attribution to make sense
          if (!states[symptom] || states[symptom].healthy) {
            states[symptom] = { healthy: false, last_signal: null }
          }
          const r = attributeRootCause(dag, states, symptom)
          if (!r) return true
          // r.node is symptom or upstream of symptom
          const isAncestor = (target, of_) => {
            if (target === of_) return true
            const queue = [...dag.depsOf(of_)]
            while (queue.length) {
              const n = queue.shift()
              if (n === target) return true
              queue.push(...dag.depsOf(n))
            }
            return false
          }
          return isAncestor(r.node, symptom)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('property: scoreNode is non-negative', () => {
    fc.assert(
      fc.property(fc.record({
        healthy: fc.boolean(),
        last_signal: fc.option(fc.record({
          severity: fc.constantFrom('warn', 'critical', 'info'),
          age_ms: fc.integer({ min: 0, max: 100_000_000 }),
        })),
      }), (state) => {
        return scoreNode(state) >= 0
      }),
      { numRuns: 200 }
    )
  })
})

describe('HXX1 — Defensive inputs', () => {
  it('handles missing node states', () => {
    const dag = buildProductionDAG()
    expect(() => attributeRootCause(dag, {}, 'reporter')).not.toThrow()
  })

  it('handles unknown symptom name', () => {
    const dag = buildProductionDAG()
    expect(() => attributeRootCause(dag, ALL_HEALTHY, 'nonexistent')).not.toThrow()
    expect(attributeRootCause(dag, ALL_HEALTHY, 'nonexistent')).toBeNull()
  })

  it('handles null DAG gracefully', () => {
    expect(() => attributeRootCause(null, ALL_HEALTHY, 'reporter')).toThrow()
  })
})
