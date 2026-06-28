import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useFilterPresets, __test } from '../../../src/hooks/useFilterPresets.js'
import { DEFAULTS } from '../../../src/lib/filterSerializer.js'

beforeEach(() => {
  window.localStorage.clear()
})

const someFilters = () => ({
  ...DEFAULTS,
  q: 'bagry',
  scoreMin: 60,
  region: ['Hlavní město Praha'],
  engagement: ['hot'],
  hasWebsite: true,
})

describe('useFilterPresets', () => {
  it('starts empty when storage is empty', () => {
    const { result } = renderHook(() => useFilterPresets())
    expect(result.current.presets).toEqual([])
  })

  it('persists saved presets to localStorage', () => {
    const { result } = renderHook(() => useFilterPresets())
    act(() => { result.current.save('Horká Praha', someFilters()) })
    expect(result.current.presets).toHaveLength(1)
    const raw = window.localStorage.getItem(__test.STORAGE_KEY)
    expect(raw).toContain('Horká Praha')
  })

  it('upserts by name instead of duplicating', () => {
    const { result } = renderHook(() => useFilterPresets())
    act(() => { result.current.save('MůjPohled', { ...DEFAULTS, scoreMin: 40 }) })
    act(() => { result.current.save('MůjPohled', { ...DEFAULTS, scoreMin: 80 }) })
    expect(result.current.presets).toHaveLength(1)
    expect(result.current.presets[0].filters.scoreMin).toBe(80)
  })

  it('trims whitespace and rejects empty names', () => {
    const { result } = renderHook(() => useFilterPresets())
    act(() => { result.current.save('   ', someFilters()) })
    act(() => { result.current.save('  Ok  ', someFilters()) })
    expect(result.current.presets).toHaveLength(1)
    expect(result.current.presets[0].name).toBe('Ok')
  })

  it('toPatch returns DEFAULTS-merged slice', () => {
    const { result } = renderHook(() => useFilterPresets())
    let id
    act(() => { id = result.current.save('X', someFilters()).id })
    const patch = result.current.toPatch(id)
    expect(patch.q).toBe('bagry')
    expect(patch.scoreMin).toBe(60)
    expect(patch.region).toEqual(['Hlavní město Praha'])
    // A field not in the preset falls back to DEFAULTS (here, offset isn't persisted)
    expect(patch.offset).toBeUndefined() // offset is stripped from PRESET_KEYS
    expect(patch.sector).toEqual([])
  })

  it('remove drops the preset from state and storage', () => {
    const { result } = renderHook(() => useFilterPresets())
    let id
    act(() => { id = result.current.save('del', someFilters()).id })
    act(() => { result.current.remove(id) })
    expect(result.current.presets).toEqual([])
    const raw = window.localStorage.getItem(__test.STORAGE_KEY)
    expect(raw).toBe('[]')
  })

  it('rename updates the label in place', () => {
    const { result } = renderHook(() => useFilterPresets())
    let id
    act(() => { id = result.current.save('old', someFilters()).id })
    act(() => { result.current.rename(id, ' new ') })
    expect(result.current.presets[0].name).toBe('new')
  })

  it('cross-tab sync applies incoming storage events', () => {
    const { result } = renderHook(() => useFilterPresets())
    const incoming = [{ id: 'p_x', name: 'remote', createdAt: 1, filters: { q: 'z' } }]
    act(() => {
      window.localStorage.setItem(__test.STORAGE_KEY, JSON.stringify(incoming))
      window.dispatchEvent(new StorageEvent('storage', {
        key: __test.STORAGE_KEY,
        newValue: JSON.stringify(incoming),
      }))
    })
    expect(result.current.presets).toEqual(incoming)
  })
})

describe('pickPresetSlice', () => {
  it('excludes offset', () => {
    const slice = __test.pickPresetSlice({ ...DEFAULTS, offset: 200, q: 'x' })
    expect(slice.offset).toBeUndefined()
    expect(slice.q).toBe('x')
  })

  it('includes all non-offset DEFAULTS keys present on input', () => {
    const slice = __test.pickPresetSlice(DEFAULTS)
    for (const k of __test.PRESET_KEYS) expect(k in slice).toBe(true)
    expect('offset' in slice).toBe(false)
  })
})
