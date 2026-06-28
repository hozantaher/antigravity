import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useFacets } from '../../../src/hooks/useFacets.js'

describe('useFacets', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches /api/companies/facets and returns value', async () => {
    const fake = { icp: { ideal: 10 }, size: {}, email: {}, engagement: {}, uncontacted: 1, hasWebsite: 2, hasEmail: 3, cachedAt: 'x' }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => fake })
    vi.stubGlobal('fetch', fetchMock)

    // Force a fresh module so the module-level snapshot is reset per test.
    vi.resetModules()
    const { useFacets: freshHook } = await import('../../../src/hooks/useFacets.js?r=' + Math.random())
    const { result } = renderHook(() => freshHook())

    await waitFor(() => expect(result.current).toEqual(fake))
    expect(fetchMock).toHaveBeenCalledWith('/api/companies/facets')
  })

  it('swallows fetch errors and returns null', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('net'))
    vi.stubGlobal('fetch', fetchMock)

    vi.resetModules()
    const { useFacets: freshHook } = await import('../../../src/hooks/useFacets.js?r=' + Math.random())
    const { result } = renderHook(() => freshHook())

    await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    expect(result.current).toBeNull()
  })
})
