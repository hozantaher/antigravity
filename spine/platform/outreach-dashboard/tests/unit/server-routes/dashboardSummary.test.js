// Unit tests for src/server-routes/dashboardSummary.js — pure helpers.
// ─────────────────────────────────────────────────────────────────────────────
// Coverage:
//   1. redactFrom strips local part, keeps domain
//   2. redactFrom handles malformed / nullish inputs
//   3. Named constants exposed for tuning (no magic numbers)

import { describe, expect, it } from 'vitest'
import { redactFrom, __internals } from '../../../src/server-routes/dashboardSummary.js'

describe('dashboardSummary.redactFrom', () => {
  it('redacts local part, keeps domain', () => {
    expect(redactFrom('alice@example.com')).toBe('(skryto)@example.com')
    expect(redactFrom('jirka.novak@firma.cz')).toBe('(skryto)@firma.cz')
    expect(redactFrom('  ok+plus@seznam.cz')).toBe('(skryto)@seznam.cz')
  })

  it('returns (skryto) for empty / null / malformed', () => {
    expect(redactFrom(null)).toBe('(skryto)')
    expect(redactFrom(undefined)).toBe('(skryto)')
    expect(redactFrom('')).toBe('(skryto)')
    expect(redactFrom('no-at-sign')).toBe('(skryto)')
    expect(redactFrom('@only-domain')).toBe('(skryto)')
    expect(redactFrom('local@')).toBe('(skryto)')
  })

  it('handles non-string inputs', () => {
    expect(redactFrom(42)).toBe('(skryto)')
    expect(redactFrom({})).toBe('(skryto)')
    expect(redactFrom([])).toBe('(skryto)')
  })
})

describe('dashboardSummary internals', () => {
  it('exposes named thresholds (no magic numbers)', () => {
    expect(__internals.HOME_CAMPAIGN_ID).toBe(457)
    expect(__internals.RECENT_REPLY_PREVIEW_LIMIT).toBe(3)
    expect(__internals.TOP_NOTIFICATION_LIMIT).toBe(3)
    expect(__internals.CRITICAL_SEVERITIES).toBeInstanceOf(Set)
    expect(__internals.CRITICAL_SEVERITIES.has('critical')).toBe(true)
    expect(__internals.CRITICAL_SEVERITIES.has('high')).toBe(true)
    expect(__internals.CRITICAL_SEVERITIES.has('error')).toBe(true)
    expect(__internals.CRITICAL_SEVERITIES.has('info')).toBe(false)
  })
})
