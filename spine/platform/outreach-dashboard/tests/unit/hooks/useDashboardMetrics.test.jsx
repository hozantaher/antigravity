// KT-A11 — useDashboardMetrics hook unit tests.
//
// 3-state lifecycle:
//   connecting (initial) → live (after first SSE snapshot)
//   connecting → polling (after 3 SSE failures)
// Plus error surfacing + cleanup on unmount.
//
// Uses REAL timers + override of RETRY_DELAYS_MS via short setTimeout mock-free
// approach: tests trigger SSE errors then assert with waitFor (real timers).

import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useDashboardMetrics } from '../../../src/hooks/useDashboardMetrics'

// Minimal EventSource stub the hook can drive.
class FakeEventSource {
  static instances = []
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.onerror = null
    this.onopen = null
    this.closed = false
    FakeEventSource.instances.push(this)
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(fn)
  }
  removeEventListener(name, fn) {
    const arr = this.listeners.get(name) || []
    this.listeners.set(name, arr.filter((f) => f !== fn))
  }
  emit(name, data) {
    const arr = this.listeners.get(name) || []
    for (const fn of arr) fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
  triggerError() {
    if (this.onerror) this.onerror({})
  }
  open() {
    if (this.onopen) this.onopen({})
  }
  close() {
    this.closed = true
  }
}

// Stable across renders so useCallback deps don't churn.
const FAST_RETRIES = Object.freeze([10, 10, 10])

const SAMPLE_SNAPSHOT = {
  generated_at: '2026-04-30T12:00:00Z',
  globals: {
    send_rate_60m: 7,
    send_rate_6h_avg: 4,
    open_rate_24h: 33.3,
    sends_24h: 50,
    opens_24h: 17,
    active_campaigns: 2,
  },
  campaigns: [
    { id: 1, name: 'A', status: 'running', send_rate_60m: 5, reply_rate: 3.0, open_rate: 30, sent_total: 50, replied_total: 1, opened_total: 15, last_event_at: '2026-04-30T11:55:00Z' },
  ],
}

afterEach(() => {
  FakeEventSource.instances.length = 0
  vi.restoreAllMocks()
})

describe('useDashboardMetrics', () => {
  it('1. initial status is "connecting"', () => {
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory }))
    expect(result.current.status).toBe('connecting')
    expect(result.current.globals).toBeNull()
    expect(result.current.campaigns).toEqual([])
  })

  it('2. transitions to "live" after snapshot event', async () => {
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory }))
    expect(FakeEventSource.instances.length).toBe(1)
    act(() => {
      FakeEventSource.instances[0].emit('snapshot', SAMPLE_SNAPSHOT)
    })
    await waitFor(() => expect(result.current.status).toBe('live'))
    expect(result.current.globals.send_rate_60m).toBe(7)
    expect(result.current.campaigns).toHaveLength(1)
  })

  it('3. tick event updates snapshot in place', async () => {
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory }))
    act(() => FakeEventSource.instances[0].emit('snapshot', SAMPLE_SNAPSHOT))
    await waitFor(() => expect(result.current.status).toBe('live'))
    const next = { ...SAMPLE_SNAPSHOT, globals: { ...SAMPLE_SNAPSHOT.globals, send_rate_60m: 99 } }
    act(() => FakeEventSource.instances[0].emit('tick', next))
    await waitFor(() => expect(result.current.globals.send_rate_60m).toBe(99))
  })

  it('4. malformed JSON does NOT crash; surfaces parse error', async () => {
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory }))
    act(() => FakeEventSource.instances[0].emit('snapshot', 'not-json'))
    await waitFor(() => expect(result.current.error).toMatch(/parse/))
  })

  it('5. token option appended as query param to SSE URL', () => {
    const factory = vi.fn((url) => new FakeEventSource(url))
    renderHook(() => useDashboardMetrics({ sseFactory: factory, token: 'secret-key' }))
    expect(factory).toHaveBeenCalledWith(expect.stringContaining('token=secret-key'))
  })

  it('6. SSE error retries up to 3x before falling back to polling', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE_SNAPSHOT })
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory, fetchImpl, retryDelaysMs: FAST_RETRIES, pollingIntervalMs: 50 }))
    expect(FakeEventSource.instances.length).toBe(1)
    // Each error fires a setTimeout retry. Real timers mean we just wait for
    // the next instance to appear; the longest delay is 8s, so cap at 12s.
    act(() => FakeEventSource.instances[0].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2), { timeout: 4_000 })
    act(() => FakeEventSource.instances[1].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(3), { timeout: 6_000 })
    act(() => FakeEventSource.instances[2].triggerError())
    await waitFor(() => expect(result.current.status).toBe('polling'), { timeout: 12_000 })
    // Confirm no 4th SSE attempt.
    expect(FakeEventSource.instances.length).toBe(3)
  }, 30_000)

  it('7. polling tick populates globals after fallback', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => SAMPLE_SNAPSHOT })
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory, fetchImpl, retryDelaysMs: FAST_RETRIES, pollingIntervalMs: 50 }))
    act(() => FakeEventSource.instances[0].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2), { timeout: 4_000 })
    act(() => FakeEventSource.instances[1].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(3), { timeout: 6_000 })
    act(() => FakeEventSource.instances[2].triggerError())
    await waitFor(() => expect(result.current.status).toBe('polling'), { timeout: 12_000 })
    await waitFor(() => expect(result.current.globals?.send_rate_60m).toBe(7))
    expect(fetchImpl).toHaveBeenCalled()
  }, 30_000)

  it('8. polling 4xx response surfaces fatal error and stops', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory, fetchImpl, retryDelaysMs: FAST_RETRIES, pollingIntervalMs: 50 }))
    act(() => FakeEventSource.instances[0].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2), { timeout: 4_000 })
    act(() => FakeEventSource.instances[1].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(3), { timeout: 6_000 })
    act(() => FakeEventSource.instances[2].triggerError())
    await waitFor(() => expect(result.current.error).toBe('auth_or_client_401'), { timeout: 12_000 })
  }, 30_000)

  it('9. cleanup on unmount closes EventSource', () => {
    const factory = (url) => new FakeEventSource(url)
    const { unmount } = renderHook(() => useDashboardMetrics({ sseFactory: factory }))
    const es = FakeEventSource.instances[0]
    expect(es.closed).toBe(false)
    unmount()
    expect(es.closed).toBe(true)
  })

  it('10. enabled=false prevents SSE connection', () => {
    const factory = vi.fn((url) => new FakeEventSource(url))
    renderHook(() => useDashboardMetrics({ sseFactory: factory, enabled: false }))
    expect(factory).not.toHaveBeenCalled()
  })

  it('11. successful snapshot resets retry counter', async () => {
    const factory = (url) => new FakeEventSource(url)
    const { result } = renderHook(() => useDashboardMetrics({ sseFactory: factory, retryDelaysMs: FAST_RETRIES }))
    act(() => FakeEventSource.instances[0].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(2), { timeout: 4_000 })
    act(() => FakeEventSource.instances[1].emit('snapshot', SAMPLE_SNAPSHOT))
    await waitFor(() => expect(result.current.status).toBe('live'))
    // After live, trigger error — retry counter should restart at 0 so a new instance appears.
    act(() => FakeEventSource.instances[1].triggerError())
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(3), { timeout: 4_000 })
  }, 20_000)
})
