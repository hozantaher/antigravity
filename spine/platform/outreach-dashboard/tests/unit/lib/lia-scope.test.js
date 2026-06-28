// Sprint AI — unit tests for isInLiaScope (LIA NACE scope pre-flight check)
// Source: features/platform/outreach-dashboard/src/lib/campaign-send-batch.js
// Mirrors Go tests in features/outreach/campaigns/sender/lia_scope_test.go.

import { describe, it, expect, vi } from 'vitest'
import { isInLiaScope, getLIAScopeNACE } from '../../../src/lib/campaign-send-batch.js'

// Standard LIA scope: 8 NACE section codes
const DEFAULT_LIA_SCOPE = ['01', '41', '42', '43', '45', '46', '49', '77']

describe('isInLiaScope — LIA NACE scope pre-flight (Sprint AI)', () => {
  // ── happy path: all declared NACE sections ──────────────────────────────

  it('returns true for NACE 41 (výstavba budov)', () => {
    expect(isInLiaScope(['41200'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns true for NACE 42 (inženýrské stavitelství)', () => {
    expect(isInLiaScope(['42000'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns true for NACE 43 (specializované stavební)', () => {
    expect(isInLiaScope(['43110'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns true for NACE 45 (autoopravárenství)', () => {
    expect(isInLiaScope(['45200'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns true for NACE 46 (velkoobchod)', () => {
    expect(isInLiaScope(['46900'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns true for NACE 49 (doprava)', () => {
    expect(isInLiaScope(['49410'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns true for NACE 77 (pronájem strojů)', () => {
    expect(isInLiaScope(['77320'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns true for NACE 01 (zemědělství)', () => {
    expect(isInLiaScope(['01000'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  // ── outside scope ────────────────────────────────────────────────────────

  it('returns false for NACE 70 (poradenství)', () => {
    expect(isInLiaScope(['70100'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false for NACE 62 (software)', () => {
    expect(isInLiaScope(['62010'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false for NACE 47 (maloobchod — not 46)', () => {
    expect(isInLiaScope(['47190'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false for NACE 56 (stravování)', () => {
    expect(isInLiaScope(['56100'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false for NACE 85 (vzdělávání)', () => {
    expect(isInLiaScope(['85100'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false for NACE 84 (státní správa)', () => {
    expect(isInLiaScope(['84110'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  // ── null / empty / edge cases ─────────────────────────────────────────────

  it('returns false for null input', () => {
    expect(isInLiaScope(null, DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false for empty array', () => {
    expect(isInLiaScope([], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false for array with only empty strings', () => {
    expect(isInLiaScope(['', ''], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns false when code is single char (insufficient prefix)', () => {
    expect(isInLiaScope(['4'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns true when at least one code in mixed array is in scope', () => {
    // Company with primary NACE 70 but also registered as 49 (transport)
    expect(isInLiaScope(['70100', '49410'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns false when all codes in multi-code array are out of scope', () => {
    expect(isInLiaScope(['70100', '62010', '85100'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  it('returns true for 2-digit bare code "41"', () => {
    // Some data sources may store bare section codes without subdivision.
    expect(isInLiaScope(['41'], DEFAULT_LIA_SCOPE)).toBe(true)
  })

  it('returns false for non-numeric free-text sector label "G"', () => {
    // "G" appears in companies.nace_codes from legacy imports — must block.
    expect(isInLiaScope(['G'], DEFAULT_LIA_SCOPE)).toBe(false)
  })

  // ── custom scope (dynamic load) ──────────────────────────────────────────

  it('respects custom liaScope parameter (restricted scope)', () => {
    const restrictedScope = ['41', '42'] // only two sections
    expect(isInLiaScope(['41000'], restrictedScope)).toBe(true)
    expect(isInLiaScope(['43000'], restrictedScope)).toBe(false) // outside restricted scope
  })

  it('returns false for empty liaScope', () => {
    expect(isInLiaScope(['41000'], [])).toBe(false)
  })

  it('returns false for null liaScope', () => {
    expect(isInLiaScope(['41000'], null)).toBe(false)
  })
})

describe('getLIAScopeNACE — operator_settings loader (Sprint AI)', () => {
  it('returns the row value when operator_settings has lia_nace_scope JSON', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ value: JSON.stringify(['41', '42', '43']) }],
      }),
    }
    const out = await getLIAScopeNACE(pool)
    expect(out).toEqual(['41', '42', '43'])
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE key = 'lia_nace_scope'"),
    )
  })

  it('normalises >2-char entries to their 2-digit prefix', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{ value: JSON.stringify(['41200', '4900', 49]) }],
      }),
    }
    expect(await getLIAScopeNACE(pool)).toEqual(['41', '49', '49'])
  })

  it('falls back to the legacy list when the row is missing', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    expect(await getLIAScopeNACE(pool)).toEqual(['01', '41', '42', '43', '45', '46', '49', '77'])
  })

  it('falls back when value is not a JSON array', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ value: '"oops"' }] }),
    }
    expect(await getLIAScopeNACE(pool)).toEqual(['01', '41', '42', '43', '45', '46', '49', '77'])
  })

  it('falls back when value is unparseable JSON', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ value: '{not-json' }] }),
    }
    expect(await getLIAScopeNACE(pool)).toEqual(['01', '41', '42', '43', '45', '46', '49', '77'])
  })

  it('falls back when value is an empty JSON array', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ value: '[]' }] }),
    }
    expect(await getLIAScopeNACE(pool)).toEqual(['01', '41', '42', '43', '45', '46', '49', '77'])
  })

  it('falls back when pool.query throws', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) }
    expect(await getLIAScopeNACE(pool)).toEqual(['01', '41', '42', '43', '45', '46', '49', '77'])
  })

  it('falls back when pool is null', async () => {
    expect(await getLIAScopeNACE(null)).toEqual(['01', '41', '42', '43', '45', '46', '49', '77'])
  })

  it('returns a fresh array each call (no shared mutation)', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const a = await getLIAScopeNACE(pool)
    a.push('extra')
    const b = await getLIAScopeNACE(pool)
    expect(b).not.toContain('extra')
  })
})
