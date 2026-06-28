// H6 — Auth cache TTL eviction + re-probe.
// Verifies the LRU+TTL cache at features/platform/outreach-dashboard/authCache.js behaves
// correctly under TTL expiry (30min), LRU bound (500), and explicit eviction.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import * as authCache from '../../authCache.js'

beforeEach(() => {
  authCache.clear()
})

afterEach(() => {
  vi.useRealTimers()
  authCache.clear()
})

describe('H6 — Auth cache TTL', () => {
  it('initial state: empty cache, size=0', () => {
    expect(authCache.size()).toBe(0)
    expect(authCache.get(1)).toBe(null)
  })

  it('set+get round-trip returns same addr', () => {
    authCache.set(1, 'proxy://10.0.0.1:8080')
    expect(authCache.get(1)).toBe('proxy://10.0.0.1:8080')
  })

  it('set increments size by 1 per unique mailbox', () => {
    authCache.set(1, 'a')
    authCache.set(2, 'b')
    expect(authCache.size()).toBe(2)
  })

  it('set on existing mailbox replaces value (no double-count)', () => {
    authCache.set(1, 'a')
    authCache.set(1, 'b')
    expect(authCache.size()).toBe(1)
    expect(authCache.get(1)).toBe('b')
  })

  it('TTL expiry: entry returns null after 30min+1', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T10:00:00Z'))
    authCache.set(1, 'a')
    vi.setSystemTime(new Date('2026-04-26T10:30:01Z'))
    expect(authCache.get(1)).toBe(null)
  })

  it('TTL boundary: entry valid at 29:59, invalid at 30:01', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T10:00:00Z'))
    authCache.set(1, 'a')
    vi.setSystemTime(new Date('2026-04-26T10:29:59Z'))
    expect(authCache.get(1)).toBe('a')
    vi.setSystemTime(new Date('2026-04-26T10:30:01Z'))
    expect(authCache.get(1)).toBe(null)
  })

  it('expired entry auto-removed on get (lazy eviction)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T10:00:00Z'))
    authCache.set(1, 'a')
    expect(authCache.size()).toBe(1)
    vi.setSystemTime(new Date('2026-04-26T11:00:00Z'))
    authCache.get(1)  // triggers expiry
    expect(authCache.size()).toBe(0)
  })

  it('explicit invalidate removes entry', () => {
    authCache.set(1, 'a')
    authCache.invalidate(1)
    expect(authCache.get(1)).toBe(null)
    expect(authCache.size()).toBe(0)
  })

  it('LRU eviction: 501st insert drops oldest', () => {
    for (let i = 0; i < 501; i++) authCache.set(i, `addr-${i}`)
    expect(authCache.size()).toBe(authCache.MAX)
    expect(authCache.get(0)).toBe(null) // oldest evicted
    expect(authCache.get(500)).toBe('addr-500') // newest still there
  })

  it('LRU bump on get: accessed entry becomes "most recent"', () => {
    for (let i = 0; i < authCache.MAX; i++) authCache.set(i, `addr-${i}`)
    authCache.get(0) // bump 0 to most recent
    authCache.set(authCache.MAX, 'new')
    // 0 should still be cached because it was bumped
    expect(authCache.get(0)).toBe('addr-0')
  })

  it('post-rotation: invalidate triggers re-probe (cache returns null)', () => {
    authCache.set(1, 'old-proxy')
    authCache.invalidate(1)
    // Caller must do fresh probe — cache returns null.
    expect(authCache.get(1)).toBe(null)
  })

  it('cache survives many TTL-expired entries (cleanup is correct)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-26T10:00:00Z'))
    for (let i = 0; i < 100; i++) authCache.set(i, `a-${i}`)
    vi.setSystemTime(new Date('2026-04-26T11:00:00Z')) // 1h later, all expired
    for (let i = 0; i < 100; i++) authCache.get(i)
    expect(authCache.size()).toBe(0)
  })

  it('TTL constant exported correctly', () => {
    expect(authCache.TTL).toBe(30 * 60 * 1000)
  })

  it('MAX constant exported correctly', () => {
    expect(authCache.MAX).toBe(500)
  })
})
