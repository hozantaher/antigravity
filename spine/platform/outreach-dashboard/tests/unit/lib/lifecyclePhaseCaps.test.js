// lifecyclePhaseCaps.test.js — AC2 (2026-05-14) + AJ10d (2026-05-16)
//
// Unit coverage for the phase cap lookup table + override semantics.
// Mirrors the DB `compute_phase_cap` SQL function (migration 116,
// operator-180 schedule per Sprint AG1.5).

import { describe, it, expect } from 'vitest'
import {
  PHASE_CAPS,
  PHASE_ORDER,
  PHASE_THRESHOLD_DAYS,
  DEFAULT_PHASE_CAP,
  capForPhase,
  nextPhase,
  resolveEffectiveCap,
  nextPhaseAdvanceAt,
} from '../../../src/lib/lifecyclePhaseCaps.js'

describe('PHASE_CAPS / capForPhase', () => {
  it('warmup_d0 → 10/day', () => {
    expect(PHASE_CAPS.warmup_d0).toBe(10)
    expect(capForPhase('warmup_d0')).toBe(10)
  })

  it('warmup_d3 → 30/day', () => {
    expect(PHASE_CAPS.warmup_d3).toBe(30)
    expect(capForPhase('warmup_d3')).toBe(30)
  })

  it('warmup_d7 → 70/day', () => {
    expect(PHASE_CAPS.warmup_d7).toBe(70)
    expect(capForPhase('warmup_d7')).toBe(70)
  })

  it('warmup_d14 → 120/day', () => {
    expect(PHASE_CAPS.warmup_d14).toBe(120)
    expect(capForPhase('warmup_d14')).toBe(120)
  })

  it('production → 180/day', () => {
    expect(PHASE_CAPS.production).toBe(180)
    expect(capForPhase('production')).toBe(180)
  })

  it('unknown phase → conservative default (warmup_d0 cap)', () => {
    expect(capForPhase('warmup_d999')).toBe(DEFAULT_PHASE_CAP)
    expect(capForPhase('')).toBe(DEFAULT_PHASE_CAP)
    expect(capForPhase(null)).toBe(DEFAULT_PHASE_CAP)
    expect(capForPhase(undefined)).toBe(DEFAULT_PHASE_CAP)
  })

  it('non-string input returns the default (no crash)', () => {
    expect(capForPhase(5)).toBe(DEFAULT_PHASE_CAP)
    expect(capForPhase({})).toBe(DEFAULT_PHASE_CAP)
  })
})

describe('PHASE_ORDER + nextPhase', () => {
  it('PHASE_ORDER lists the 5 known phases in warm-up sequence', () => {
    expect(PHASE_ORDER).toEqual(['warmup_d0', 'warmup_d3', 'warmup_d7', 'warmup_d14', 'production'])
  })

  it('warmup_d0 → warmup_d3', () => {
    expect(nextPhase('warmup_d0')).toBe('warmup_d3')
  })

  it('warmup_d14 → production', () => {
    expect(nextPhase('warmup_d14')).toBe('production')
  })

  it('production has no next phase (terminal)', () => {
    expect(nextPhase('production')).toBeNull()
  })

  it('unknown phase → null', () => {
    expect(nextPhase('warmup_d999')).toBeNull()
    expect(nextPhase(null)).toBeNull()
    expect(nextPhase(undefined)).toBeNull()
  })
})

describe('PHASE_THRESHOLD_DAYS', () => {
  it('mirrors the SQL advance_lifecycle_phase() day cutoffs', () => {
    expect(PHASE_THRESHOLD_DAYS.warmup_d0).toBe(0)
    expect(PHASE_THRESHOLD_DAYS.warmup_d3).toBe(3)
    expect(PHASE_THRESHOLD_DAYS.warmup_d7).toBe(7)
    expect(PHASE_THRESHOLD_DAYS.warmup_d14).toBe(14)
    expect(PHASE_THRESHOLD_DAYS.production).toBe(30)
  })
})

describe('resolveEffectiveCap', () => {
  it('no override → phase cap from lifecycle_phase', () => {
    const r = resolveEffectiveCap('warmup_d0', null)
    expect(r).toEqual({ phase_cap: 10, effective_cap: 10, cap_source: 'lifecycle_phase' })
  })

  it('override LOWER than phase cap → override wins, source=daily_cap_override', () => {
    const r = resolveEffectiveCap('production', 50)
    expect(r).toEqual({ phase_cap: 180, effective_cap: 50, cap_source: 'daily_cap_override' })
  })

  it('override HIGHER than phase cap → phase cap wins (override only lowers)', () => {
    const r = resolveEffectiveCap('warmup_d0', 999)
    expect(r).toEqual({ phase_cap: 10, effective_cap: 10, cap_source: 'lifecycle_phase' })
  })

  it('override = phase cap → phase cap (source still lifecycle_phase)', () => {
    const r = resolveEffectiveCap('warmup_d7', 70)
    expect(r).toEqual({ phase_cap: 70, effective_cap: 70, cap_source: 'lifecycle_phase' })
  })

  it('override = 0 (sentinel) → ignored, treated as null', () => {
    const r = resolveEffectiveCap('warmup_d3', 0)
    expect(r).toEqual({ phase_cap: 30, effective_cap: 30, cap_source: 'lifecycle_phase' })
  })

  it('override = NaN-y → ignored', () => {
    const r = resolveEffectiveCap('warmup_d3', 'abc')
    expect(r.effective_cap).toBe(30)
    expect(r.cap_source).toBe('lifecycle_phase')
  })

  it('unknown phase falls back to default but still respects override', () => {
    const r = resolveEffectiveCap('warmup_d999', 3)
    expect(r.effective_cap).toBe(3)
    expect(r.cap_source).toBe('daily_cap_override')
  })
})

describe('nextPhaseAdvanceAt', () => {
  it('production phase → null (terminal)', () => {
    const now = new Date('2026-05-14T10:00:00Z')
    expect(nextPhaseAdvanceAt('2026-04-01T10:00:00Z', 'production', now)).toBeNull()
  })

  it('null created_at → null', () => {
    const now = new Date('2026-05-14T10:00:00Z')
    expect(nextPhaseAdvanceAt(null, 'warmup_d0', now)).toBeNull()
    expect(nextPhaseAdvanceAt(undefined, 'warmup_d0', now)).toBeNull()
  })

  it('invalid created_at → null', () => {
    const now = new Date('2026-05-14T10:00:00Z')
    expect(nextPhaseAdvanceAt('not a date', 'warmup_d0', now)).toBeNull()
  })

  it('warmup_d0 row just created → next advance ≈ created_at + 3 days at 03:00 Prague', () => {
    // Created 2026-05-14 10:00 UTC. warmup_d3 threshold = 3 days.
    // Eligible at 2026-05-17 10:00 UTC. Next 03:00 Prague after that =
    // 2026-05-18 01:00 UTC (CEST, +0200 → 03:00 Prague).
    const now = new Date('2026-05-14T10:00:00Z')
    const result = nextPhaseAdvanceAt('2026-05-14T10:00:00Z', 'warmup_d0', now)
    expect(result).not.toBeNull()
    // Prague-formatted hour MUST be 03.
    const hourInPrague = result.toLocaleString('en-US', {
      timeZone: 'Europe/Prague', hour: '2-digit', hour12: false,
    })
    expect(hourInPrague).toBe('03')
    // Date should be after eligibleAt.
    expect(result.getTime()).toBeGreaterThan(new Date('2026-05-17T10:00:00Z').getTime())
  })

  it('warmup_d14 row mid-cycle → returns instant >= now', () => {
    const now = new Date('2026-05-14T10:00:00Z')
    // Created 30 days ago at 10:00. warmup_d14→production threshold = 30d.
    const created = new Date(now.getTime() - 25 * 24 * 60 * 60 * 1000)
    const result = nextPhaseAdvanceAt(created.toISOString(), 'warmup_d14', now)
    expect(result).not.toBeNull()
    expect(result.getTime()).toBeGreaterThanOrEqual(now.getTime())
  })
})
