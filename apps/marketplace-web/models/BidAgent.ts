// Proxy ("Bid Agent" / max) bidding — the eBay / OPENLANE pattern: a bidder arms a secret maximum and
// the system bids the minimum increment needed to keep them in the lead, never above their max. Pure
// and DB-free so the equilibrium is unit-tested in isolation; the repo wires it into placeBid.
//
// This system uses a FIXED per-item increment (item.minBid), not a price-tiered table, so the standing
// price rises in whole `increment` steps. Resolution is second-price-like: the leader pays one
// increment over the runner-up's ceiling (capped at the leader's own max), earliest-armed wins a tie,
// and the standing amount never drops.

export interface ActiveAgent {
  userId: string
  maxAmount: number
  at: number // epoch ms; earliest wins on a max tie
}

// The standing bid before resolution. leaderId absent = opening price, no bids yet.
export interface ProxyState {
  amount: number
  leaderId?: string
}

export interface ProxyResolution {
  leaderId: string
  amount: number
  changed: boolean // standing leader or amount moved
}

// The minimum legal next bid: one increment over the current standing amount (mirrors bidError).
export const minLegalNextBid = (currentAmount: number, increment: number): number => currentAmount + increment

// A max only counts if it can make a legal bid over the current standing amount (the leader is exempt —
// they already hold currentAmount). Used both to validate arming and to drop exhausted maxes whose
// ceiling the rising price has overtaken.
export const canArmAgent = (maxAmount: number, currentAmount: number, increment: number): boolean =>
  maxAmount >= minLegalNextBid(currentAmount, increment)

// Raise-only: once armed (and possibly contested) a max can be increased but never lowered or removed,
// matching IAAI/Catawiki. An equal value is rejected too (nothing to do).
export const isAgentRaise = (prevMax: number, nextMax: number): boolean => nextMax > prevMax

// Resolve the standing bid given the current state, the full set of active maxes (one per user,
// including the current leader if they bid via an agent), and the fixed increment. Returns the new
// leader + the price they stand at. Never lowers the standing amount.
export const resolveProxy = (state: ProxyState, agents: readonly ActiveAgent[], increment: number): ProxyResolution => {
  const floor = state.amount
  const incumbentId = state.leaderId

  // Incumbent ceiling: their armed max if any, else the price they already hold.
  const incumbentAgent = incumbentId ? agents.find(a => a.userId === incumbentId) : undefined
  const incumbentCeiling = incumbentId ? Math.max(floor, incumbentAgent?.maxAmount ?? 0) : floor

  // Participants: the incumbent (priority on ties via -Infinity) plus every other agent whose max can
  // still legally take the lead. An agent armed when the price was lower, now overtaken, is exhausted.
  const participants: { userId: string; ceiling: number; at: number }[] = []
  if (incumbentId) participants.push({ userId: incumbentId, ceiling: incumbentCeiling, at: -Infinity })
  for (const a of agents) {
    if (a.userId === incumbentId) continue
    if (!canArmAgent(a.maxAmount, floor, increment)) continue
    participants.push({ userId: a.userId, ceiling: a.maxAmount, at: a.at })
  }

  if (participants.length === 0) {
    return { leaderId: incumbentId ?? '', amount: floor, changed: false }
  }

  participants.sort((x, y) => y.ceiling - x.ceiling || x.at - y.at)
  const top = participants[0]!
  const runnerUp = participants[1]

  let amount: number
  if (runnerUp) {
    // Pay one increment over the runner-up's ceiling, capped at the winner's max, never below the floor.
    amount = Math.min(top.ceiling, Math.max(runnerUp.ceiling + increment, floor))
  } else if (top.userId === incumbentId) {
    // Unchallenged incumbent (all rivals exhausted) holds the standing price — no self-raise.
    amount = floor
  } else {
    // A fresh leader (opening price, or overtaking with no other live rival) posts the minimum legal bid.
    amount = Math.min(top.ceiling, floor + increment)
  }

  const changed = top.userId !== incumbentId || amount !== floor
  return { leaderId: top.userId, amount, changed }
}
