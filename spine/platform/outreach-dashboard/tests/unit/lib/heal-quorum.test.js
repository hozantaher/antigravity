// HXX6 — Distributed quorum for destructive heal actions.
// Pure-JS simulation of N-of-M supervisor voting (Raft-lite).
// Real production would use pg advisory_xact_lock + heal_quorum_votes table.

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  HealQuorum,
  hasQuorum,
  PROPOSAL_OUTCOMES,
} from '../../../src/lib/heal-quorum.js'

describe('HXX6 — hasQuorum primitive', () => {
  it('3 of 3 votes → quorum', () => {
    expect(hasQuorum(3, 3)).toBe(true)
  })

  it('2 of 3 votes → quorum (majority)', () => {
    expect(hasQuorum(2, 3)).toBe(true)
  })

  it('1 of 3 votes → no quorum', () => {
    expect(hasQuorum(1, 3)).toBe(false)
  })

  it('2 of 4 votes → no quorum (split-brain)', () => {
    expect(hasQuorum(2, 4)).toBe(false)
  })

  it('3 of 4 votes → quorum', () => {
    expect(hasQuorum(3, 4)).toBe(true)
  })

  it('1 of 1 votes → quorum (single node)', () => {
    expect(hasQuorum(1, 1)).toBe(true)
  })

  it('0 of any → no quorum', () => {
    expect(hasQuorum(0, 3)).toBe(false)
  })
})

describe('HXX6 — HealQuorum proposals', () => {
  it('2 supervisors of 3 vote yes → proposal accepted', () => {
    const q = new HealQuorum({ replicas: 3 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    q.vote(proposal.id, 'r1', 'yes')
    q.vote(proposal.id, 'r2', 'yes')
    const r = q.tally(proposal.id)
    expect(r.outcome).toBe(PROPOSAL_OUTCOMES.ACCEPTED)
  })

  it('1 yes + 2 no → proposal rejected', () => {
    const q = new HealQuorum({ replicas: 3 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    q.vote(proposal.id, 'r1', 'yes')
    q.vote(proposal.id, 'r2', 'no')
    q.vote(proposal.id, 'r3', 'no')
    const r = q.tally(proposal.id)
    expect(r.outcome).toBe(PROPOSAL_OUTCOMES.REJECTED)
  })

  it('1 yes only → pending (insufficient votes)', () => {
    const q = new HealQuorum({ replicas: 3 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    q.vote(proposal.id, 'r1', 'yes')
    const r = q.tally(proposal.id)
    expect(r.outcome).toBe(PROPOSAL_OUTCOMES.PENDING)
  })

  it('2 yes + 2 no on 4-replica → no quorum (split-brain)', () => {
    const q = new HealQuorum({ replicas: 4 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    q.vote(proposal.id, 'r1', 'yes')
    q.vote(proposal.id, 'r2', 'yes')
    q.vote(proposal.id, 'r3', 'no')
    q.vote(proposal.id, 'r4', 'no')
    const r = q.tally(proposal.id)
    expect(r.outcome).toBe(PROPOSAL_OUTCOMES.SPLIT)
  })

  it('duplicate vote from same replica is idempotent', () => {
    const q = new HealQuorum({ replicas: 3 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    q.vote(proposal.id, 'r1', 'yes')
    q.vote(proposal.id, 'r1', 'yes') // duplicate
    expect(q.tally(proposal.id).votes_yes).toBe(1)
  })

  it('vote change from same replica is honored (last-write-wins within window)', () => {
    const q = new HealQuorum({ replicas: 3 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    q.vote(proposal.id, 'r1', 'no')
    q.vote(proposal.id, 'r1', 'yes')
    const t = q.tally(proposal.id)
    expect(t.votes_yes).toBe(1)
    expect(t.votes_no).toBe(0)
  })

  it('proposal not found → throws', () => {
    const q = new HealQuorum({ replicas: 3 })
    expect(() => q.vote('nonexistent', 'r1', 'yes')).toThrow(/not found/i)
  })

  it('unknown vote value rejected', () => {
    const q = new HealQuorum({ replicas: 3 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    expect(() => q.vote(proposal.id, 'r1', 'maybe')).toThrow(/yes.*no/i)
  })
})

describe('HXX6 — Idempotency across replicas', () => {
  it('same proposal proposed twice (different proposers) → second returns existing', () => {
    const q = new HealQuorum({ replicas: 3 })
    const p1 = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    const p2 = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r2' })
    expect(p2.id).toBe(p1.id)
  })

  it('different actions on same entity create distinct proposals', () => {
    const q = new HealQuorum({ replicas: 3 })
    const p1 = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    const p2 = q.propose({ action: 'pause_campaign', entity_id: 5, proposer: 'r1' })
    expect(p2.id).not.toBe(p1.id)
  })

  it('different entities create distinct proposals', () => {
    const q = new HealQuorum({ replicas: 3 })
    const p1 = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    const p2 = q.propose({ action: 'drop_mailbox', entity_id: 7, proposer: 'r1' })
    expect(p2.id).not.toBe(p1.id)
  })
})

describe('HXX6 — Storm scenario', () => {
  it('100 concurrent votes converge to single outcome', () => {
    const q = new HealQuorum({ replicas: 5 })
    const proposal = q.propose({ action: 'drop_mailbox', entity_id: 5, proposer: 'r1' })
    // 5 replicas vote yes (3 needed for quorum); 100 retry attempts each
    for (let i = 0; i < 100; i++) {
      const replica = `r${(i % 5) + 1}`
      q.vote(proposal.id, replica, 'yes')
    }
    const t = q.tally(proposal.id)
    expect(t.votes_yes).toBe(5) // exactly 5 distinct replicas
    expect(t.outcome).toBe(PROPOSAL_OUTCOMES.ACCEPTED)
  })
})

describe('HXX6 — Properties', () => {
  it('property: outcome consistent regardless of vote ORDER (unique replicas)', () => {
    // When each replica votes exactly once, vote order doesn't matter.
    // Last-write-wins applies when same replica votes twice — that is a
    // separate scenario covered by "vote change from same replica".
    fc.assert(
      fc.property(
        fc.subarray(['r1', 'r2', 'r3'], { minLength: 1, maxLength: 3 }).chain(replicas =>
          fc.tuple(fc.constant(replicas), fc.array(fc.constantFrom('yes', 'no'),
            { minLength: replicas.length, maxLength: replicas.length }))
        ),
        ([replicas, values]) => {
          const votes = replicas.map((r, i) => [r, values[i]])
          const q1 = new HealQuorum({ replicas: 3 })
          const q2 = new HealQuorum({ replicas: 3 })
          const p1 = q1.propose({ action: 'X', entity_id: 1, proposer: 'r1' })
          const p2 = q2.propose({ action: 'X', entity_id: 1, proposer: 'r1' })
          for (const [r, v] of votes) q1.vote(p1.id, r, v)
          for (const [r, v] of [...votes].reverse()) q2.vote(p2.id, r, v)
          return q1.tally(p1.id).outcome === q2.tally(p2.id).outcome
        }
      ),
      { numRuns: 100 }
    )
  })

  it('property: split-brain only possible with even replica count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (replicas) => {
          // For odd replica count, no even split possible.
          // For even replica count with strict majority requirement, split is possible.
          if (replicas % 2 === 1) {
            const halfYes = Math.floor(replicas / 2)
            // halfYes + (replicas - halfYes) = replicas; majority is halfYes+1
            return !hasQuorum(halfYes, replicas) || replicas === 1
          }
          return true
        }
      ),
      { numRuns: 50 }
    )
  })

  it('property: quorum threshold = floor(N/2) + 1', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
        const threshold = Math.floor(n / 2) + 1
        return hasQuorum(threshold, n) === true && hasQuorum(threshold - 1, n) === false
      }),
      { numRuns: 100 }
    )
  })
})

describe('HXX6 — Defensive', () => {
  it('replicas must be ≥1', () => {
    expect(() => new HealQuorum({ replicas: 0 })).toThrow()
    expect(() => new HealQuorum({ replicas: -1 })).toThrow()
  })

  it('handles missing options', () => {
    expect(() => new HealQuorum()).toThrow()
  })

  it('empty propose params throws', () => {
    const q = new HealQuorum({ replicas: 3 })
    expect(() => q.propose({})).toThrow()
  })
})
