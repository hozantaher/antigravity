// BF-A2 — runGreylistRetryCron pure-decision unit tests.
// The full crons in server.js are I/O orchestration. The branching logic
// (give-up vs retry; clear vs resolve_other vs still_greylisted) lives
// in pure fns: evaluateGreylistQueueItem + evaluateMailboxGreylistResult.

import { describe, it, expect } from 'vitest'
import {
  evaluateGreylistQueueItem,
  evaluateMailboxGreylistResult,
} from '../../../src/lib/automation.js'

describe('evaluateGreylistQueueItem — give-up vs retry', () => {
  it('attempts=0, max=10 → retry (fresh entry)', () => {
    const r = evaluateGreylistQueueItem({ attempts: 0, maxAttempts: 10 })
    expect(r.action).toBe('retry')
    expect(r.reason).toMatch(/0 < max 10/)
  })

  it('attempts=9, max=10 → retry (one attempt left)', () => {
    const r = evaluateGreylistQueueItem({ attempts: 9, maxAttempts: 10 })
    expect(r.action).toBe('retry')
  })

  it('attempts=10, max=10 → give_up (boundary, strict >=)', () => {
    const r = evaluateGreylistQueueItem({ attempts: 10, maxAttempts: 10 })
    expect(r.action).toBe('give_up')
    expect(r.reason).toMatch(/10 >= max 10/)
  })

  it('attempts=11, max=10 → give_up (overshoot)', () => {
    const r = evaluateGreylistQueueItem({ attempts: 11, maxAttempts: 10 })
    expect(r.action).toBe('give_up')
  })

  it('attempts=null/undefined → treated as 0 → retry', () => {
    expect(evaluateGreylistQueueItem({ attempts: null, maxAttempts: 5 }).action).toBe('retry')
    expect(evaluateGreylistQueueItem({ attempts: undefined, maxAttempts: 5 }).action).toBe('retry')
  })

  it('attempts as string (DB JSON serialization) → coerced', () => {
    const r = evaluateGreylistQueueItem({ attempts: '7', maxAttempts: 5 })
    expect(r.action).toBe('give_up') // 7 >= 5
  })

  it('maxAttempts<1 (misconfig) → defaults to retry, not give-up', () => {
    // Defensive: never silently drop work because of a bad env var.
    const r = evaluateGreylistQueueItem({ attempts: 100, maxAttempts: 0 })
    expect(r.action).toBe('retry')
    expect(r.reason).toMatch(/invalid maxAttempts/)
  })

  it('maxAttempts=NaN → retry (defensive)', () => {
    const r = evaluateGreylistQueueItem({ attempts: 5, maxAttempts: NaN })
    expect(r.action).toBe('retry')
  })
})

describe('evaluateMailboxGreylistResult — three-way classification', () => {
  // Inject deterministic isGreylisted shim. Real implementation lives in
  // mailboxUtils.js; tests should not depend on its heuristic.
  const fakeGreylisted = (smtp) => smtp?.tag === 'greylist'

  it('smtp.ok=true → clear (greylisting lifted)', () => {
    const r = evaluateMailboxGreylistResult({ ok: true }, fakeGreylisted)
    expect(r.action).toBe('clear')
    expect(r.reason).toMatch(/lifted/)
  })

  it('smtp.ok=false but not greylisted → resolve_other', () => {
    const r = evaluateMailboxGreylistResult({ ok: false, tag: 'auth_fail' }, fakeGreylisted)
    expect(r.action).toBe('resolve_other')
    expect(r.reason).toMatch(/non-greylist/)
  })

  it('smtp.ok=false AND still greylisted → still_greylisted', () => {
    const r = evaluateMailboxGreylistResult({ ok: false, tag: 'greylist' }, fakeGreylisted)
    expect(r.action).toBe('still_greylisted')
    expect(r.reason).toMatch(/persists|451/)
  })

  it('smtp=null → resolve_other (no greylist signal)', () => {
    // Defensive: no smtp data → we can't tell it's greylisted. Resolve and
    // let the rest of the automation decide.
    const r = evaluateMailboxGreylistResult(null, fakeGreylisted)
    expect(r.action).toBe('resolve_other')
  })

  it('smtp.ok missing (undefined) but greylisted → still_greylisted', () => {
    const r = evaluateMailboxGreylistResult({ tag: 'greylist' }, fakeGreylisted)
    expect(r.action).toBe('still_greylisted')
  })

  it('smtp.ok=truthy non-true (e.g. "yes") → falls through to greylist branch', () => {
    // Strict equality: only literal `true` clears. This mirrors the
    // server.js behaviour and protects against accidental coercion.
    const r = evaluateMailboxGreylistResult({ ok: 'yes', tag: 'greylist' }, fakeGreylisted)
    expect(r.action).toBe('still_greylisted')
  })

  it('throws if isGreylistedFn is not a function', () => {
    expect(() => evaluateMailboxGreylistResult({ ok: false }, null)).toThrow(TypeError)
    expect(() => evaluateMailboxGreylistResult({ ok: false }, 'not-a-fn')).toThrow(TypeError)
  })

  it('integration: real isGreylisted heuristic detects 451 message', async () => {
    // Smoke test against the actual heuristic — guards against regression
    // if someone changes mailboxUtils.isGreylisted.
    const { isGreylisted } = await import('../../../src/lib/mailboxUtils.js')
    const smtp451 = { ok: false, steps: [{ msg: '451 4.7.1 try again later' }] }
    const r = evaluateMailboxGreylistResult(smtp451, isGreylisted)
    expect(r.action).toBe('still_greylisted')
  })

  it('integration: real isGreylisted distinguishes 535 auth-fail', async () => {
    const { isGreylisted } = await import('../../../src/lib/mailboxUtils.js')
    const smtpAuth = { ok: false, steps: [{ msg: '535 5.7.8 authentication failed' }] }
    const r = evaluateMailboxGreylistResult(smtpAuth, isGreylisted)
    expect(r.action).toBe('resolve_other')
  })
})
