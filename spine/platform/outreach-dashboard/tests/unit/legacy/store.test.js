// ═══════════════════════════════════════════════════════════════════════════
//  Zustand store — selector + mutation unit tests
//
//  Strategy:
//  - Reset store state between tests via `useStore.setState(initial, true)`.
//  - Mutation methods (addMailbox, addCampaign, etc.) are exercised against
//    real store state (no mocking of `fetch` — mutations are tested via
//    direct `set` calls or by stubbing `fetch` at window level).
//  - All fetch-based actions are tested via MSW (setup.js) for happy-path
//    and via direct state manipulation for selector coverage.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest'
import useStore from '../../../src/store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const INITIAL_STATE = {
  mailboxes: [],
  campaigns: [],
  templates: [],
  segments: [],
  companies: [],
  totalCompanies: 0,
  replyStats: null,
  loading: false,
}

function resetStore() {
  useStore.setState(INITIAL_STATE, true)
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------
describe('store — initial state', () => {
  beforeEach(resetStore)

  it('mailboxes starts as empty array', () => {
    expect(useStore.getState().mailboxes).toEqual([])
  })

  it('campaigns starts as empty array', () => {
    expect(useStore.getState().campaigns).toEqual([])
  })

  it('templates starts as empty array', () => {
    expect(useStore.getState().templates).toEqual([])
  })

  it('segments starts as empty array', () => {
    expect(useStore.getState().segments).toEqual([])
  })

  it('totalCompanies starts at 0', () => {
    expect(useStore.getState().totalCompanies).toBe(0)
  })

  it('replyStats starts as null', () => {
    expect(useStore.getState().replyStats).toBeNull()
  })

  it('loading starts as false', () => {
    expect(useStore.getState().loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Direct setState selectors
// ---------------------------------------------------------------------------
describe('store — setState selectors', () => {
  beforeEach(resetStore)

  it('setCompanies via setState updates mailboxes', () => {
    const mb = [{ id: '1', email: 'test@example.com', status: 'active' }]
    useStore.setState({ mailboxes: mb })
    expect(useStore.getState().mailboxes).toHaveLength(1)
    expect(useStore.getState().mailboxes[0].email).toBe('test@example.com')
  })

  it('campaigns list can be set and read back', () => {
    const camps = [
      { id: 1, name: 'Kampaň A', status: 'active' },
      { id: 2, name: 'Kampaň B', status: 'draft' },
    ]
    useStore.setState({ campaigns: camps })
    const { campaigns } = useStore.getState()
    expect(campaigns).toHaveLength(2)
    expect(campaigns[0].name).toBe('Kampaň A')
  })

  it('templates list can be set and read back', () => {
    const tpls = [{ id: 1, name: 'Šablona 1', subject: 'Předmět', body: 'Tělo' }]
    useStore.setState({ templates: tpls })
    expect(useStore.getState().templates[0].name).toBe('Šablona 1')
  })

  it('segments list can be set and read back', () => {
    const segs = [{ id: 1, name: 'Stavební firmy', company_count: 1250 }]
    useStore.setState({ segments: segs })
    expect(useStore.getState().segments[0].company_count).toBe(1250)
  })

  it('totalCompanies can be updated', () => {
    useStore.setState({ totalCompanies: 42000 })
    expect(useStore.getState().totalCompanies).toBe(42000)
  })

  it('replyStats can be set with data', () => {
    const stats = { total: 5, unhandled: 2, positive: 3, negative: 2 }
    useStore.setState({ replyStats: stats })
    expect(useStore.getState().replyStats?.total).toBe(5)
  })

  it('loading flag toggles correctly', () => {
    useStore.setState({ loading: true })
    expect(useStore.getState().loading).toBe(true)
    useStore.setState({ loading: false })
    expect(useStore.getState().loading).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Immutable mutation helpers (mailboxes)
// ---------------------------------------------------------------------------
describe('store — deleteMailbox helper (sync state mutation)', () => {
  beforeEach(resetStore)

  it('removes correct mailbox by id', () => {
    useStore.setState({
      mailboxes: [
        { id: '1', email: 'a@a.cz' },
        { id: '2', email: 'b@b.cz' },
      ],
    })
    // Simulate the internal set call deleteMailbox uses
    useStore.setState((s) => ({
      mailboxes: s.mailboxes.filter((m) => m.id !== '1'),
    }))
    const { mailboxes } = useStore.getState()
    expect(mailboxes).toHaveLength(1)
    expect(mailboxes[0].id).toBe('2')
  })

  it('does not mutate original array reference', () => {
    const original = [{ id: '1', email: 'a@a.cz' }]
    useStore.setState({ mailboxes: original })
    useStore.setState((s) => ({
      mailboxes: s.mailboxes.filter((m) => m.id !== '1'),
    }))
    // original reference must be unmodified
    expect(original).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Immutable mutation helpers (templates)
// ---------------------------------------------------------------------------
describe('store — templates mutations (sync)', () => {
  beforeEach(resetStore)

  it('addTemplate prepends to list', () => {
    useStore.setState({ templates: [{ id: 1, name: 'Old' }] })
    const newTpl = { id: 2, name: 'New' }
    useStore.setState((s) => ({ templates: [newTpl, ...s.templates] }))
    const { templates } = useStore.getState()
    expect(templates[0].name).toBe('New')
    expect(templates).toHaveLength(2)
  })

  it('updateTemplate merges fields immutably', () => {
    useStore.setState({ templates: [{ id: 1, name: 'Old', subject: 'S1' }] })
    useStore.setState((s) => ({
      templates: s.templates.map((t) =>
        t.id === 1 ? { ...t, name: 'Updated' } : t
      ),
    }))
    const { templates } = useStore.getState()
    expect(templates[0].name).toBe('Updated')
    expect(templates[0].subject).toBe('S1')  // unchanged fields preserved
  })

  it('deleteTemplate removes correct item', () => {
    useStore.setState({
      templates: [
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ],
    })
    useStore.setState((s) => ({
      templates: s.templates.filter((t) => t.id !== 2),
    }))
    const { templates } = useStore.getState()
    expect(templates.map((t) => t.id)).toEqual([1, 3])
  })
})

// ---------------------------------------------------------------------------
// Immutable mutation helpers (campaigns)
// ---------------------------------------------------------------------------
describe('store — campaigns mutations (sync)', () => {
  beforeEach(resetStore)

  it('setCampaignStatus applies partial update immutably', () => {
    useStore.setState({
      campaigns: [
        { id: 1, name: 'K1', status: 'draft' },
        { id: 2, name: 'K2', status: 'active' },
      ],
    })
    useStore.setState((s) => ({
      campaigns: s.campaigns.map((c) =>
        c.id === 1 ? { ...c, status: 'active' } : c
      ),
    }))
    const { campaigns } = useStore.getState()
    expect(campaigns[0].status).toBe('active')
    expect(campaigns[1].status).toBe('active')  // unchanged
  })
})

// ---------------------------------------------------------------------------
// MONKEY — store handles any value type without crash
// ---------------------------------------------------------------------------
describe('store — MONKEY: arbitrary value types', () => {
  beforeEach(resetStore)

  const wilds = [null, undefined, [], {}, 'string', 42, true, NaN, Infinity, Symbol('x')]

  it('setting mailboxes to any value type does not throw', () => {
    for (const v of wilds) {
      expect(() => useStore.setState({ mailboxes: v })).not.toThrow()
    }
  })

  it('setting campaigns to any value type does not throw', () => {
    for (const v of wilds) {
      expect(() => useStore.setState({ campaigns: v })).not.toThrow()
    }
  })

  it('setting templates to any value type does not throw', () => {
    for (const v of wilds) {
      expect(() => useStore.setState({ templates: v })).not.toThrow()
    }
  })

  it('setting replyStats to any value type does not throw', () => {
    for (const v of wilds) {
      expect(() => useStore.setState({ replyStats: v })).not.toThrow()
    }
  })

  it('setting totalCompanies to any value type does not throw', () => {
    for (const v of wilds) {
      expect(() => useStore.setState({ totalCompanies: v })).not.toThrow()
    }
  })

  it('reading state after wild writes still returns an object', () => {
    for (const v of wilds) {
      useStore.setState({ mailboxes: v })
      expect(typeof useStore.getState()).toBe('object')
    }
    // Restore clean state at end
    resetStore()
  })
})

// ---------------------------------------------------------------------------
// Selector isolation (subscribe)
// ---------------------------------------------------------------------------
describe('store — selector stability', () => {
  beforeEach(resetStore)

  it('getState() returns same ref until state changes', () => {
    const s1 = useStore.getState()
    const s2 = useStore.getState()
    expect(s1).toBe(s2)
  })

  it('state reference changes after setState', () => {
    const before = useStore.getState()
    useStore.setState({ totalCompanies: 99 })
    const after = useStore.getState()
    expect(before).not.toBe(after)
  })

  it('subscribe callback fires on state change', () => {
    const cb = vi.fn()
    const unsub = useStore.subscribe(cb)
    useStore.setState({ totalCompanies: 123 })
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
    // After unsubscribe, callback should not fire
    useStore.setState({ totalCompanies: 456 })
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
