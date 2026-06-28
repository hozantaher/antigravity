// tests/unit/hooks/usePollEndpoint.test.js
// ─────────────────────────────────────────────────────────────────────────────
// 6 cases covering the usePollEndpoint hook contract.
// Follows the same test patterns as useResource.test.jsx in this directory.

import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { usePollEndpoint } from '../../../src/hooks/usePollEndpoint'

const INTERVAL = 30_000

function mockFetch(payload, { status = 200 } = {}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('usePollEndpoint', () => {
  it('fetches on mount and returns data', async () => {
    mockFetch({ total: 42 })
    const { result } = renderHook(() => usePollEndpoint('/api/test', INTERVAL))

    await waitFor(() => expect(result.current.data).not.toBeNull())
    expect(result.current.data).toEqual({ total: 42 })
    expect(result.current.error).toBeNull()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/test')
  })

  it('sets error on non-2xx response', async () => {
    mockFetch({ error: 'Server Error' }, { status: 500 })
    const { result } = renderHook(() => usePollEndpoint('/api/test', INTERVAL))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toMatch(/500/)
    expect(result.current.data).toBeNull()
  })

  it('polls again after intervalMs (fake timer)', async () => {
    vi.useFakeTimers()
    const responses = [
      { ok: true, status: 200, statusText: 'OK', json: async () => ({ count: 1 }) },
      { ok: true, status: 200, statusText: 'OK', json: async () => ({ count: 2 }) },
    ]
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()))

    const { result } = renderHook(() => usePollEndpoint('/api/test', INTERVAL))

    // Flush first fetch
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    expect(result.current.data).toEqual({ count: 1 })

    // Advance to next poll
    await act(async () => { vi.advanceTimersByTime(INTERVAL) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    expect(result.current.data).toEqual({ count: 2 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('pauses polling while document is hidden', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ val: 1 }),
    })

    // Hide the document before mount
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })

    renderHook(() => usePollEndpoint('/api/test', INTERVAL))

    // Flush initial fetch (hidden check is in interval handler, not initial call)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    const callsAfterMount = globalThis.fetch.mock.calls.length

    // Advance time — interval tick should be skipped because hidden=true
    await act(async () => { vi.advanceTimersByTime(INTERVAL * 3) })
    await act(async () => { await Promise.resolve() })

    expect(globalThis.fetch.mock.calls.length).toBe(callsAfterMount)

    // Restore
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('cleans up interval on unmount', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    })

    const { unmount } = renderHook(() => usePollEndpoint('/api/test', INTERVAL))

    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    const callsAtUnmount = globalThis.fetch.mock.calls.length

    unmount()
    await act(async () => { vi.advanceTimersByTime(INTERVAL * 5) })
    await act(async () => { await Promise.resolve() })

    // No additional calls after unmount
    expect(globalThis.fetch.mock.calls.length).toBe(callsAtUnmount)
  })

  it('refresh callback triggers an immediate re-fetch', async () => {
    const responses = [
      { ok: true, status: 200, statusText: 'OK', json: async () => ({ step: 'initial' }) },
      { ok: true, status: 200, statusText: 'OK', json: async () => ({ step: 'refreshed' }) },
    ]
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()))

    const { result } = renderHook(() => usePollEndpoint('/api/test', INTERVAL))

    await waitFor(() => expect(result.current.data).toEqual({ step: 'initial' }))

    await act(async () => { await result.current.refresh() })
    await waitFor(() => expect(result.current.data).toEqual({ step: 'refreshed' }))
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})
