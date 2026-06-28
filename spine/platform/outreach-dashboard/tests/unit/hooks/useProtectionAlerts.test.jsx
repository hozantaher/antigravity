import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useProtectionAlerts } from '../../../src/hooks/useProtectionAlerts'

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
})

describe('useProtectionAlerts', () => {
  it('fetches alerts on mount', async () => {
    mockFetch({
      alerts: [
        { id: 1, layer: 'watchdog', level: 2, severity: 'critical', status: 'open' },
      ],
    })
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.alerts).toHaveLength(1)
    expect(result.current.criticalCount).toBe(1)
    expect(result.current.warnCount).toBe(0)
    expect(result.current.error).toBeNull()
  })

  it('counts warning alerts separately', async () => {
    mockFetch({
      alerts: [
        { id: 1, layer: 'header_gate', level: 3, severity: 'warning', status: 'open' },
        { id: 2, layer: 'canary',      level: 3, severity: 'critical', status: 'open' },
      ],
    })
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.criticalCount).toBe(1)
    expect(result.current.warnCount).toBe(1)
  })

  it('acked alerts appear in list but not in count', async () => {
    mockFetch({
      alerts: [
        { id: 1, layer: 'watchdog', level: 2, severity: 'critical', status: 'acked' },
      ],
    })
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.alerts).toHaveLength(1)
    expect(result.current.criticalCount).toBe(0)
  })

  it('reports error on fetch rejection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.error).toMatch(/offline/))
    expect(result.current.loading).toBe(false)
  })

  it('reports error on non-2xx response', async () => {
    mockFetch({ error: 'internal' }, { status: 503 })
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.error).toMatch(/503/))
  })

  it('tolerates missing alerts field', async () => {
    mockFetch({})
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.alerts).toEqual([])
    expect(result.current.criticalCount).toBe(0)
  })

  it('refresh() triggers new fetch', async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ alerts: [] }),
    })
    globalThis.fetch = spy
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(spy).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refresh() })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('ack() posts to correct endpoint and reloads', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [] }) }) // initial load
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })             // POST ack
      .mockResolvedValueOnce({ ok: true, json: async () => ({ alerts: [] }) }) // reload
    globalThis.fetch = spy
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { await result.current.ack(42) })
    expect(spy).toHaveBeenCalledTimes(3)
    const [ackUrl, ackOpts] = spy.mock.calls[1]
    expect(ackUrl).toContain('/42/ack')
    expect(ackOpts.method).toBe('POST')
  })

  it('empty alerts list produces zero counts', async () => {
    mockFetch({ alerts: [] })
    const { result } = renderHook(() => useProtectionAlerts(0))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.criticalCount).toBe(0)
    expect(result.current.warnCount).toBe(0)
  })
})
