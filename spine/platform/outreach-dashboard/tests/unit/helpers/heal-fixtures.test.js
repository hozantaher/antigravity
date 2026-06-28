// Self-healing fixtures — vitest cases.
// TDD: these tests were authored BEFORE heal-fixtures.js implementation.
//
// Covers:
// - makeMockMailbox: initial state, recordSmtpFailure, auto_pause + cooldown + resume
// - makeMockCron: tick advances heartbeat, injectError + recovery, consecutiveErrors
// - makeMockEngine: run dispatches, injectPanic + restart, breaker reset
// - snapshot/diff: deepFreeze, immutability, diff identifies changes
// - cross-fixture: mailbox + cron + engine as a mini system

import { describe, it, expect } from 'vitest'
import {
  makeMockMailbox,
  makeMockCron,
  makeMockEngine,
  snapshotState,
  diffSnapshots,
} from '../../helpers/heal-fixtures.js'

describe('makeMockMailbox', () => {
  it('produces a mailbox with sane defaults that mirror production shape', () => {
    const mb = makeMockMailbox({ id: 3 })
    expect(mb.id).toBe(3)
    expect(mb.status).toBe('active')
    expect(mb.consecutive_bounces).toBe(0)
    expect(mb.daily_cap).toBe(100)
    expect(mb.healingLog).toEqual([])
    expect(typeof mb.email).toBe('string')
  })

  it('honors overrides for id, status, consecutive_bounces, daily_cap', () => {
    const mb = makeMockMailbox({
      id: 7,
      status: 'paused',
      consecutive_bounces: 2,
      daily_cap: 250,
      email: 'custom@firma.cz',
    })
    expect(mb.id).toBe(7)
    expect(mb.status).toBe('paused')
    expect(mb.consecutive_bounces).toBe(2)
    expect(mb.daily_cap).toBe(250)
    expect(mb.email).toBe('custom@firma.cz')
  })

  it('recordSmtpFailure increments consecutive_bounces and appends a healing_log entry', () => {
    const fakeNow = () => new Date('2026-04-26T10:00:00.000Z')
    const mb = makeMockMailbox({ id: 3, fakeNow })
    mb.recordSmtpFailure({ code: '535', detail: 'auth invalid' })
    expect(mb.consecutive_bounces).toBe(1)
    expect(mb.healingLog).toHaveLength(1)
    const evt = mb.healingLog[0]
    // healing_log production schema: id, entity_type, entity_id, entity_label,
    // action, reason, resolved_at, created_at.
    expect(Object.keys(evt).sort()).toEqual(
      ['action', 'created_at', 'entity_id', 'entity_label', 'entity_type', 'id', 'reason', 'resolved_at'].sort()
    )
    expect(evt.entity_type).toBe('mailbox')
    expect(evt.entity_id).toBe(3)
    expect(evt.action).toBe('smtp_failure')
    expect(evt.reason).toContain('535')
    expect(evt.resolved_at).toBeNull()
    expect(evt.created_at).toBe('2026-04-26T10:00:00.000Z')
  })

  it('simulateAutoPause sets status=paused and logs auto_pause action', () => {
    const mb = makeMockMailbox({ id: 3 })
    mb.recordSmtpFailure({ code: '535', detail: 'a' })
    mb.recordSmtpFailure({ code: '535', detail: 'b' })
    mb.recordSmtpFailure({ code: '535', detail: 'c' })
    mb.simulateAutoPause()
    expect(mb.status).toBe('paused')
    const pauseEntry = mb.healingLog.find(e => e.action === 'auto_pause')
    expect(pauseEntry).toBeDefined()
    expect(pauseEntry.entity_type).toBe('mailbox')
    expect(pauseEntry.entity_id).toBe(3)
    expect(pauseEntry.reason).toContain('SMTP')
  })

  it('simulateCooldownExpiry resumes a paused mailbox and resets bounce counter', () => {
    const mb = makeMockMailbox({ id: 3, consecutive_bounces: 3 })
    mb.simulateAutoPause()
    expect(mb.status).toBe('paused')
    mb.simulateCooldownExpiry()
    expect(mb.status).toBe('active')
    expect(mb.consecutive_bounces).toBe(0)
    const resume = mb.healingLog.find(e => e.action === 'cooldown_resume')
    expect(resume).toBeDefined()
    // cooldown_resume should mark the prior auto_pause as resolved
    const pauseEntry = mb.healingLog.find(e => e.action === 'auto_pause')
    expect(pauseEntry.resolved_at).not.toBeNull()
  })

  it('snapshot returns a deeply frozen, immutable point-in-time copy', () => {
    const mb = makeMockMailbox({ id: 3 })
    mb.recordSmtpFailure({ code: '550', detail: 'mailbox not found' })
    const snap = mb.snapshot()
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.healingLog)).toBe(true)
    if (snap.healingLog.length > 0) expect(Object.isFrozen(snap.healingLog[0])).toBe(true)
    // Mutating live mailbox does NOT affect snapshot.
    mb.recordSmtpFailure({ code: '550', detail: 'again' })
    expect(snap.consecutive_bounces).toBe(1)
    expect(mb.consecutive_bounces).toBe(2)
  })
})

describe('makeMockCron', () => {
  it('produces a cron with name, interval, and zeroed heartbeat counters', () => {
    const cron = makeMockCron({ name: 'fullCheck', interval_ms: 12 * 60 * 1000 })
    const hb = cron.heartbeat()
    expect(cron.name).toBe('fullCheck')
    expect(cron.interval_ms).toBe(12 * 60 * 1000)
    expect(hb.lastSuccessAt).toBeNull()
    expect(hb.lastErrorAt).toBeNull()
    expect(hb.consecutiveErrors).toBe(0)
  })

  it('tick invokes the callback and advances lastSuccessAt', () => {
    let runs = 0
    const fakeNow = () => new Date('2026-04-26T11:00:00.000Z')
    const cron = makeMockCron({
      name: 'noop',
      interval_ms: 60_000,
      callback: () => { runs += 1 },
      fakeNow,
    })
    cron.tick()
    expect(runs).toBe(1)
    const hb = cron.heartbeat()
    expect(hb.lastSuccessAt).toBe('2026-04-26T11:00:00.000Z')
    expect(hb.consecutiveErrors).toBe(0)
  })

  it('injectError + tick records error, increments consecutiveErrors, but does NOT throw (guard recovers)', () => {
    const cron = makeMockCron({ name: 'guardian', interval_ms: 1000 })
    cron.injectError(new Error('boom'))
    expect(() => cron.tick()).not.toThrow()
    const hb = cron.heartbeat()
    expect(hb.consecutiveErrors).toBe(1)
    expect(hb.lastErrorAt).not.toBeNull()
  })

  it('a successful tick after an error resets consecutiveErrors to 0', () => {
    const cron = makeMockCron({ name: 'recovery', interval_ms: 1000 })
    cron.injectError(new Error('first'))
    cron.tick() // error path
    cron.injectError(new Error('second'))
    cron.tick() // error path again — counter rises
    expect(cron.heartbeat().consecutiveErrors).toBe(2)
    cron.tick() // success — counter resets
    expect(cron.heartbeat().consecutiveErrors).toBe(0)
    expect(cron.heartbeat().lastSuccessAt).not.toBeNull()
  })
})

describe('makeMockEngine', () => {
  it('engine exposes mailboxes and an "ok" health by default', () => {
    const mb = makeMockMailbox({ id: 3 })
    const eng = makeMockEngine({ mailboxes: [mb] })
    expect(eng.health.status).toBe('ok')
    expect(eng.mailboxes).toHaveLength(1)
    expect(eng.mailboxes[0].id).toBe(3)
  })

  it('run() dispatches one batch and refreshes last_seen_at', () => {
    const mb = makeMockMailbox({ id: 3 })
    const eng = makeMockEngine({ mailboxes: [mb] })
    const before = eng.health.last_seen_at
    eng.run()
    const after = eng.health.last_seen_at
    expect(after).not.toBe(before)
    expect(eng.dispatchedBatches).toBe(1)
  })

  it('injectPanic flips health to "down" then supervisor restart returns it to "ok" with breaker reset', () => {
    const mb = makeMockMailbox({ id: 3 })
    const eng = makeMockEngine({ mailboxes: [mb] })
    eng.injectPanic()
    expect(eng.health.status).toBe('down')
    expect(eng.daemonErrors).toBeGreaterThan(0)
    eng.supervisorRestart()
    expect(eng.health.status).toBe('ok')
    expect(eng.breakerOpen).toBe(false)
  })

  it('repeated panics increment daemonErrors monotonically', () => {
    const eng = makeMockEngine({ mailboxes: [makeMockMailbox({ id: 1 })] })
    eng.injectPanic()
    eng.supervisorRestart()
    eng.injectPanic()
    expect(eng.daemonErrors).toBe(2)
  })
})

describe('snapshotState / diffSnapshots', () => {
  it('snapshotState returns a deeply frozen JSON-compatible structure', () => {
    const mb = makeMockMailbox({ id: 3 })
    const snap = snapshotState(mb)
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.healingLog)).toBe(true)
    expect(() => { snap.status = 'mutated' }).toThrow()
  })

  it('snapshot is independent of live state', () => {
    const mb = makeMockMailbox({ id: 3 })
    const snap = snapshotState(mb)
    mb.recordSmtpFailure({ code: '535', detail: 'x' })
    expect(snap.consecutive_bounces).toBe(0)
    expect(mb.consecutive_bounces).toBe(1)
  })

  it('diffSnapshots reports added healingLog entries and changed counters', () => {
    const mb = makeMockMailbox({ id: 3 })
    const s1 = snapshotState(mb)
    mb.recordSmtpFailure({ code: '535', detail: 'auth' })
    const s2 = snapshotState(mb)
    const d = diffSnapshots(s1, s2)
    expect(d.changed.some(c => c.path === 'consecutive_bounces')).toBe(true)
    expect(d.added.length).toBeGreaterThan(0)
  })

  it('diffSnapshots returns empty added/removed/changed for identical snapshots', () => {
    const mb = makeMockMailbox({ id: 3 })
    const s1 = snapshotState(mb)
    const s2 = snapshotState(mb)
    const d = diffSnapshots(s1, s2)
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toEqual([])
  })
})

describe('cross-fixture composition', () => {
  it('mailbox + cron + engine compose into a "mini-system" recording a full incident', () => {
    const mb = makeMockMailbox({ id: 3 })
    const eng = makeMockEngine({ mailboxes: [mb] })
    const cron = makeMockCron({
      name: 'engineRunner',
      interval_ms: 60_000,
      callback: () => eng.run(),
    })
    cron.tick()
    cron.tick()
    expect(eng.dispatchedBatches).toBe(2)
    expect(cron.heartbeat().consecutiveErrors).toBe(0)
  })

  it('panic in engine surfaces in healing_log via mailbox auto_pause when wired', () => {
    const mb = makeMockMailbox({ id: 3 })
    const eng = makeMockEngine({ mailboxes: [mb] })
    mb.recordSmtpFailure({ code: '535', detail: 'a' })
    mb.recordSmtpFailure({ code: '535', detail: 'b' })
    mb.recordSmtpFailure({ code: '535', detail: 'c' })
    mb.simulateAutoPause()
    eng.injectPanic()
    expect(mb.status).toBe('paused')
    expect(eng.health.status).toBe('down')
    const pauseEntry = mb.healingLog.find(e => e.action === 'auto_pause')
    expect(pauseEntry.entity_id).toBe(3)
  })

  it('snapshot before/after a full failure→pause→resume cycle yields three diffable points', () => {
    const mb = makeMockMailbox({ id: 3 })
    const s0 = snapshotState(mb)
    mb.recordSmtpFailure({ code: '535', detail: 'a' })
    mb.recordSmtpFailure({ code: '535', detail: 'b' })
    mb.recordSmtpFailure({ code: '535', detail: 'c' })
    mb.simulateAutoPause()
    const s1 = snapshotState(mb)
    mb.simulateCooldownExpiry()
    const s2 = snapshotState(mb)
    const d01 = diffSnapshots(s0, s1)
    const d12 = diffSnapshots(s1, s2)
    expect(d01.changed.some(c => c.path === 'status')).toBe(true)
    expect(d12.changed.some(c => c.path === 'status')).toBe(true)
    // Three independent snapshots, each frozen
    expect(Object.isFrozen(s0)).toBe(true)
    expect(Object.isFrozen(s1)).toBe(true)
    expect(Object.isFrozen(s2)).toBe(true)
  })
})
