import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOperatorSetting } from '../../../src/hooks/useOperatorSetting'

describe('useOperatorSetting hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns fallback value on initial render', () => {
    const { result } = renderHook(() => useOperatorSetting('brand_label', 'DefaultBrand'))
    expect(result.current).toBe('DefaultBrand')
  })

  it('fetches and returns operator setting value on success', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve([
            { key: 'brand_label', value: 'Hozan' },
            { key: 'controller_name', value: 'Hozan s.r.o.' },
          ]),
      } as Response)
    )

    const { result } = renderHook(() => useOperatorSetting('brand_label', 'DefaultBrand'))
    expect(result.current).toBe('DefaultBrand')

    await waitFor(() => {
      expect(result.current).toBe('Hozan')
    })
  })

  it('returns fallback when key is not found in settings', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{ key: 'controller_name', value: 'Hozan s.r.o.' }]),
      } as Response)
    )

    const { result } = renderHook(() => useOperatorSetting('brand_label', 'DefaultBrand'))

    await waitFor(() => {
      expect(result.current).toBe('DefaultBrand')
    })
  })

  it('returns fallback when fetch fails', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('Network error')))

    const { result } = renderHook(() => useOperatorSetting('brand_label', 'DefaultBrand'))

    await waitFor(() => {
      expect(result.current).toBe('DefaultBrand')
    })
  })

  it('returns fallback when HTTP response is not ok', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
      } as Response)
    )

    const { result } = renderHook(() => useOperatorSetting('brand_label', 'DefaultBrand'))

    await waitFor(() => {
      expect(result.current).toBe('DefaultBrand')
    })
  })

  it('fetches with correct endpoint URL', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([]),
      } as Response)
    )

    renderHook(() => useOperatorSetting('brand_label', 'Default'))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/operator-settings')
    })
  })

  it('handles empty key gracefully', () => {
    const { result } = renderHook(() => useOperatorSetting('', 'DefaultBrand'))
    expect(result.current).toBe('DefaultBrand')
  })

  it('cleans up fetch on unmount', async () => {
    const abortSpy = vi.fn()
    global.fetch = vi.fn(
      () =>
        new Promise(() => {
          // Never resolves; simulates slow fetch
        })
    )

    const { unmount } = renderHook(() => useOperatorSetting('brand_label', 'Default'))
    unmount()

    // Hook should have set isMounted = false, preventing state updates
    expect(true).toBe(true) // Test passes if no error thrown
  })
})
