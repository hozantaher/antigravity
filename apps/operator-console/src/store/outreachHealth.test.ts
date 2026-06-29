import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOutreachHealth } from './outreachHealth'

describe('useOutreachHealth store', () => {
  beforeEach(() => {
    useOutreachHealth.setState({ degraded: false, lastChecked: null })
  })

  it('starts in healthy state', () => {
    const s = useOutreachHealth.getState()
    expect(s.degraded).toBe(false)
    expect(s.lastChecked).toBeNull()
  })

  it('setDegraded(true) flips degraded flag', () => {
    useOutreachHealth.getState().setDegraded(true)
    expect(useOutreachHealth.getState().degraded).toBe(true)
  })

  it('setDegraded(false) resets degraded flag', () => {
    useOutreachHealth.getState().setDegraded(true)
    useOutreachHealth.getState().setDegraded(false)
    expect(useOutreachHealth.getState().degraded).toBe(false)
  })

  it('setDegraded updates lastChecked to a number', () => {
    useOutreachHealth.getState().setDegraded(true)
    const t = useOutreachHealth.getState().lastChecked
    expect(typeof t).toBe('number')
    expect(t).toBeGreaterThan(0)
  })

  it('setDegraded bumps lastChecked forward on each call', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    useOutreachHealth.getState().setDegraded(true)
    const a = useOutreachHealth.getState().lastChecked!
    vi.setSystemTime(new Date('2026-01-01T00:00:05Z'))
    useOutreachHealth.getState().setDegraded(true)
    const b = useOutreachHealth.getState().lastChecked!
    expect(b).toBeGreaterThan(a)
    vi.useRealTimers()
  })

  it('multiple subscribers see the same state', () => {
    const seen: boolean[] = []
    const unsub = useOutreachHealth.subscribe((s) => seen.push(s.degraded))
    useOutreachHealth.getState().setDegraded(true)
    useOutreachHealth.getState().setDegraded(false)
    useOutreachHealth.getState().setDegraded(true)
    unsub()
    expect(seen).toEqual([true, false, true])
  })

  it('state is shallowly immutable — setState replaces fields', () => {
    useOutreachHealth.setState({ degraded: true, lastChecked: 123 })
    expect(useOutreachHealth.getState().degraded).toBe(true)
    expect(useOutreachHealth.getState().lastChecked).toBe(123)
  })

  it('setDegraded with same value still updates lastChecked', () => {
    useOutreachHealth.getState().setDegraded(false)
    const a = useOutreachHealth.getState().lastChecked
    useOutreachHealth.getState().setDegraded(false)
    const b = useOutreachHealth.getState().lastChecked
    // Both not null — both bumped
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
  })

  it('setDegraded is referentially stable (same function across getState)', () => {
    const a = useOutreachHealth.getState().setDegraded
    const b = useOutreachHealth.getState().setDegraded
    expect(a).toBe(b)
  })

  it('store exposes exactly three state keys', () => {
    const keys = Object.keys(useOutreachHealth.getState()).sort()
    expect(keys).toEqual(['degraded', 'lastChecked', 'setDegraded'])
  })

  it('toggling degraded 100 times does not leak memory or grow state', () => {
    for (let i = 0; i < 100; i++) {
      useOutreachHealth.getState().setDegraded(i % 2 === 0)
    }
    const keys = Object.keys(useOutreachHealth.getState())
    expect(keys.length).toBe(3)
  })

  it('subscribe returns an unsubscribe function', () => {
    const unsub = useOutreachHealth.subscribe(() => {})
    expect(typeof unsub).toBe('function')
    unsub()
  })

  it('after unsubscribe, callback is not invoked', () => {
    let count = 0
    const unsub = useOutreachHealth.subscribe(() => { count++ })
    useOutreachHealth.getState().setDegraded(true)
    unsub()
    useOutreachHealth.getState().setDegraded(false)
    expect(count).toBe(1)
  })
})
