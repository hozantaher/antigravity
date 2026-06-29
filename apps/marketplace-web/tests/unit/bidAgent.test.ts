import { describe, it, expect } from 'vitest'
import { minLegalNextBid, canArmAgent, isAgentRaise, resolveProxy, type ActiveAgent } from '~/models'

const INC = 500
const agent = (userId: string, maxAmount: number, at = 0): ActiveAgent => ({ userId, maxAmount, at })

describe('minLegalNextBid', () => {
  it('is one increment over the current standing amount', () => {
    expect(minLegalNextBid(5000, INC)).toBe(5500)
  })
})

describe('canArmAgent', () => {
  it('accepts a max at exactly the minimum legal next bid', () => {
    expect(canArmAgent(5500, 5000, INC)).toBe(true)
  })

  it('rejects a max below the minimum legal next bid', () => {
    expect(canArmAgent(5400, 5000, INC)).toBe(false)
    expect(canArmAgent(5000, 5000, INC)).toBe(false)
  })
})

describe('isAgentRaise', () => {
  it('allows raising the max', () => {
    expect(isAgentRaise(5000, 6000)).toBe(true)
  })

  it('rejects lowering or keeping the max (raise-only)', () => {
    expect(isAgentRaise(6000, 5000)).toBe(false)
    expect(isAgentRaise(6000, 6000)).toBe(false)
  })
})

describe('resolveProxy', () => {
  it('a lone agent on the opening price leads at floor + one increment, not their max', () => {
    const r = resolveProxy({ amount: 5000 }, [agent('a', 9000)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 5500, changed: true })
  })

  it('a lone agent whose max equals the minimum bid leads at that max', () => {
    const r = resolveProxy({ amount: 5000 }, [agent('a', 5500)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 5500, changed: true })
  })

  it('between two fresh agents the higher max wins, paying one increment over the runner-up max', () => {
    const r = resolveProxy({ amount: 5000 }, [agent('a', 9000, 1), agent('b', 8000, 2)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 8500, changed: true })
  })

  it('caps the winning price at the leader own max when the runner-up max is within one increment', () => {
    const r = resolveProxy({ amount: 5000 }, [agent('a', 10000, 1), agent('b', 9800, 2)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 10000, changed: true })
  })

  it('auto-raises the incumbent (with a higher armed max) when a challenger pushes', () => {
    // a leads at 5000 with a 12000 max; b arms 8000 → a is pushed to 8500, still leading.
    const r = resolveProxy({ amount: 5000, leaderId: 'a' }, [agent('a', 12000, 1), agent('b', 8000, 2)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 8500, changed: true })
  })

  it('lets a challenger overtake an incumbent who has no armed max (manual bid)', () => {
    const r = resolveProxy({ amount: 5000, leaderId: 'a' }, [agent('b', 9000, 2)], INC)
    expect(r).toEqual({ leaderId: 'b', amount: 5500, changed: true })
  })

  it('leaves the incumbent untouched when a challenger max cannot beat the standing price', () => {
    // a holds 5000 (manual); b arms 5000 which is below the 5500 minimum → exhausted, no change.
    const r = resolveProxy({ amount: 5000, leaderId: 'a' }, [agent('b', 5000, 2)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 5000, changed: false })
  })

  it('ignores an exhausted agent whose max the risen price has overtaken', () => {
    // price is now 6500; an old 6000 max can no longer make a legal (>=7000) bid.
    const r = resolveProxy({ amount: 6500, leaderId: 'a' }, [agent('b', 6000, 2)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 6500, changed: false })
  })

  it('resolves a max tie in favour of the earliest-armed agent, at that max', () => {
    const r = resolveProxy({ amount: 5000 }, [agent('a', 9000, 1), agent('b', 9000, 2)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 9000, changed: true })
  })

  it('keeps the incumbent on a tie with a later challenger (earliest priority)', () => {
    const r = resolveProxy({ amount: 5000, leaderId: 'a' }, [agent('a', 9000, 1), agent('b', 9000, 2)], INC)
    expect(r).toEqual({ leaderId: 'a', amount: 9000, changed: true })
  })

  it('never lowers the standing amount', () => {
    const r = resolveProxy({ amount: 8000, leaderId: 'a' }, [agent('a', 12000, 1), agent('b', 6000, 2)], INC)
    // b is exhausted (6000 < 8500), a holds 8000 — must not drop.
    expect(r.amount).toBeGreaterThanOrEqual(8000)
    expect(r).toEqual({ leaderId: 'a', amount: 8000, changed: false })
  })

  it('picks the strongest of three challengers, pricing one increment over the second-strongest', () => {
    const r = resolveProxy({ amount: 5000, leaderId: 'a' }, [agent('b', 9000, 2), agent('c', 7000, 3)], INC)
    expect(r).toEqual({ leaderId: 'b', amount: 7500, changed: true })
  })
})
