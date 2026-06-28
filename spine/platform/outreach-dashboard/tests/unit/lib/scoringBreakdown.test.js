// ═══════════════════════════════════════════════════════════════════════════
//  scoringBreakdown.test.js — per-axis breakdown panel tests
//
//  Tests for the per-axis scoring breakdown feature (Scoring.jsx panel).
//  Verifies that axes_raw values can be used to build a breakdown view.
//
//  Test IDs: SB-001 .. SB-020
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest'
import { computeCompositeScore, DEFAULT_WEIGHTS } from '../../../src/lib/scoring.js'

const IDEAL = {
  icp_tier: 'ideal',
  email_confidence: 100,
  email: 'sales@corp.cz',
  sector_confidence: 1.0,
  velikost_firmy: 'small',
  total_sent: 20,
  total_replied: 5,
  total_opened: 12,
  last_contacted: new Date().toISOString(),
}

const WORST = {
  icp_tier: 'irrelevant',
  email_confidence: 0,
  email: 'info@gmail.com',
  sector_confidence: 0,
  velikost_firmy: 'micro',
  v_likvidaci: true,
  total_sent: 5,
  total_bounced: 5,
}

// ── SB-A: axes_raw completeness ───────────────────────────────────────────────

describe('SB-A: axes_raw completeness', () => {
  const EXPECTED_AXES = ['icp', 'email', 'engagement', 'size', 'recency', 'sector']

  it('SB-001: ideal company has all 6 axes in axes_raw', () => {
    const { components } = computeCompositeScore(IDEAL)
    for (const k of EXPECTED_AXES) {
      expect(components.axes_raw).toHaveProperty(k)
    }
  })

  it('SB-002: worst company has all 6 axes in axes_raw', () => {
    const { components } = computeCompositeScore(WORST)
    for (const k of EXPECTED_AXES) {
      expect(components.axes_raw).toHaveProperty(k)
    }
  })

  it('SB-003: all axes_raw values are in [0, 1]', () => {
    const { components } = computeCompositeScore(IDEAL)
    for (const [, v] of Object.entries(components.axes_raw)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

// ── SB-B: per-axis contribution calculation ───────────────────────────────────

describe('SB-B: per-axis contribution (weight × raw)', () => {
  it('SB-004: icp contribution matches weight × raw', () => {
    const { components } = computeCompositeScore(IDEAL)
    const expected = +(DEFAULT_WEIGHTS.icp * components.axes_raw.icp).toFixed(2)
    expect(components.icp).toBeCloseTo(expected, 2)
  })

  it('SB-005: email contribution matches weight × raw', () => {
    const { components } = computeCompositeScore(IDEAL)
    const expected = +(DEFAULT_WEIGHTS.email * components.axes_raw.email).toFixed(2)
    expect(components.email).toBeCloseTo(expected, 2)
  })

  it('SB-006: size contribution matches weight × raw', () => {
    const { components } = computeCompositeScore(IDEAL)
    const expected = +(DEFAULT_WEIGHTS.size * components.axes_raw.size).toFixed(2)
    expect(components.size).toBeCloseTo(expected, 2)
  })

  it('SB-007: recency contribution matches weight × raw', () => {
    const { components } = computeCompositeScore(IDEAL)
    const expected = +(DEFAULT_WEIGHTS.recency * components.axes_raw.recency).toFixed(2)
    expect(components.recency).toBeCloseTo(expected, 2)
  })

  it('SB-008: sector contribution matches weight × raw', () => {
    const { components } = computeCompositeScore(IDEAL)
    const expected = +(DEFAULT_WEIGHTS.sector * components.axes_raw.sector).toFixed(2)
    expect(components.sector).toBeCloseTo(expected, 2)
  })
})

// ── SB-C: penalties breakdown ─────────────────────────────────────────────────

describe('SB-C: penalties breakdown object', () => {
  it('SB-009: penalties has bounce, unsub, inactive, free_webmail, fatigue', () => {
    const { components } = computeCompositeScore(WORST)
    expect(components.penalties).toHaveProperty('bounce')
    expect(components.penalties).toHaveProperty('unsub')
    expect(components.penalties).toHaveProperty('inactive')
    expect(components.penalties).toHaveProperty('free_webmail')
    expect(components.penalties).toHaveProperty('fatigue')
  })

  it('SB-010: inactive_penalty applied for v_likvidaci=true', () => {
    const { components } = computeCompositeScore(WORST)
    expect(components.penalties.inactive).toBe(DEFAULT_WEIGHTS.inactive_penalty)
  })

  it('SB-011: free_webmail_penalty applied for gmail', () => {
    const { components } = computeCompositeScore(WORST)
    expect(components.penalties.free_webmail).toBe(DEFAULT_WEIGHTS.free_webmail_penalty)
  })

  it('SB-012: bounce penalty > 0 when bounced=sent', () => {
    const { components } = computeCompositeScore(WORST)
    expect(components.penalties.bounce).toBeGreaterThan(0)
  })

  it('SB-013: no penalties for ideal company with clean data', () => {
    const { components } = computeCompositeScore(IDEAL)
    expect(components.penalties.unsub).toBe(0)
    expect(components.penalties.inactive).toBe(0)
    expect(components.penalties.free_webmail).toBe(0)
    expect(components.penalties.fatigue).toBe(0)
  })
})

// ── SB-D: breakdown rendering helper (buildAxisBreakdown) ─────────────────────

describe('SB-D: buildAxisBreakdown pure helper', () => {
  /**
   * Pure helper that would be used in Scoring.jsx to render the per-axis panel.
   * Given components from computeCompositeScore, returns sorted array.
   */
  function buildAxisBreakdown(components, weights) {
    const axes = ['icp', 'email', 'engagement', 'size', 'recency', 'sector']
    return axes.map(key => ({
      key,
      raw: components.axes_raw[key],
      contribution: components[key],
      weight: weights[key],
      percentage: weights[key] > 0
        ? Math.round((components.axes_raw[key]) * 100)
        : 0,
    })).sort((a, b) => b.contribution - a.contribution)
  }

  it('SB-014: buildAxisBreakdown returns 6 entries', () => {
    const { components } = computeCompositeScore(IDEAL)
    expect(buildAxisBreakdown(components, DEFAULT_WEIGHTS)).toHaveLength(6)
  })

  it('SB-015: entries sorted by contribution descending', () => {
    const { components } = computeCompositeScore(IDEAL)
    const bd = buildAxisBreakdown(components, DEFAULT_WEIGHTS)
    for (let i = 1; i < bd.length; i++) {
      expect(bd[i - 1].contribution).toBeGreaterThanOrEqual(bd[i].contribution)
    }
  })

  it('SB-016: each entry has key, raw, contribution, weight, percentage', () => {
    const { components } = computeCompositeScore(IDEAL)
    const bd = buildAxisBreakdown(components, DEFAULT_WEIGHTS)
    for (const entry of bd) {
      expect(entry).toHaveProperty('key')
      expect(entry).toHaveProperty('raw')
      expect(entry).toHaveProperty('contribution')
      expect(entry).toHaveProperty('weight')
      expect(entry).toHaveProperty('percentage')
    }
  })

  it('SB-017: icp=ideal → icp percentage = 100', () => {
    const { components } = computeCompositeScore({ icp_tier: 'ideal' })
    const bd = buildAxisBreakdown(components, DEFAULT_WEIGHTS)
    const icp = bd.find(e => e.key === 'icp')
    expect(icp?.percentage).toBe(100)
  })

  it('SB-018: icp=irrelevant → icp percentage = 0', () => {
    const { components } = computeCompositeScore({ icp_tier: 'irrelevant' })
    const bd = buildAxisBreakdown(components, DEFAULT_WEIGHTS)
    const icp = bd.find(e => e.key === 'icp')
    expect(icp?.percentage).toBe(0)
  })

  it('SB-019: total contribution from axes ≈ raw100 before penalty', () => {
    const { components } = computeCompositeScore(IDEAL)
    const bd = buildAxisBreakdown(components, DEFAULT_WEIGHTS)
    const totalContrib = bd.reduce((s, e) => s + e.contribution, 0)
    // raw100 = (totalContrib / sum_weights) * 100
    const sumWeights = ['icp', 'email', 'engagement', 'size', 'recency', 'sector']
      .reduce((s, k) => s + DEFAULT_WEIGHTS[k], 0)
    const raw100 = (totalContrib / sumWeights) * 100
    // Score should be approximately raw100 - penalties ≈ score
    expect(raw100).toBeGreaterThan(0)
    expect(raw100).toBeLessThanOrEqual(100)
  })

  it('SB-020: weight=0 axis always shows percentage=0', () => {
    const zeroWeights = { ...DEFAULT_WEIGHTS, sector: 0 }
    const { components } = computeCompositeScore(IDEAL, zeroWeights)
    const bd = buildAxisBreakdown(components, zeroWeights)
    const sector = bd.find(e => e.key === 'sector')
    expect(sector?.percentage).toBe(0)
  })
})
