import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'
import { useCompanyFilters } from '../../../src/hooks/useCompanyFilters.js'
import { DEFAULTS } from '../../../src/lib/filterSerializer.js'

function wrapperFor(initialPath = '/firmy') {
  return function Wrapper({ children }) {
    return React.createElement(MemoryRouter, { initialEntries: [initialPath] }, children)
  }
}

describe('useCompanyFilters', () => {
  it('returns defaults on empty URL', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(result.current.filters).toEqual(DEFAULTS)
    expect(result.current.hasActive).toBe(false)
  })

  it('parses URL on mount', () => {
    const { result } = renderHook(() => useCompanyFilters(), {
      wrapper: wrapperFor('/firmy?q=cnc&icp=ideal,good&scoreMin=70'),
    })
    expect(result.current.filters.q).toBe('cnc')
    expect(result.current.filters.icp).toEqual(['ideal', 'good'])
    expect(result.current.filters.scoreMin).toBe(70)
    expect(result.current.hasActive).toBe(true)
  })

  it('setFilter applies immediate change for non-debounced key', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    act(() => result.current.setFilter('icp', ['ideal']))
    expect(result.current.filters.icp).toEqual(['ideal'])
  })

  it('clearFilter resets single filter to default', () => {
    const { result } = renderHook(() => useCompanyFilters(), {
      wrapper: wrapperFor('/firmy?icp=ideal,good&q=cnc'),
    })
    act(() => result.current.clearFilter('icp'))
    expect(result.current.filters.icp).toEqual([])
    expect(result.current.filters.q).toBe('cnc')
  })

  it('clearAll resets everything but preserves sort/dir', () => {
    const { result } = renderHook(() => useCompanyFilters(), {
      wrapper: wrapperFor('/firmy?q=cnc&icp=ideal&sort=name&dir=asc'),
    })
    act(() => result.current.clearAll())
    expect(result.current.filters.q).toBe('')
    expect(result.current.filters.icp).toEqual([])
    expect(result.current.filters.sort).toBe('name')
    expect(result.current.filters.dir).toBe('asc')
    expect(result.current.hasActive).toBe(false)
  })

  it('offset resets to 0 when non-offset filter changes', () => {
    const { result } = renderHook(() => useCompanyFilters(), {
      wrapper: wrapperFor('/firmy?offset=100'),
    })
    expect(result.current.filters.offset).toBe(100)
    act(() => result.current.setFilter('icp', ['ideal']))
    expect(result.current.filters.offset).toBe(0)
  })

  it('offset is preserved when only offset changes', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    act(() => result.current.setFilter('offset', 50))
    expect(result.current.filters.offset).toBe(50)
  })

  it('debounced key does not apply immediately', async () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    act(() => result.current.setFilter('q', 'cnc'))
    expect(result.current.filters.q).toBe('')
    await new Promise(r => setTimeout(r, 350))
    expect(result.current.filters.q).toBe('cnc')
  })

  it('flush cancels pending debounced writes', async () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    act(() => result.current.setFilter('q', 'abc'))
    act(() => result.current.flush())
    await new Promise(r => setTimeout(r, 400))
    expect(result.current.filters.q).toBe('')
  })

  it('setFilters batches multiple keys', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy?offset=50') })
    act(() => result.current.setFilters({ icp: ['ideal'], scoreMin: 80 }))
    expect(result.current.filters.icp).toEqual(['ideal'])
    expect(result.current.filters.scoreMin).toBe(80)
    expect(result.current.filters.offset).toBe(0)
  })

  it('toServerQuery emits legacy server params', () => {
    const { result } = renderHook(() => useCompanyFilters(), {
      wrapper: wrapperFor('/firmy?q=cnc&icp=ideal'),
    })
    const q = result.current.toServerQuery().toString()
    expect(q).toContain('search=cnc')
    expect(q).toContain('icp=ideal')
  })

  it('active lists non-default keys excluding sort/dir/offset', () => {
    const { result } = renderHook(() => useCompanyFilters(), {
      wrapper: wrapperFor('/firmy?q=cnc&sort=name&offset=100'),
    })
    expect(result.current.active).toEqual(['q'])
  })

  it('rapid consecutive debounced writes commit last value', async () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    act(() => result.current.setFilter('q', 'a'))
    act(() => result.current.setFilter('q', 'ab'))
    act(() => result.current.setFilter('q', 'abc'))
    await new Promise(r => setTimeout(r, 400))
    expect(result.current.filters.q).toBe('abc')
  })

  // ── MONKEY: adversarial setFilter inputs ──────────────────────────────

  it('MONKEY: setFilter with known string keys never throws', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    const stringKeys = ['name', 'status', 'sector', 'icp', 'q', 'sort', 'dir']
    for (const key of stringKeys) {
      expect(() => act(() => result.current.setFilter(key, 'test'))).not.toThrow()
    }
  })

  it('MONKEY: setFilter with empty string key does not crash the hook', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(() => act(() => result.current.setFilter('', 'value'))).not.toThrow()
  })

  it('MONKEY: setFilter with emoji key does not crash the hook', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(() => act(() => result.current.setFilter('💬', 'value'))).not.toThrow()
  })

  it('MONKEY: setFilter with 100-char key does not crash the hook', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    const longKey = 'x'.repeat(100)
    expect(() => act(() => result.current.setFilter(longKey, 'value'))).not.toThrow()
  })

  it('MONKEY: setFilter with null value does not crash the hook', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(() => act(() => result.current.setFilter('icp', null))).not.toThrow()
  })

  it('MONKEY: setFilter with undefined value does not crash the hook', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(() => act(() => result.current.setFilter('icp', undefined))).not.toThrow()
  })

  it('MONKEY: setFilters with empty object does not crash', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(() => act(() => result.current.setFilters({}))).not.toThrow()
  })

  it('MONKEY: setFilters with unknown keys does not crash', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(() => act(() => result.current.setFilters({ unknownKey: 'value', __proto__: null }))).not.toThrow()
  })

  it('MONKEY: clearFilter with unknown key does not crash', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy') })
    expect(() => act(() => result.current.clearFilter('nonExistentKey'))).not.toThrow()
  })

  it('MONKEY: toServerQuery never throws regardless of filter state', () => {
    const { result } = renderHook(() => useCompanyFilters(), { wrapper: wrapperFor('/firmy?icp=ideal&q=test&scoreMin=50') })
    expect(() => result.current.toServerQuery()).not.toThrow()
    expect(() => result.current.toServerQuery({ limit: 100 })).not.toThrow()
    expect(() => result.current.toServerQuery({})).not.toThrow()
  })
})
