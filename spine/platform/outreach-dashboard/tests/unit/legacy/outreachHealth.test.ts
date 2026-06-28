import { describe, it, expect, beforeEach } from 'vitest'
import { useOutreachHealth } from '~/store/outreachHealth'
import { act } from '@testing-library/react'

describe('useOutreachHealth', () => {
  beforeEach(() => {
    useOutreachHealth.setState({ degraded: false, lastChecked: null })
  })

  it('starts healthy', () => {
    expect(useOutreachHealth.getState().degraded).toBe(false)
  })

  it('setDegraded(true) marks store as degraded', () => {
    act(() => useOutreachHealth.getState().setDegraded(true))
    expect(useOutreachHealth.getState().degraded).toBe(true)
    expect(useOutreachHealth.getState().lastChecked).not.toBeNull()
  })

  it('setDegraded(false) recovers', () => {
    act(() => {
      useOutreachHealth.getState().setDegraded(true)
      useOutreachHealth.getState().setDegraded(false)
    })
    expect(useOutreachHealth.getState().degraded).toBe(false)
  })
})
