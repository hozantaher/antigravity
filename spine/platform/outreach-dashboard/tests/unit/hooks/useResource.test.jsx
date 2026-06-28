import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useResource } from '../../../src/hooks/useResource'

function mockFetchOnce(payload, { status = 200 } = {}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Err',
    json: async () => payload,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useResource', () => {
  it('starts in loading, transitions to ok with data', async () => {
    mockFetchOnce({ working: [{ addr: '1.2.3.4' }] })
    const { result } = renderHook(() => useResource('/api/proxy-pool'))

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.data).toEqual({ working: [{ addr: '1.2.3.4' }] })
    expect(result.current.error).toBeNull()
    expect(result.current.loadedAt).toBeInstanceOf(Date)
  })

  it('transitions to error on network failure — keeps last data', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const { result } = renderHook(() => useResource('/api/x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatch(/network down/)
  })

  it('transitions to error on non-2xx', async () => {
    mockFetchOnce({ error: 'boom' }, { status: 500 })
    const { result } = renderHook(() => useResource('/api/x'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatch(/500/)
    expect(result.current.data).toBeNull()
  })

  it('parse transforms raw response', async () => {
    mockFetchOnce({ n: 5 })
    const { result } = renderHook(() =>
      useResource('/api/x', { parse: raw => raw.n * 2 })
    )
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.data).toBe(10)
  })

  it('initialData seeds state before first fetch', () => {
    mockFetchOnce({ a: 1 })
    const { result } = renderHook(() =>
      useResource('/api/x', { initialData: { a: 0 } })
    )
    expect(result.current.data).toEqual({ a: 0 })
  })

  it('enabled=false skips the fetch', () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    globalThis.fetch = spy
    const { result } = renderHook(() =>
      useResource('/api/x', { enabled: false })
    )
    expect(spy).not.toHaveBeenCalled()
    expect(result.current.status).toBe('idle')
  })

  it('refresh() triggers a new fetch', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ v: 1 }),
    })
    globalThis.fetch = spy
    const { result } = renderHook(() => useResource('/api/x'))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(spy).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refresh() })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('keeps status=ok (stale-while-revalidate) when refreshing successful data', async () => {
    let resolveSecond
    // Both entries must be Promises — real fetch() always returns one, and
    // coalescedFetch calls .then() on the result. The first entry was a bare
    // object, so .then() threw and the first load went to 'error' (the waitFor
    // below timed out). Mirror the other tests' mockResolvedValue shape.
    const responses = [
      Promise.resolve({ ok: true, status: 200, statusText: 'OK', json: async () => ({ v: 1 }) }),
      new Promise(r => { resolveSecond = () => r({ ok: true, status: 200, statusText: 'OK', json: async () => ({ v: 2 }) }) }),
    ]
    const spy = vi.fn().mockImplementation(() => responses.shift())
    globalThis.fetch = spy
    const { result } = renderHook(() => useResource('/api/x'))
    await waitFor(() => expect(result.current.status).toBe('ok'))
    act(() => { result.current.refresh() })
    expect(result.current.status).toBe('ok')
    resolveSecond()
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }))
  })

  it('url=null skips the fetch', () => {
    const spy = vi.fn()
    globalThis.fetch = spy
    renderHook(() => useResource(null))
    expect(spy).not.toHaveBeenCalled()
  })

  it('url can be a function (lazy resolution)', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true }),
    })
    globalThis.fetch = spy
    renderHook(() => useResource(() => '/api/dynamic'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/dynamic'))
  })
})
