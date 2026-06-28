// I4 — assertNever / warnNever tests.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { assertNever, warnNever } from '../../../src/lib/assert-never.js'
import { InvariantViolation } from '../../../src/lib/invariant.js'

afterEach(() => vi.restoreAllMocks())

describe('I4 — assertNever', () => {
  it('throws InvariantViolation', () => {
    expect(() => assertNever('unexpected')).toThrow(InvariantViolation)
  })

  it('error message includes value', () => {
    try {
      assertNever('mystery_action')
    } catch (e) {
      expect(e.message).toMatch(/mystery_action/)
    }
  })

  it('custom message used', () => {
    try {
      assertNever('x', 'unhandled action type')
    } catch (e) {
      expect(e.message).toMatch(/unhandled action type/)
    }
  })

  it('handles null/undefined values', () => {
    expect(() => assertNever(null)).toThrow()
    expect(() => assertNever(undefined)).toThrow()
  })

  it('handles object values', () => {
    expect(() => assertNever({ type: 'unknown' })).toThrow(/type/)
  })

  it('exhaustive switch usage example', () => {
    function dispatch(action) {
      switch (action.type) {
        case 'A': return 'handled A'
        case 'B': return 'handled B'
        default: return assertNever(action.type)
      }
    }
    expect(dispatch({ type: 'A' })).toBe('handled A')
    expect(() => dispatch({ type: 'C' })).toThrow(InvariantViolation)
  })
})

describe('I4 — warnNever (soft variant)', () => {
  it('logs console.warn but does not throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => warnNever('soft_unknown')).not.toThrow()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('warning includes value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnNever('a_value')
    expect(warnSpy.mock.calls[0][0]).toMatch(/a_value/)
  })
})
