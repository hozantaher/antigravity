// BF-A1 — runCampaignWatchdogCron decision logic unit tests.
// The full cron in server.js is just I/O orchestration (SELECT campaigns,
// SELECT send_events agg, UPDATE status, INSERT healing_log). The actual
// threshold logic lives in evaluateCampaignWatchdog (pure function).

import { describe, it, expect } from 'vitest'
import { evaluateCampaignWatchdog } from '../../../src/lib/automation.js'

describe('evaluateCampaignWatchdog — insufficient data', () => {
  it('sent=0 → noop (no aggregate)', () => {
    const r = evaluateCampaignWatchdog({ sent: 0, bounced: 0, replied: 0 })
    expect(r.action).toBe('noop')
    expect(r.reason).toMatch(/insufficient/)
  })

  it('sent<10 → noop (warmup phase)', () => {
    const r = evaluateCampaignWatchdog({ sent: 5, bounced: 1, replied: 1 })
    // bounce 20%, reply 20% — but sample too small to act
    expect(r.action).toBe('noop')
  })

  it('null/missing fields default to 0', () => {
    const r = evaluateCampaignWatchdog({})
    expect(r.action).toBe('noop')
    expect(r.bounceRate).toBe(0)
    expect(r.replyRate).toBe(0)
  })

  it('sent=9 boundary → still noop (threshold is < 10)', () => {
    const r = evaluateCampaignWatchdog({ sent: 9, bounced: 9, replied: 0 })
    expect(r.action).toBe('noop')
  })
})

describe('evaluateCampaignWatchdog — auto_pause on high bounce', () => {
  it('sent=10, bounced=1 → 10% bounce → auto_pause', () => {
    const r = evaluateCampaignWatchdog({ sent: 10, bounced: 1, replied: 0 })
    expect(r.action).toBe('auto_pause')
    expect(r.bounceRate).toBeCloseTo(0.10)
    expect(r.reason).toMatch(/bounce rate 10\.0%/)
  })

  it('sent=20, bounced=2 → exactly 10% → auto_pause', () => {
    const r = evaluateCampaignWatchdog({ sent: 20, bounced: 2, replied: 0 })
    expect(r.action).toBe('auto_pause')
  })

  it('sent=20, bounced=1 → exactly 5% → NOT auto_pause (threshold is strict >)', () => {
    const r = evaluateCampaignWatchdog({ sent: 20, bounced: 1, replied: 0 })
    expect(r.action).toBe('noop') // bounceRate === 0.05, not > 0.05
  })

  it('sent=21, bounced=2 → 9.5% → auto_pause', () => {
    const r = evaluateCampaignWatchdog({ sent: 21, bounced: 2, replied: 0 })
    expect(r.action).toBe('auto_pause')
  })

  it('high bounce trumps low_performance check', () => {
    // sent=100, bounced=10, replied=0 → bounce 10% AND reply 0% (< 0.5%)
    // Auto-pause should fire (bounce wins over low_performance)
    const r = evaluateCampaignWatchdog({ sent: 100, bounced: 10, replied: 0 })
    expect(r.action).toBe('auto_pause')
  })
})

describe('evaluateCampaignWatchdog — low_performance advisory', () => {
  it('sent=50, replied=0 → low_performance', () => {
    const r = evaluateCampaignWatchdog({ sent: 50, bounced: 0, replied: 0 })
    expect(r.action).toBe('low_performance')
    expect(r.reason).toMatch(/reply rate 0\.00%/)
  })

  it('sent=49 → noop (< 50 threshold)', () => {
    const r = evaluateCampaignWatchdog({ sent: 49, bounced: 0, replied: 0 })
    expect(r.action).toBe('noop')
  })

  it('sent=200, replied=1 → 0.5% reply boundary → noop (threshold is strict <)', () => {
    const r = evaluateCampaignWatchdog({ sent: 200, bounced: 0, replied: 1 })
    expect(r.replyRate).toBe(0.005)
    expect(r.action).toBe('noop') // not strictly < 0.005
  })

  it('sent=400, replied=1 → 0.25% → low_performance', () => {
    const r = evaluateCampaignWatchdog({ sent: 400, bounced: 0, replied: 1 })
    expect(r.action).toBe('low_performance')
  })

  it('healthy reply rate (≥ 0.5%) at scale → noop', () => {
    const r = evaluateCampaignWatchdog({ sent: 1000, bounced: 10, replied: 10 })
    expect(r.action).toBe('noop')
    expect(r.reason).toBe('within thresholds')
  })
})

describe('evaluateCampaignWatchdog — type coercion', () => {
  it('string numbers (from DB COUNT()::int via JSON serialization)', () => {
    const r = evaluateCampaignWatchdog({ sent: '100', bounced: '6', replied: '0' })
    expect(r.action).toBe('auto_pause')
    expect(r.bounceRate).toBeCloseTo(0.06)
  })
})
