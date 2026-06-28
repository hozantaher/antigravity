// Unit tests for detectBottlenecks() — issue #485 watchdog freshness blocker.
// The system-report script is the operator's pre-launch sanity check; if its
// `last_score_at >24h` signal goes silent, false-green sneaks past the gate.

import { describe, it, expect } from 'vitest'
import { detectBottlenecks } from '../../../scripts/system-report.mjs'

const baseMatrix = []
const baseData = () => ({
  matrix: baseMatrix,
  mailboxes: [],
  campaigns: [],
  sends: { sent_24h: 0 },
  openAlerts: [],
  proxyPool: [],
})

const HOUR_SEC = 3600
const DAY_SEC = 86400

describe('detectBottlenecks — stale_mailbox_score (issue #485)', () => {
  it('1: active mailbox with score_age_sec > 24h emits CRITICAL stale_mailbox_score', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: DAY_SEC + 1, cache_age_sec: 0,
    }]
    const bns = detectBottlenecks(data)
    const stale = bns.find(b => b.kind === 'stale_mailbox_score')
    expect(stale).toBeDefined()
    expect(stale.severity).toBe('critical')
    expect(stale.mailbox_id).toBe(1)
    expect(stale.email).toBe('a@x.cz')
  })

  it('2: active mailbox with score_age_sec exactly 24h does NOT emit (boundary)', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: DAY_SEC, cache_age_sec: 0,
    }]
    const bns = detectBottlenecks(data)
    expect(bns.find(b => b.kind === 'stale_mailbox_score')).toBeUndefined()
  })

  it('3: active mailbox with score_age_sec just over 24h DOES emit (boundary +1s)', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: DAY_SEC + 1, cache_age_sec: 0,
    }]
    const bns = detectBottlenecks(data)
    expect(bns.find(b => b.kind === 'stale_mailbox_score')).toBeDefined()
  })

  it('4: paused mailbox with stale score is NOT flagged (only active)', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'paused',
      score_age_sec: 7 * DAY_SEC, cache_age_sec: 0,
    }]
    const bns = detectBottlenecks(data)
    expect(bns.find(b => b.kind === 'stale_mailbox_score')).toBeUndefined()
  })

  it('5: score_age_sec null/undefined → treated as Infinity → emit critical', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: null, cache_age_sec: 0,
    }]
    const bns = detectBottlenecks(data)
    const stale = bns.find(b => b.kind === 'stale_mailbox_score')
    expect(stale).toBeDefined()
    expect(stale.severity).toBe('critical')
  })

  it('6: age_hours field is whole hours (floored)', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: 25 * HOUR_SEC + 30 * 60,  // 25h 30m
      cache_age_sec: 0,
    }]
    const bns = detectBottlenecks(data)
    expect(bns.find(b => b.kind === 'stale_mailbox_score').age_hours).toBe(25)
  })

  it('7: multiple stale mailboxes → one entry per mailbox', () => {
    const data = baseData()
    data.mailboxes = [
      { id: 1, from_address: 'a@x.cz', status: 'active', score_age_sec: 2 * DAY_SEC, cache_age_sec: 0 },
      { id: 2, from_address: 'b@x.cz', status: 'active', score_age_sec: 3 * DAY_SEC, cache_age_sec: 0 },
    ]
    const bns = detectBottlenecks(data)
    const stales = bns.filter(b => b.kind === 'stale_mailbox_score')
    expect(stales).toHaveLength(2)
    expect(stales.map(s => s.mailbox_id).sort()).toEqual([1, 2])
  })

  it('8: fresh score (score_age_sec=0) does not emit', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: 0, cache_age_sec: 0,
    }]
    expect(detectBottlenecks(data).find(b => b.kind === 'stale_mailbox_score')).toBeUndefined()
  })

  it('9: stale_mailbox_score AND stale_mailbox_check both fire when both thresholds crossed', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: 2 * DAY_SEC, cache_age_sec: 25 * HOUR_SEC,
    }]
    const bns = detectBottlenecks(data)
    expect(bns.find(b => b.kind === 'stale_mailbox_score')).toBeDefined()
    expect(bns.find(b => b.kind === 'stale_mailbox_check')).toBeDefined()
  })

  it('10: empty mailbox list emits no stale signals', () => {
    const data = baseData()
    const bns = detectBottlenecks(data)
    expect(bns.find(b => b.kind === 'stale_mailbox_score')).toBeUndefined()
  })

  it('11: stale_mailbox_score severity drives RTH=NE in verdict path', () => {
    // Verdict marks anything with severity='critical' as blocking.
    // Confirms the contract: a stale score is *blocking*, not warning.
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: 2 * DAY_SEC, cache_age_sec: 0,
    }]
    const bns = detectBottlenecks(data)
    const stale = bns.find(b => b.kind === 'stale_mailbox_score')
    expect(stale.severity).toBe('critical')
  })

  it('12: stale_mailbox_score is always critical regardless of BFF reachability (CAD-S8)', () => {
    // CAD-S8 / issue #539: scoring loop moved to Go orchestrator; BFF
    // reachability no longer affects scoring freshness.  Stale >24h is always
    // critical. bff_unreachable is kept in the output but always false.
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: 2 * DAY_SEC, cache_age_sec: 0,
    }]
    data.proxyPool = { error: 'fetch failed', working: [], total: 0 }
    const bns = detectBottlenecks(data)
    const stale = bns.find(b => b.kind === 'stale_mailbox_score')
    expect(stale).toBeDefined()
    expect(stale.severity).toBe('critical')
    expect(stale.bff_unreachable).toBe(false)
  })

  it('13: stale_mailbox_score stays critical when BFF reachable (unchanged)', () => {
    const data = baseData()
    data.mailboxes = [{
      id: 1, from_address: 'a@x.cz', status: 'active',
      score_age_sec: 2 * DAY_SEC, cache_age_sec: 0,
    }]
    data.proxyPool = { working: [{}], total: 1 }  // no error → BFF reachable
    const bns = detectBottlenecks(data)
    const stale = bns.find(b => b.kind === 'stale_mailbox_score')
    expect(stale.severity).toBe('critical')
    expect(stale.bff_unreachable).toBe(false)
  })
})
