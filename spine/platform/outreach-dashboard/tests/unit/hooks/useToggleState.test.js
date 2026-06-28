/**
 * useToggleState — localStorage-persisted boolean toggle hook.
 *
 * Memory feedback_extreme_testing: state-changing UI hook, 5+ cases.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useToggleState,
  MB_LS_SHOW_HEALTH_BOARD,
  MB_LS_SHOW_FILTERS,
  MB_LS_SHOW_DIAG_DETAIL,
  MB_LS_SHOW_STATS,
} from '../../../src/hooks/useToggleState'

// In-memory localStorage mock
let lsStore = {}
const lsMock = {
  getItem: vi.fn((k) => lsStore[k] ?? null),
  setItem: vi.fn((k, v) => { lsStore[k] = v }),
  removeItem: vi.fn((k) => { delete lsStore[k] }),
  clear: vi.fn(() => { lsStore = {} }),
}
Object.defineProperty(globalThis, 'localStorage', { value: lsMock, writable: true })

beforeEach(() => {
  lsStore = {}
  vi.clearAllMocks()
  lsMock.getItem.mockImplementation((k) => lsStore[k] ?? null)
  lsMock.setItem.mockImplementation((k, v) => { lsStore[k] = v })
})

describe('useToggleState', () => {
  it('returns the default value when localStorage is empty', () => {
    const { result } = renderHook(() => useToggleState('mb.test.key', false))
    expect(result.current[0]).toBe(false)
  })

  it('returns the default=true when localStorage is empty', () => {
    const { result } = renderHook(() => useToggleState('mb.test.key', true))
    expect(result.current[0]).toBe(true)
  })

  it('reads the persisted value from localStorage on first render', () => {
    lsStore['mb.test.key'] = 'true'
    const { result } = renderHook(() => useToggleState('mb.test.key', false))
    expect(result.current[0]).toBe(true)
  })

  it('reads "false" as boolean false', () => {
    lsStore['mb.test.key'] = 'false'
    const { result } = renderHook(() => useToggleState('mb.test.key', true))
    expect(result.current[0]).toBe(false)
  })

  it('calling toggle() flips the value', () => {
    const { result } = renderHook(() => useToggleState('mb.test.key', false))
    act(() => { result.current[1]() })
    expect(result.current[0]).toBe(true)
    act(() => { result.current[1]() })
    expect(result.current[0]).toBe(false)
  })

  it('calling toggle(true) sets explicit value', () => {
    const { result } = renderHook(() => useToggleState('mb.test.key', false))
    act(() => { result.current[1](true) })
    expect(result.current[0]).toBe(true)
  })

  it('persists value changes to localStorage', () => {
    const { result } = renderHook(() => useToggleState('mb.test.key', false))
    act(() => { result.current[1](true) })
    expect(lsStore['mb.test.key']).toBe('true')
    act(() => { result.current[1](false) })
    expect(lsStore['mb.test.key']).toBe('false')
  })

  it('survives localStorage.getItem throwing (private mode)', () => {
    lsMock.getItem.mockImplementation(() => { throw new Error('access denied') })
    const { result } = renderHook(() => useToggleState('mb.test.key', true))
    expect(result.current[0]).toBe(true)
  })

  it('survives localStorage.setItem throwing (quota exceeded)', () => {
    const { result } = renderHook(() => useToggleState('mb.test.key', false))
    lsMock.setItem.mockImplementation(() => { throw new Error('quota') })
    expect(() => act(() => { result.current[1](true) })).not.toThrow()
    expect(result.current[0]).toBe(true)
  })

  it('exposes named MB_LS_* constants for the mailbox toggles', () => {
    expect(MB_LS_SHOW_HEALTH_BOARD).toBe('mb.showHealthBoard')
    expect(MB_LS_SHOW_FILTERS).toBe('mb.showFilters')
    expect(MB_LS_SHOW_DIAG_DETAIL).toBe('mb.drawer.showDiagDetail')
    expect(MB_LS_SHOW_STATS).toBe('mb.drawer.showStats')
  })
})
