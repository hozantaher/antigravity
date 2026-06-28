import { renderHook, act } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { useUrlState, useUrlStateMap } from '../../../src/hooks/useUrlState'

const wrap = (initial = '/') => ({ children }) => (
  <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
)

describe('useUrlState — single key', () => {
  it('returns default when param absent', () => {
    const { result } = renderHook(() => useUrlState('q', 'none'), { wrapper: wrap('/') })
    expect(result.current[0]).toBe('none')
  })

  it('reads value from URL', () => {
    const { result } = renderHook(() => useUrlState('q', ''), { wrapper: wrap('/?q=hello') })
    expect(result.current[0]).toBe('hello')
  })

  it('setValue updates state', () => {
    const { result } = renderHook(() => useUrlState('q', ''), { wrapper: wrap('/') })
    act(() => result.current[1]('new'))
    expect(result.current[0]).toBe('new')
  })

  it('setValue with default strips the key', () => {
    const { result } = renderHook(() => useUrlState('q', 'dflt'), { wrapper: wrap('/?q=other') })
    act(() => result.current[1]('dflt'))
    expect(result.current[0]).toBe('dflt')
  })

  it('functional updater receives current value', () => {
    const { result } = renderHook(() => useUrlState('n', 0, { parse: Number, serialize: String }),
      { wrapper: wrap('/?n=5') })
    act(() => result.current[1]((x) => x + 1))
    expect(result.current[0]).toBe(6)
  })

  it('functional updater falls back to default when absent', () => {
    const { result } = renderHook(() => useUrlState('n', 100, { parse: Number, serialize: String }),
      { wrapper: wrap('/') })
    act(() => result.current[1]((x) => x + 1))
    expect(result.current[0]).toBe(101)
  })

  it('parse is applied to URL value', () => {
    const { result } = renderHook(() => useUrlState('n', 0, { parse: (v) => Number(v) * 2 }),
      { wrapper: wrap('/?n=3') })
    expect(result.current[0]).toBe(6)
  })

  it('null value strips key', () => {
    const { result } = renderHook(() => useUrlState('q', ''), { wrapper: wrap('/?q=a') })
    act(() => result.current[1](null))
    expect(result.current[0]).toBe('')
  })

  it('empty serialized value strips key', () => {
    const { result } = renderHook(() => useUrlState('q', 'd', { serialize: () => '' }),
      { wrapper: wrap('/?q=existing') })
    act(() => result.current[1]('new'))
    expect(result.current[0]).toBe('d')
  })

  it('default serialize turns numbers into strings', () => {
    const { result } = renderHook(() => useUrlState('n', 0), { wrapper: wrap('/') })
    act(() => result.current[1](42))
    expect(result.current[0]).toBe('42')
  })

  it('setter is a function', () => {
    const { result } = renderHook(() => useUrlState('q', ''), { wrapper: wrap('/?q=a') })
    expect(typeof result.current[1]).toBe('function')
  })
})

describe('useUrlStateMap — multi key', () => {
  const schema = {
    q: { default: '', parse: (v) => v, serialize: (v) => v },
    page: { default: 1, parse: Number, serialize: String },
  }

  it('returns defaults when URL empty', () => {
    const { result } = renderHook(() => useUrlStateMap(schema), { wrapper: wrap('/') })
    expect(result.current[0]).toEqual({ q: '', page: 1 })
  })

  it('reads multiple params from URL', () => {
    const { result } = renderHook(() => useUrlStateMap(schema),
      { wrapper: wrap('/?q=hello&page=3') })
    expect(result.current[0]).toEqual({ q: 'hello', page: 3 })
  })

  it('partial patch updates one key only', () => {
    const { result } = renderHook(() => useUrlStateMap(schema),
      { wrapper: wrap('/?q=a&page=2') })
    act(() => result.current[1]({ page: 5 }))
    expect(result.current[0].page).toBe(5)
    expect(result.current[0].q).toBe('a')
  })

  it('default value strips key from URL', () => {
    const { result } = renderHook(() => useUrlStateMap(schema),
      { wrapper: wrap('/?q=a&page=3') })
    act(() => result.current[1]({ page: 1 }))
    expect(result.current[0].page).toBe(1)
  })

  it('null value strips key', () => {
    const { result } = renderHook(() => useUrlStateMap(schema),
      { wrapper: wrap('/?q=a') })
    act(() => result.current[1]({ q: null }))
    expect(result.current[0].q).toBe('')
  })

  it('functional updater receives current values', () => {
    const { result } = renderHook(() => useUrlStateMap(schema),
      { wrapper: wrap('/?q=x&page=2') })
    act(() => result.current[1]((v) => ({ page: v.page + 10 })))
    expect(result.current[0].page).toBe(12)
  })

  it('unknown keys in patch are ignored', () => {
    const { result } = renderHook(() => useUrlStateMap(schema),
      { wrapper: wrap('/') })
    act(() => result.current[1]({ unknown: 'x', q: 'known' }))
    expect(result.current[0].q).toBe('known')
    expect(result.current[0].unknown).toBeUndefined()
  })

  it('empty schema yields empty values', () => {
    const { result } = renderHook(() => useUrlStateMap({}), { wrapper: wrap('/') })
    expect(result.current[0]).toEqual({})
  })

  it('setter is referentially stable across rerender', () => {
    const { result, rerender } = renderHook(() => useUrlStateMap(schema),
      { wrapper: wrap('/?q=a') })
    const first = result.current[1]
    rerender()
    expect(result.current[1]).toBe(first)
  })

  it('default serialize applied when not provided', () => {
    const minimal = { tag: { default: '' } }
    const { result } = renderHook(() => useUrlStateMap(minimal), { wrapper: wrap('/') })
    act(() => result.current[1]({ tag: 'news' }))
    expect(result.current[0].tag).toBe('news')
  })
})
