// warmup-cap.test.js
// Unit tests for Sprint AP1 — warmup cap error helpers in
// src/server-routes/campaigns.js.
//
// Coverage (≥10 cases):
//   1.  isWarmupCapError: null/undefined → false
//   2.  isWarmupCapError: ERRCODE 23514 + message → true
//   3.  isWarmupCapError: only message (no code field) → true
//   4.  isWarmupCapError: unrelated DB error → false
//   5.  isWarmupCapError: relay string error → true
//   6.  parseWarmupCapDetail: well-formed trigger message
//   7.  parseWarmupCapDetail: partially formed message
//   8.  parseWarmupCapDetail: empty string → all null
//   9.  parseWarmupCapDetail: production phase
//  10.  isWarmupCapError: case-insensitive match

import { describe, it, expect } from 'vitest'
import { isWarmupCapError, parseWarmupCapDetail } from '../../../src/server-routes/campaigns.js'

describe('isWarmupCapError', () => {
  it('returns false for null', () => {
    expect(isWarmupCapError(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isWarmupCapError(undefined)).toBe(false)
  })

  it('returns true for ERRCODE 23514 + warmup_cap_exceeded message', () => {
    const e = Object.assign(
      new Error('warmup_cap_exceeded: mailbox=a@b.cz phase=warmup_d0 sent_today=5 cap=5'),
      { code: '23514' },
    )
    expect(isWarmupCapError(e)).toBe(true)
  })

  it('returns true for plain error message containing warmup_cap_exceeded', () => {
    const e = new Error('warmup_cap_exceeded: mailbox=a@b.cz phase=warmup_d3 sent_today=10 cap=10')
    expect(isWarmupCapError(e)).toBe(true)
  })

  it('returns false for unrelated ERRCODE 23514 error', () => {
    // ERRCODE 23514 alone without the marker should NOT match
    const e = Object.assign(new Error('check constraint "some_other_check" violated'), { code: '23514' })
    expect(isWarmupCapError(e)).toBe(false)
  })

  it('returns false for a normal DB error', () => {
    const e = Object.assign(new Error('relation "foo" does not exist'), { code: '42P01' })
    expect(isWarmupCapError(e)).toBe(false)
  })

  it('returns true for relay-propagated error string', () => {
    const e = new Error('relay HTTP 422: warmup_cap_exceeded: mailbox=x@seznam.cz phase=warmup_d7 sent_today=25 cap=25')
    expect(isWarmupCapError(e)).toBe(true)
  })

  it('returns true for case-insensitive match (WARMUP_CAP_EXCEEDED)', () => {
    const e = new Error('WARMUP_CAP_EXCEEDED: something')
    expect(isWarmupCapError(e)).toBe(true)
  })
})

describe('parseWarmupCapDetail', () => {
  it('parses a well-formed trigger message', () => {
    const msg = 'warmup_cap_exceeded: mailbox=test@seznam.cz phase=warmup_d0 sent_today=5 cap=5'
    const detail = parseWarmupCapDetail(msg)
    expect(detail.phase).toBe('warmup_d0')
    expect(detail.sent_today).toBe(5)
    expect(detail.cap).toBe(5)
  })

  it('parses warmup_d3 phase correctly', () => {
    const msg = 'warmup_cap_exceeded: mailbox=a@b.cz phase=warmup_d3 sent_today=10 cap=10'
    const detail = parseWarmupCapDetail(msg)
    expect(detail.phase).toBe('warmup_d3')
    expect(detail.cap).toBe(10)
  })

  it('parses production phase with override cap', () => {
    const msg = 'warmup_cap_exceeded: mailbox=a@b.cz phase=production sent_today=80 cap=80'
    const detail = parseWarmupCapDetail(msg)
    expect(detail.phase).toBe('production')
    expect(detail.sent_today).toBe(80)
    expect(detail.cap).toBe(80)
  })

  it('returns all null for empty string', () => {
    const detail = parseWarmupCapDetail('')
    expect(detail.phase).toBeNull()
    expect(detail.sent_today).toBeNull()
    expect(detail.cap).toBeNull()
  })

  it('handles partially formed message (only phase present)', () => {
    const msg = 'warmup_cap_exceeded: phase=warmup_d14'
    const detail = parseWarmupCapDetail(msg)
    expect(detail.phase).toBe('warmup_d14')
    expect(detail.sent_today).toBeNull()
    expect(detail.cap).toBeNull()
  })
})
