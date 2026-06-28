// Unit tests for evaluateSendWindows() + windowState() — issue #486.
// Operator's `pnpm report` would otherwise critical-flag every weekend
// and every weekday after-hours, even though sends are correctly held
// by the campaign scheduler waiting for the next send window.

import { describe, it, expect } from 'vitest'
import { evaluateSendWindows, windowState, detectBottlenecks } from '../../../scripts/system-report.mjs'

const wkdayCfg = {
  timezone: 'Europe/Prague',
  send_window_start: '08:00',
  send_window_end: '18:00',
  weekdays_only: true,
}

describe('windowState — single campaign window evaluation', () => {
  it('1: weekday inside window → isOpen=true', () => {
    // 2026-05-04 is a Monday in Europe/Prague; 12:00 Prague = 10:00 UTC
    const now = new Date('2026-05-04T10:00:00Z')
    expect(windowState(wkdayCfg, now).isOpen).toBe(true)
  })

  it('2: weekday before window → isOpen=false, nextOpen later same day', () => {
    // Mon 06:00 Prague = 04:00 UTC
    const now = new Date('2026-05-04T04:00:00Z')
    const r = windowState(wkdayCfg, now)
    expect(r.isOpen).toBe(false)
    expect(r.nextOpen).toBeInstanceOf(Date)
    expect(r.nextOpen.getTime()).toBeGreaterThan(now.getTime())
  })

  it('3: weekday after window → isOpen=false, nextOpen next day', () => {
    // Mon 19:00 Prague = 17:00 UTC
    const now = new Date('2026-05-04T17:00:00Z')
    const r = windowState(wkdayCfg, now)
    expect(r.isOpen).toBe(false)
    expect(r.nextOpen.getTime()).toBeGreaterThan(now.getTime())
  })

  it('4: Saturday with weekdays_only → isOpen=false, nextOpen Monday morning', () => {
    // 2026-05-02 is a Saturday
    const now = new Date('2026-05-02T10:00:00Z')
    const r = windowState(wkdayCfg, now)
    expect(r.isOpen).toBe(false)
    expect(r.nextOpen).toBeInstanceOf(Date)
  })

  it('5: Sunday with weekdays_only → isOpen=false', () => {
    const now = new Date('2026-05-03T10:00:00Z')
    expect(windowState(wkdayCfg, now).isOpen).toBe(false)
  })

  it('6: Saturday WITHOUT weekdays_only inside window → isOpen=true', () => {
    const cfg = { ...wkdayCfg, weekdays_only: false }
    const now = new Date('2026-05-02T10:00:00Z')
    expect(windowState(cfg, now).isOpen).toBe(true)
  })

  it('7: 24h window (00:00-23:59) on weekend with weekdays_only → still closed', () => {
    const cfg = { ...wkdayCfg, send_window_start: '00:00', send_window_end: '23:59' }
    const now = new Date('2026-05-02T12:00:00Z')
    expect(windowState(cfg, now).isOpen).toBe(false)
  })

  it('8: missing window config → isOpen=true (legacy fallback, treated as always-open)', () => {
    // evaluateSendWindows handles this; windowState assumes valid input.
    // Test through the public API:
    const camps = [{ status: 'running', sending_config: {} }]
    const now = new Date('2026-05-02T12:00:00Z')  // Saturday
    expect(evaluateSendWindows(camps, now).allClosed).toBe(false)
  })
})

describe('evaluateSendWindows — multi-campaign aggregation', () => {
  it('9: all running campaigns closed → allClosed=true', () => {
    const camps = [
      { status: 'running', sending_config: wkdayCfg },
      { status: 'running', sending_config: wkdayCfg },
    ]
    // Saturday — both closed
    const r = evaluateSendWindows(camps, new Date('2026-05-02T10:00:00Z'))
    expect(r.allClosed).toBe(true)
    expect(r.nextOpen).toBeInstanceOf(Date)
  })

  it('10: any campaign with no window config → not allClosed (legacy 24/7)', () => {
    const camps = [
      { status: 'running', sending_config: wkdayCfg },         // Sat → closed
      { status: 'running', sending_config: {} },                // legacy → always open
    ]
    const r = evaluateSendWindows(camps, new Date('2026-05-02T10:00:00Z'))
    expect(r.allClosed).toBe(false)
  })

  it('11: empty running list → allClosed=false (vacuously)', () => {
    const r = evaluateSendWindows([], new Date('2026-05-02T10:00:00Z'))
    expect(r.allClosed).toBe(false)
  })

  it('12: nextOpen is the EARLIEST among all closed campaigns', () => {
    const cfgEarly = { ...wkdayCfg, send_window_start: '07:00', send_window_end: '18:00' }
    const cfgLate = { ...wkdayCfg, send_window_start: '10:00', send_window_end: '18:00' }
    const camps = [
      { status: 'running', sending_config: cfgEarly },
      { status: 'running', sending_config: cfgLate },
    ]
    // Mon 04:00 UTC = 06:00 Prague — both closed; cfgEarly opens at 07:00, cfgLate at 10:00
    const r = evaluateSendWindows(camps, new Date('2026-05-04T04:00:00Z'))
    expect(r.allClosed).toBe(true)
    // earliest open is cfgEarly (07:00 Prague = 05:00 UTC)
    expect(r.nextOpen.getUTCHours()).toBe(5)
  })
})

describe('detectBottlenecks integration — outside_send_window vs no_sends_despite_running', () => {
  const baseData = (overrides = {}) => ({
    matrix: [],
    mailboxes: [{ id: 1, status: 'active', from_address: 'a@x.cz', cache_age_sec: 0, score_age_sec: 0 }],
    campaigns: [{ id: 1, status: 'running', sending_config: wkdayCfg }],
    sends: { sent_24h: 0 },
    openAlerts: [],
    proxyPool: [{ working: true }],
    _now: new Date('2026-05-04T10:00:00Z'),  // Mon noon Prague — inside window
    ...overrides,
  })

  it('13: inside window with 0 sends → critical no_sends_despite_running', () => {
    const bns = detectBottlenecks(baseData())
    expect(bns.find(b => b.kind === 'no_sends_despite_running')).toBeDefined()
    expect(bns.find(b => b.kind === 'outside_send_window')).toBeUndefined()
  })

  it('14: outside window with 0 sends → info-level outside_send_window (no critical)', () => {
    // Saturday — outside the wkdayCfg window
    const bns = detectBottlenecks(baseData({ _now: new Date('2026-05-02T10:00:00Z') }))
    expect(bns.find(b => b.kind === 'outside_send_window')).toBeDefined()
    expect(bns.find(b => b.kind === 'no_sends_despite_running')).toBeUndefined()
    expect(bns.find(b => b.kind === 'outside_send_window').severity).toBe('info')
  })

  it('15: outside window with sends >0 → no flag at all', () => {
    const bns = detectBottlenecks(baseData({
      _now: new Date('2026-05-02T10:00:00Z'),
      sends: { sent_24h: 5 },
    }))
    expect(bns.find(b => b.kind === 'no_sends_despite_running')).toBeUndefined()
    expect(bns.find(b => b.kind === 'outside_send_window')).toBeUndefined()
  })

  it('16: outside_send_window includes next_open_iso', () => {
    const bns = detectBottlenecks(baseData({ _now: new Date('2026-05-02T10:00:00Z') }))
    const w = bns.find(b => b.kind === 'outside_send_window')
    expect(w.next_open_iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})
