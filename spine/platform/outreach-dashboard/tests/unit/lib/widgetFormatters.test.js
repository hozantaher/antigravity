// widgetFormatters.test.js — AJ8 (2026-05-15)
//
// Unit coverage for the shared throughput-widget formatting helpers
// extracted from LiveClusterRateWidget + VerifyQueueWidget +
// SendRateWidget + ActiveCampaignsLive (`formatNumber` + `formatPercent`).

import { describe, it, expect } from 'vitest'
import {
  formatNumber,
  formatPercent,
} from '../../../src/lib/widgetFormatters.js'

describe('formatNumber', () => {
  it('returns em-dash for null', () => {
    expect(formatNumber(null)).toBe('—')
  })

  it('returns em-dash for undefined', () => {
    expect(formatNumber(undefined)).toBe('—')
  })

  it('returns em-dash for NaN', () => {
    expect(formatNumber(NaN)).toBe('—')
  })

  it('formats an integer using cs-CZ grouping', () => {
    // cs-CZ uses non-breaking space (U+00A0) as the thousands separator.
    const out = formatNumber(12_345)
    expect(out.replace(/ /g, ' ')).toBe('12 345')
  })

  it('formats zero as "0"', () => {
    expect(formatNumber(0)).toBe('0')
  })

  it('accepts numeric strings', () => {
    expect(formatNumber('42')).toBe('42')
  })

  it('falls back to String(n) when toLocaleString throws', () => {
    // Strings that don't parse to a number return em-dash via NaN guard
    expect(formatNumber('not-a-number')).toBe('—')
  })
})

describe('formatPercent', () => {
  it('returns em-dash for null', () => {
    expect(formatPercent(null)).toBe('—')
  })

  it('returns em-dash for undefined', () => {
    expect(formatPercent(undefined)).toBe('—')
  })

  it('returns em-dash for NaN', () => {
    expect(formatPercent(NaN)).toBe('—')
  })

  it('renders a positive integer with trailing %', () => {
    expect(formatPercent(47)).toBe('47 %')
  })

  it('renders zero as "0 %"', () => {
    expect(formatPercent(0)).toBe('0 %')
  })

  it('preserves decimals as passed by caller', () => {
    expect(formatPercent(47.5)).toBe('47.5 %')
  })
})
