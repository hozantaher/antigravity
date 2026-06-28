import { describe, it, expect } from 'vitest'
import {
  calcFullCheckScore,
  formatPipelineAge,
} from '../../../src/lib/mailboxUtils'

describe('calcFullCheckScore edge cases for UI', () => {
  it('score 100 when all null (no checks applicable)', () => {
    expect(calcFullCheckScore({})).toBe(100)
  })
  it('score renders as integer — no decimal in UI', () => {
    const s = calcFullCheckScore({ smtp: { ok: true }, imap: { ok: false } })
    expect(Number.isInteger(s)).toBe(true)
  })
})

describe('formatPipelineAge for UI display', () => {
  it('null → Nikdy', () => {
    expect(formatPipelineAge(null).label).toBe('Nikdy')
  })
  it('recent → before X min', () => {
    const iso = new Date(Date.now() - 30*60*1000).toISOString()
    expect(formatPipelineAge(iso).label).toContain('min')
  })
  it('old → before X hod', () => {
    const iso = new Date(Date.now() - 3*60*60*1000).toISOString()
    expect(formatPipelineAge(iso).label).toContain('hod')
  })
})
