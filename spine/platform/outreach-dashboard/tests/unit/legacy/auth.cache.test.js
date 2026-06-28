import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest'
import * as authCache from '../../../authCache.js'

describe('authCache', () => {
  beforeEach(() => {
    authCache.clear()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('get returns null for unknown mailboxId', () => {
    expect(authCache.get(999)).toBeNull()
  })

  test('set + get round-trips addr', () => {
    authCache.set(42, '1.2.3.4:1080')
    expect(authCache.get(42)).toBe('1.2.3.4:1080')
  })

  test('get after TTL expiry returns null and evicts', () => {
    vi.useFakeTimers()
    authCache.set(7, '5.6.7.8:1080')
    expect(authCache.get(7)).toBe('5.6.7.8:1080')
    vi.advanceTimersByTime(authCache.TTL + 1)
    expect(authCache.get(7)).toBeNull()
    expect(authCache.size()).toBe(0)
  })

  test('invalidate removes entry', () => {
    authCache.set(10, '9.9.9.9:1080')
    authCache.invalidate(10)
    expect(authCache.get(10)).toBeNull()
  })

  test('invalidate on absent key is a no-op', () => {
    expect(() => authCache.invalidate(404)).not.toThrow()
  })

  test('set overwrites existing entry with fresh TTL', () => {
    vi.useFakeTimers()
    authCache.set(1, 'a:1080')
    vi.advanceTimersByTime(authCache.TTL / 2)
    authCache.set(1, 'b:1080')
    vi.advanceTimersByTime(authCache.TTL - 10)
    // Still fresh because second set reset the clock.
    expect(authCache.get(1)).toBe('b:1080')
  })

  test('LRU eviction drops oldest when size exceeds MAX', () => {
    for (let i = 0; i < authCache.MAX + 3; i++) authCache.set(i, `${i}:1080`)
    expect(authCache.size()).toBe(authCache.MAX)
    // First 3 should be evicted.
    expect(authCache.get(0)).toBeNull()
    expect(authCache.get(1)).toBeNull()
    expect(authCache.get(2)).toBeNull()
    // Most recent survives.
    expect(authCache.get(authCache.MAX + 2)).toBe(`${authCache.MAX + 2}:1080`)
  })

  test('get bumps LRU order — hot entry survives size-cap eviction', () => {
    for (let i = 0; i < authCache.MAX; i++) authCache.set(i, `${i}:1080`)
    // Touch id=0 — should move to end of insertion order.
    authCache.get(0)
    // Overflow cache by one — oldest (which is now id=1, since 0 got bumped) evicted.
    authCache.set(9999, '9999:1080')
    expect(authCache.get(0)).toBe('0:1080') // survived
    expect(authCache.get(1)).toBeNull()     // evicted
  })

  test('size reflects live entries only', () => {
    vi.useFakeTimers()
    authCache.set(1, 'a:1080')
    authCache.set(2, 'b:1080')
    expect(authCache.size()).toBe(2)
    vi.advanceTimersByTime(authCache.TTL + 1)
    // size counts raw map size until access triggers cleanup.
    authCache.get(1) // triggers lazy evict
    authCache.get(2) // triggers lazy evict
    expect(authCache.size()).toBe(0)
  })
})
