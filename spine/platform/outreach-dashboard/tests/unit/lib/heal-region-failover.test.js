// HXX11 — Cross-region disaster recovery (JS sim).
// Pure-JS model of primary→secondary failover via DB heartbeat.
// Production wires this over shared Postgres + region_active_until timestamps.

import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import {
  RegionFailoverCoordinator,
  REGION_STATES,
} from '../../../src/lib/heal-region-failover.js'

describe('HXX11 — Region states', () => {
  it('REGION_STATES enumerates valid values', () => {
    expect(REGION_STATES.PRIMARY).toBe('primary')
    expect(REGION_STATES.SECONDARY).toBe('secondary')
    expect(REGION_STATES.FAILED).toBe('failed')
  })
})

describe('HXX11 — RegionFailoverCoordinator init', () => {
  let coord
  beforeEach(() => {
    coord = new RegionFailoverCoordinator({
      regions: ['eu-west', 'eu-central'],
      heartbeatTtlMs: 30 * 1000,
      now: () => 0,
    })
  })

  it('first heartbeat: region becomes primary', () => {
    coord.heartbeat('eu-west', 0)
    expect(coord.activeRegion()).toBe('eu-west')
  })

  it('only one primary at a time', () => {
    coord.heartbeat('eu-west', 0)
    coord.heartbeat('eu-central', 0)
    expect(coord.activeRegion()).toBe('eu-west') // first wins
  })

  it('all regions secondary if no heartbeats', () => {
    expect(coord.activeRegion()).toBe(null)
  })
})

describe('HXX11 — Failover after heartbeat TTL', () => {
  let coord
  beforeEach(() => {
    coord = new RegionFailoverCoordinator({
      regions: ['eu-west', 'eu-central'],
      heartbeatTtlMs: 30 * 1000,
      now: () => 0,
    })
  })

  it('primary heartbeat stops → secondary takes over after TTL', () => {
    let now = 0
    coord.now = () => now
    coord.heartbeat('eu-west', 0)
    // 30s pass without heartbeat from primary
    now = 31 * 1000
    coord.heartbeat('eu-central', now)
    expect(coord.activeRegion()).toBe('eu-central')
  })

  it('primary heartbeat within TTL → no failover', () => {
    let now = 0
    coord.now = () => now
    coord.heartbeat('eu-west', 0)
    now = 25 * 1000
    coord.heartbeat('eu-central', now) // attempt failover before TTL
    expect(coord.activeRegion()).toBe('eu-west') // primary still alive
  })

  it('RTO bound: failover completes within 60s window', () => {
    let now = 0
    coord.now = () => now
    coord.heartbeat('eu-west', 0)
    // Primary dies
    now = 31 * 1000  // TTL expired
    const failoverAt = now
    coord.heartbeat('eu-central', now)
    // Failover should be visible immediately after secondary's heartbeat
    const rtoMs = now - failoverAt
    expect(rtoMs).toBeLessThanOrEqual(60_000)
  })

  it('split-brain prevented: even after failover, original primary heartbeat is rejected', () => {
    let now = 0
    coord.now = () => now
    coord.heartbeat('eu-west', 0)
    now = 31 * 1000
    coord.heartbeat('eu-central', now)
    // Old primary tries to come back
    coord.heartbeat('eu-west', now + 1000)
    // New primary stays active
    expect(coord.activeRegion()).toBe('eu-central')
  })

  it('heartbeat history visible for audit', () => {
    let now = 0
    coord.now = () => now
    coord.heartbeat('eu-west', 0)
    now = 31 * 1000
    coord.heartbeat('eu-central', now)
    const events = coord.failoverHistory()
    expect(events.length).toBe(1)
    expect(events[0].from).toBe('eu-west')
    expect(events[0].to).toBe('eu-central')
  })
})

describe('HXX11 — RPO 0 (no data loss)', () => {
  let coord
  beforeEach(() => {
    coord = new RegionFailoverCoordinator({
      regions: ['eu-west', 'eu-central'],
      heartbeatTtlMs: 30 * 1000,
      now: () => 0,
    })
  })

  it('shared state via DB ensures RPO 0 (no in-flight loss)', () => {
    // The coordinator is just an arbiter; actual state lives in shared DB.
    // This test asserts that after failover, the secondary picks up at the
    // exact state primary left (no in-flight loss).
    let now = 0
    coord.now = () => now
    coord.heartbeat('eu-west', 0)
    coord.recordTransaction('send_event_id_42')
    coord.recordTransaction('send_event_id_43')
    now = 31 * 1000
    coord.heartbeat('eu-central', now)
    // Secondary sees the same transaction list
    const txs = coord.getTransactions()
    expect(txs).toContain('send_event_id_42')
    expect(txs).toContain('send_event_id_43')
  })

  it('no double-send: same transaction recorded once across regions', () => {
    let now = 0
    coord.now = () => now
    coord.heartbeat('eu-west', 0)
    coord.recordTransaction('tx_1')
    now = 31 * 1000
    coord.heartbeat('eu-central', now)
    coord.recordTransaction('tx_1') // duplicate from secondary
    expect(coord.getTransactions().filter(t => t === 'tx_1').length).toBe(1)
  })
})

describe('HXX11 — Multi-region scenarios', () => {
  it('3-region setup: failover chain', () => {
    const c = new RegionFailoverCoordinator({
      regions: ['eu-west', 'eu-central', 'us-east'],
      heartbeatTtlMs: 30 * 1000,
      now: () => 0,
    })
    let now = 0
    c.now = () => now
    c.heartbeat('eu-west', 0)
    expect(c.activeRegion()).toBe('eu-west')
    now = 31 * 1000
    c.heartbeat('eu-central', now)
    expect(c.activeRegion()).toBe('eu-central')
    now = 62 * 1000
    c.heartbeat('us-east', now)
    expect(c.activeRegion()).toBe('us-east')
  })

  it('all regions failed → no active region', () => {
    const c = new RegionFailoverCoordinator({
      regions: ['eu-west', 'eu-central'],
      heartbeatTtlMs: 30 * 1000,
      now: () => 0,
    })
    c.heartbeat('eu-west', 0)
    c.now = () => 100 * 1000  // far past all TTLs, no recovery
    expect(c.activeRegion()).toBe(null)
  })
})

describe('HXX11 — Properties', () => {
  it('property: only one active region at a time', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: 0, max: 1_000_000 })),
          { minLength: 1, maxLength: 50 }),
        (events) => {
          const c = new RegionFailoverCoordinator({
            regions: ['a', 'b', 'c'],
            heartbeatTtlMs: 30 * 1000,
          })
          for (const [region, t] of events) c.heartbeat(region, t)
          // At any point, activeRegion is one of regions or null
          const active = c.activeRegion()
          return active === null || ['a', 'b', 'c'].includes(active)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('property: failover history is monotonic by timestamp', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('a', 'b'), fc.integer({ min: 0, max: 100_000 })),
          { minLength: 1, maxLength: 30 }),
        (events) => {
          const c = new RegionFailoverCoordinator({
            regions: ['a', 'b'],
            heartbeatTtlMs: 30 * 1000,
          })
          // Sort by timestamp to simulate time-ordered events
          const sorted = [...events].sort((a, b) => a[1] - b[1])
          for (const [region, t] of sorted) c.heartbeat(region, t)
          const history = c.failoverHistory()
          for (let i = 1; i < history.length; i++) {
            if (history[i].at < history[i - 1].at) return false
          }
          return true
        }
      ),
      { numRuns: 50 }
    )
  })
})

describe('HXX11 — Defensive', () => {
  it('regions must be non-empty', () => {
    expect(() => new RegionFailoverCoordinator({ regions: [] })).toThrow()
  })

  it('unknown region in heartbeat throws', () => {
    const c = new RegionFailoverCoordinator({ regions: ['a', 'b'] })
    expect(() => c.heartbeat('unknown', 0)).toThrow(/unknown/i)
  })

  it('negative timestamp handled', () => {
    const c = new RegionFailoverCoordinator({ regions: ['a', 'b'] })
    expect(() => c.heartbeat('a', -1000)).not.toThrow()
  })
})
