// AM2 — pure helper unit tests for contact verify cron.
// Tests: classifyContactStatus, computeContactNextVerifyAt, computeContactRetryAt
// from src/lib/automation.js.
//
// All tests are pure — no DB, no network.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  classifyContactStatus,
  computeContactNextVerifyAt,
  computeContactRetryAt,
} from '../../../src/lib/automation.js'

// ── classifyContactStatus ────────────────────────────────────────────────────

describe('classifyContactStatus — direct status passthrough', () => {
  it('valid → valid', () => {
    expect(classifyContactStatus({ status: 'valid' })).toBe('valid')
  })
  it('invalid → invalid', () => {
    expect(classifyContactStatus({ status: 'invalid' })).toBe('invalid')
  })
  it('spamtrap → spamtrap', () => {
    expect(classifyContactStatus({ status: 'spamtrap' })).toBe('spamtrap')
  })
  it('role_only → role_only', () => {
    expect(classifyContactStatus({ status: 'role_only' })).toBe('role_only')
  })
  it('catch_all → catch_all', () => {
    expect(classifyContactStatus({ status: 'catch_all' })).toBe('catch_all')
  })
  it('risky → risky', () => {
    expect(classifyContactStatus({ status: 'risky' })).toBe('risky')
  })
})

describe('classifyContactStatus — fallback/edge cases', () => {
  it('unverified result → risky (probe gave up without conclusion)', () => {
    expect(classifyContactStatus({ status: 'unverified' })).toBe('risky')
  })
  it('unknown status → risky', () => {
    expect(classifyContactStatus({ status: 'something_weird' })).toBe('risky')
  })
  it('null result → risky (defensive)', () => {
    expect(classifyContactStatus(null)).toBe('risky')
  })
  it('undefined result → risky (defensive)', () => {
    expect(classifyContactStatus(undefined)).toBe('risky')
  })
  it('status case-insensitive — VALID → valid', () => {
    expect(classifyContactStatus({ status: 'VALID' })).toBe('valid')
  })
})

// ── computeContactRetryAt ────────────────────────────────────────────────────

describe('computeContactRetryAt — backoff schedule', () => {
  const HOUR = 60 * 60 * 1000
  const DAY  = 24 * HOUR

  it('attempt 1 → ~1h from now', () => {
    const before = Date.now()
    const d = computeContactRetryAt(1)
    const after = Date.now()
    expect(d).toBeInstanceOf(Date)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + HOUR - 100)
    expect(d.getTime()).toBeLessThanOrEqual(after + HOUR + 100)
  })
  it('attempt 2 → ~6h from now', () => {
    const before = Date.now()
    const d = computeContactRetryAt(2)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + 6 * HOUR - 100)
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 6 * HOUR + 100)
  })
  it('attempt 3 → ~24h from now', () => {
    const before = Date.now()
    const d = computeContactRetryAt(3)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + DAY - 100)
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + DAY + 100)
  })
  it('attempt 4 → ~7d from now', () => {
    const before = Date.now()
    const d = computeContactRetryAt(4)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY - 100)
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 7 * DAY + 100)
  })
  it('attempt 5 → null (give up)', () => {
    expect(computeContactRetryAt(5)).toBeNull()
  })
  it('attempt 6+ → null (give up)', () => {
    expect(computeContactRetryAt(6)).toBeNull()
    expect(computeContactRetryAt(100)).toBeNull()
  })
})

// ── computeContactNextVerifyAt ───────────────────────────────────────────────

describe('computeContactNextVerifyAt — scheduling per status', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('valid → ~90 days', () => {
    const before = Date.now()
    const d = computeContactNextVerifyAt('valid', 1)
    expect(d).toBeInstanceOf(Date)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + 90 * DAY - 1000)
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 90 * DAY + 1000)
  })
  it('role_only → ~180 days', () => {
    const before = Date.now()
    const d = computeContactNextVerifyAt('role_only', 1)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + 180 * DAY - 1000)
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 180 * DAY + 1000)
  })
  it('catch_all → ~90 days', () => {
    const before = Date.now()
    const d = computeContactNextVerifyAt('catch_all', 1)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + 90 * DAY - 1000)
    expect(d.getTime()).toBeLessThanOrEqual(Date.now() + 90 * DAY + 1000)
  })
  it('invalid → null (never reverify)', () => {
    expect(computeContactNextVerifyAt('invalid', 1)).toBeNull()
    expect(computeContactNextVerifyAt('invalid', 99)).toBeNull()
  })
  it('spamtrap → null (never reverify)', () => {
    expect(computeContactNextVerifyAt('spamtrap', 1)).toBeNull()
  })
  it('risky attempt 1 → ~1h (backoff)', () => {
    const before = Date.now()
    const d = computeContactNextVerifyAt('risky', 1)
    expect(d).toBeInstanceOf(Date)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 1000)
  })
  it('risky attempt 4 → ~7d (backoff)', () => {
    const before = Date.now()
    const d = computeContactNextVerifyAt('risky', 4)
    expect(d.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY - 1000)
  })
  it('risky attempt 5 → null (give up — caller marks invalid)', () => {
    expect(computeContactNextVerifyAt('risky', 5)).toBeNull()
  })
})
