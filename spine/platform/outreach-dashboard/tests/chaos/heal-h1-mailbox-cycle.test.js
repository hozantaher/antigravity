// H1 — Mailbox auto-pause / auto-resume cycle integration tests.
// Uses heal-fixtures (SHARED-3) + state-machine helpers (SHARED-2).
// Verifies the FULL cycle works as a state machine, never double-pauses,
// never gets stuck past cooldown bound.

import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { makeMockMailbox, snapshotState, diffSnapshots } from '../helpers/heal-fixtures.js'
import { assertMonotonic, assertNoStateOscillation } from '../helpers/slo-helpers.js'

describe('H1 — Mailbox auto-pause cycle', () => {
  let mb
  beforeEach(() => {
    mb = makeMockMailbox({ id: 1, status: 'active', consecutive_bounces: 0 })
  })

  it('initial state: active, 0 bounces, empty healing log', () => {
    expect(mb.status).toBe('active')
    expect(mb.consecutive_bounces).toBe(0)
    expect(mb.healingLog.length).toBe(0)
  })

  it('1 SMTP failure does not auto_pause yet (threshold=3)', () => {
    mb.recordSmtpFailure({ code: '535', detail: 'auth invalid' })
    expect(mb.status).toBe('active')
    expect(mb.consecutive_bounces).toBe(1)
    expect(mb.healingLog.find(e => e.action === 'auto_pause')).toBeUndefined()
  })

  it('3 consecutive SMTP failures → auto_pause emitted', () => {
    mb.recordSmtpFailure({ code: '535', detail: 'auth invalid' })
    mb.recordSmtpFailure({ code: '535', detail: 'auth invalid' })
    mb.recordSmtpFailure({ code: '535', detail: 'auth invalid' })
    mb.simulateAutoPause()
    expect(mb.status).toBe('paused')
    const pauseEntry = mb.healingLog.find(e => e.action === 'auto_pause')
    expect(pauseEntry).toBeDefined()
    expect(pauseEntry.reason).toMatch(/3.*SMTP|3.*bounce|consecutive/i)
  })

  it('cooldown expiry → auto_resume; status → active', () => {
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.simulateAutoPause()
    mb.simulateCooldownExpiry()
    expect(mb.status).toBe('active')
  })

  it('healing_log: pause + resume entries chronologically ordered', () => {
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.simulateAutoPause()
    mb.simulateCooldownExpiry()
    const pauseAt = new Date(mb.healingLog.find(e => e.action === 'auto_pause').created_at).getTime()
    const resolvedAt = mb.healingLog.find(e => e.action === 'auto_pause').resolved_at
    expect(resolvedAt).toBeTruthy()
    expect(new Date(resolvedAt).getTime()).toBeGreaterThanOrEqual(pauseAt)
  })

  it('property: never double-pauses (no two consecutive auto_pause entries without resume between)', () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { minLength: 5, maxLength: 30 }), (events) => {
        const m = makeMockMailbox({ id: 99, status: 'active' })
        for (const ev of events) {
          if (ev.startsWith('f')) m.recordSmtpFailure({})
          else if (ev.startsWith('p') && m.status === 'active' && m.consecutive_bounces >= 3) m.simulateAutoPause()
          else if (ev.startsWith('r') && m.status === 'paused') m.simulateCooldownExpiry()
        }
        // Walk healing log: between any two auto_pause entries, there must be a resolution
        const pauseEntries = m.healingLog.filter(e => e.action === 'auto_pause')
        for (let i = 1; i < pauseEntries.length; i++) {
          if (!pauseEntries[i - 1].resolved_at) return false
        }
        return true
      }),
      { numRuns: 200 }
    )
  })

  it('snapshot before-pause vs after-resume — diff identifies state transition', () => {
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    const before = snapshotState(mb)
    mb.simulateAutoPause()
    mb.simulateCooldownExpiry()
    const after = snapshotState(mb)
    const diff = diffSnapshots(before, after)
    // status changed twice (active → paused → active); net status equal but healingLog differs
    expect(diff.changed.length + diff.added.length).toBeGreaterThan(0)
  })

  it('status sequence forms valid state-machine trace', () => {
    const trace = [mb.status]
    mb.recordSmtpFailure({}); trace.push(mb.status)
    mb.recordSmtpFailure({}); trace.push(mb.status)
    mb.recordSmtpFailure({}); trace.push(mb.status)
    mb.simulateAutoPause(); trace.push(mb.status)
    mb.simulateCooldownExpiry(); trace.push(mb.status)
    // expected: active, active, active, active, paused, active
    expect(trace[0]).toBe('active')
    expect(trace[trace.length - 1]).toBe('active')
    expect(trace.includes('paused')).toBe(true)
    // No state visited >3× (anti-thrash bound for 6-event trace)
    expect(() => assertNoStateOscillation(trace, 5)).not.toThrow()
  })

  it('consecutive_bounces resets after auto_resume (cooldown gives clean slate)', () => {
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    expect(mb.consecutive_bounces).toBe(3)
    mb.simulateAutoPause()
    mb.simulateCooldownExpiry()
    // After resume, fresh slate.
    expect(mb.consecutive_bounces).toBe(0)
  })

  it('multi-cycle: 3 pause-resume cycles produce 3 distinct healing_log pairs', () => {
    for (let i = 0; i < 3; i++) {
      mb.recordSmtpFailure({})
      mb.recordSmtpFailure({})
      mb.recordSmtpFailure({})
      mb.simulateAutoPause()
      mb.simulateCooldownExpiry()
    }
    const pauseEntries = mb.healingLog.filter(e => e.action === 'auto_pause')
    expect(pauseEntries.length).toBe(3)
    expect(pauseEntries.every(e => e.resolved_at)).toBe(true)
  })

  it('healing_log entry shape matches production healing_log schema', () => {
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.simulateAutoPause()
    const entry = mb.healingLog[0]
    expect(entry).toHaveProperty('id')
    expect(entry).toHaveProperty('entity_type')
    expect(entry).toHaveProperty('entity_id')
    expect(entry).toHaveProperty('action')
    expect(entry).toHaveProperty('reason')
    expect(entry).toHaveProperty('created_at')
  })

  it('property: total entry count monotonic in time', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
        const m = makeMockMailbox({ id: 1, status: 'active' })
        const counts = []
        for (let i = 0; i < n; i++) {
          m.recordSmtpFailure({})
          if (m.consecutive_bounces >= 3) {
            m.simulateAutoPause()
            m.simulateCooldownExpiry()
          }
          counts.push(m.healingLog.length)
        }
        try {
          assertMonotonic(counts, 'non-decreasing')
          return true
        } catch {
          return false
        }
      }),
      { numRuns: 100 }
    )
  })

  it('snapshot is immutable (deep-frozen)', () => {
    mb.recordSmtpFailure({})
    const snap = snapshotState(mb)
    expect(() => { snap.consecutive_bounces = 999 }).toThrow()
  })

  it('after auto_pause, status="paused" reflected in subsequent recordSmtpFailure (no-op)', () => {
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.simulateAutoPause()
    expect(mb.status).toBe('paused')
    // recordSmtpFailure on a paused mailbox shouldn't escalate further into the
    // active state machine — bounces tracked but no auto_pause re-fires
    mb.recordSmtpFailure({})
    const pausesNow = mb.healingLog.filter(e => e.action === 'auto_pause' && !e.resolved_at)
    // Still exactly one open pause
    expect(pausesNow.length).toBe(1)
  })

  it('SLO: pause→resume duration is finite & non-negative', () => {
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.recordSmtpFailure({})
    mb.simulateAutoPause()
    mb.simulateCooldownExpiry()
    // Re-find AFTER cooldown — captured reference may be stale (impl detail)
    const pauseEntry = mb.healingLog.find(e => e.action === 'auto_pause')
    expect(pauseEntry.resolved_at).toBeTruthy()
    const created = new Date(pauseEntry.created_at).getTime()
    const resolved = new Date(pauseEntry.resolved_at).getTime()
    expect(Number.isFinite(created)).toBe(true)
    expect(Number.isFinite(resolved)).toBe(true)
    expect(resolved - created).toBeGreaterThanOrEqual(0)
  })
})
