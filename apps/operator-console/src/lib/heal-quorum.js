// HXX6 — Distributed quorum for destructive heal actions.
// Pure-JS simulation of N-of-M voting (Raft-lite). Production wires this
// over pg_advisory_xact_lock + heal_quorum_votes table.

export const PROPOSAL_OUTCOMES = Object.freeze({
  PENDING:  'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  SPLIT:    'split',
})

export function hasQuorum(votes_yes, replicas) {
  if (replicas < 1) return false
  return votes_yes >= Math.floor(replicas / 2) + 1
}

function proposalKey({ action, entity_id }) {
  return `${action}:${entity_id}`
}

export class HealQuorum {
  constructor(opts) {
    if (!opts || typeof opts.replicas !== 'number' || opts.replicas < 1) {
      throw new Error('HealQuorum: replicas must be >= 1')
    }
    this.replicas = opts.replicas
    this._proposals = new Map() // proposalKey → { id, action, entity_id, votes }
  }

  propose({ action, entity_id, proposer }) {
    if (!action || entity_id == null || !proposer) {
      throw new Error('HealQuorum.propose: action, entity_id, proposer required')
    }
    const key = proposalKey({ action, entity_id })
    let p = this._proposals.get(key)
    if (!p) {
      p = {
        id: `prop_${key}_${this._proposals.size}`,
        action, entity_id, proposer,
        votes: new Map(),  // replicaId → 'yes' | 'no'
      }
      this._proposals.set(key, p)
    }
    return p
  }

  _findProposalById(id) {
    for (const p of this._proposals.values()) {
      if (p.id === id) return p
    }
    return null
  }

  vote(proposalId, replicaId, value) {
    if (value !== 'yes' && value !== 'no') {
      throw new Error('HealQuorum.vote: value must be "yes" or "no"')
    }
    const p = this._findProposalById(proposalId)
    if (!p) throw new Error(`HealQuorum.vote: proposal ${proposalId} not found`)
    p.votes.set(replicaId, value)
  }

  tally(proposalId) {
    const p = this._findProposalById(proposalId)
    if (!p) throw new Error(`HealQuorum.tally: proposal ${proposalId} not found`)
    let yes = 0, no = 0
    for (const v of p.votes.values()) {
      if (v === 'yes') yes++
      else if (v === 'no') no++
    }
    const totalVoted = yes + no
    if (totalVoted < this.replicas) {
      // Not all replicas voted; either pending or already decided.
      if (hasQuorum(yes, this.replicas)) {
        return { outcome: PROPOSAL_OUTCOMES.ACCEPTED, votes_yes: yes, votes_no: no }
      }
      if (hasQuorum(no, this.replicas)) {
        return { outcome: PROPOSAL_OUTCOMES.REJECTED, votes_yes: yes, votes_no: no }
      }
      return { outcome: PROPOSAL_OUTCOMES.PENDING, votes_yes: yes, votes_no: no }
    }
    // All voted. Check for split-brain (no majority either way).
    if (hasQuorum(yes, this.replicas)) {
      return { outcome: PROPOSAL_OUTCOMES.ACCEPTED, votes_yes: yes, votes_no: no }
    }
    if (hasQuorum(no, this.replicas)) {
      return { outcome: PROPOSAL_OUTCOMES.REJECTED, votes_yes: yes, votes_no: no }
    }
    return { outcome: PROPOSAL_OUTCOMES.SPLIT, votes_yes: yes, votes_no: no }
  }
}
