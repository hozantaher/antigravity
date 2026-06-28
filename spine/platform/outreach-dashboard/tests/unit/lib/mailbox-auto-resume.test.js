// BF-A3 — runMailboxHealthCycleCron auto-resume decision tests.
// The cron in server.js wraps evaluateMailboxAutoResume in I/O.
// All branching (manual-reason guard, score floor, freshness) is here.

import { describe, it, expect } from 'vitest'
import { evaluateMailboxAutoResume } from '../../../src/lib/automation.js'

const NOW = new Date('2026-04-25T12:00:00Z')

describe('evaluateMailboxAutoResume — happy path', () => {
  it('paused, auto-reason, healthy + fresh score → resume', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused',
      status_reason: 'auto: 3 consecutive SMTP failures',
      last_score: 85,
      last_score_at: new Date(NOW.getTime() - 5 * 60 * 1000), // 5 min ago
    }, { now: NOW })
    expect(r.action).toBe('resume')
    expect(r.reason).toMatch(/85.*≥.*80/)
  })

  it('exact score floor (80) → resume (boundary inclusive)', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused',
      status_reason: 'auto: warmup-failed',
      last_score: 80,
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW })
    expect(r.action).toBe('resume')
  })
})

describe('evaluateMailboxAutoResume — guard conditions', () => {
  it('not paused → skip', () => {
    const r = evaluateMailboxAutoResume({
      status: 'active', status_reason: null, last_score: 90, last_score_at: NOW,
    }, { now: NOW })
    expect(r.action).toBe('skip')
    expect(r.reason).toMatch(/not paused/)
  })

  it('manual reason → skip (preserve operator intent)', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused',
      status_reason: 'manual: ops investigating',
      last_score: 95,
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW })
    expect(r.action).toBe('skip')
    expect(r.reason).toMatch(/not auto-paused/)
  })

  it('null status_reason → skip (defensive)', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused',
      status_reason: null,
      last_score: 95,
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW })
    expect(r.action).toBe('skip')
  })

  it('"auto" without colon → skip (strict prefix)', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused',
      status_reason: 'autoflag',
      last_score: 95,
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW })
    expect(r.action).toBe('skip')
  })

  it('null mailbox → skip', () => {
    expect(evaluateMailboxAutoResume(null).action).toBe('skip')
    expect(evaluateMailboxAutoResume(undefined).action).toBe('skip')
  })
})

describe('evaluateMailboxAutoResume — score boundary', () => {
  it('score 79 → skip (just below floor)', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 79,
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW })
    expect(r.action).toBe('skip')
    expect(r.reason).toMatch(/79 < floor 80/)
  })

  it('score null → skip', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: null,
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW })
    expect(r.action).toBe('skip')
  })

  it('custom scoreFloor (90) — score 85 now skipped', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 85,
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW, scoreFloor: 90 })
    expect(r.action).toBe('skip')
  })

  it('score as string "85" (PG numeric serialization) → resume', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: '85',
      last_score_at: new Date(NOW.getTime() - 1000),
    }, { now: NOW })
    expect(r.action).toBe('resume')
  })
})

describe('evaluateMailboxAutoResume — freshness boundary', () => {
  it('score 11 min old (default 10 min) → skip', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 95,
      last_score_at: new Date(NOW.getTime() - 11 * 60 * 1000),
    }, { now: NOW })
    expect(r.action).toBe('skip')
    expect(r.reason).toMatch(/stale.*min/)
  })

  it('score 9 min old → resume (within window)', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 95,
      last_score_at: new Date(NOW.getTime() - 9 * 60 * 1000),
    }, { now: NOW })
    expect(r.action).toBe('resume')
  })

  it('null last_score_at → skip', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 95,
      last_score_at: null,
    }, { now: NOW })
    expect(r.action).toBe('skip')
    expect(r.reason).toMatch(/last_score_at/)
  })

  it('invalid last_score_at string → skip (defensive parse)', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 95,
      last_score_at: 'not-a-date',
    }, { now: NOW })
    expect(r.action).toBe('skip')
    expect(r.reason).toMatch(/invalid/)
  })

  it('PG ISO string for last_score_at → resume', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 95,
      last_score_at: new Date(NOW.getTime() - 1000).toISOString(),
    }, { now: NOW })
    expect(r.action).toBe('resume')
  })

  it('custom freshnessMs (1 min) — 90s stale → skip', () => {
    const r = evaluateMailboxAutoResume({
      status: 'paused', status_reason: 'auto: x',
      last_score: 95,
      last_score_at: new Date(NOW.getTime() - 90 * 1000),
    }, { now: NOW, freshnessMs: 60_000 })
    expect(r.action).toBe('skip')
  })
})
