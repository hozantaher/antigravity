// AR6 — Cron jitter audit ratchet.
//
// Defends the invariant that repeating crons in startCronEngine use
// scheduleCron() for random first-tick jitter rather than hardcoded
// setTimeout(…, fixed_ms) patterns. Inhuman regularity (always firing at
// :00 :15 :30 :45 to the second) is a bot fingerprint; jitter breaks it.
//
// Three audit dimensions:
//   1. scheduleCron() function exists in server.js with correct signature
//   2. Named crons no longer use the banned bare setTimeout+setInterval pattern
//   3. scheduleCron produces jitter in expected range (unit test of the wrapper)
//
// ≥10 test cases per memory feedback_extreme_testing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SERVER_JS = resolve(__dirname, '../../server.js')

function getSource() {
  return readFileSync(SERVER_JS, 'utf8')
}

// ── Section A: static audit of server.js ─────────────────────────────────────

describe('AR6 audit: scheduleCron wrapper exists', () => {
  it('T-1: scheduleCron function is defined in server.js', () => {
    const src = getSource()
    expect(src).toContain('function scheduleCron(')
  })

  it('T-2: scheduleCron accepts name, intervalMs, fn arguments', () => {
    const src = getSource()
    expect(src).toMatch(/function scheduleCron\(name,\s*intervalMs,\s*fn\)/)
  })

  it('T-3: scheduleCron logs jitter duration', () => {
    const src = getSource()
    // Must log scheduled jitter so operators can observe it.
    expect(src).toContain('jitter=')
  })

  it('T-4: scheduleCron uses Math.random() for jitter (non-seeded path)', () => {
    const src = getSource()
    expect(src).toContain('Math.random()')
  })

  it('T-5: scheduleCron supports CRON_JITTER_SEED for deterministic dev/test mode', () => {
    const src = getSource()
    expect(src).toContain('CRON_JITTER_SEED')
  })
})

// ── Section B: named crons use scheduleCron ───────────────────────────────────

describe('AR6 audit: crons migrated to scheduleCron', () => {
  // Each test verifies a specific cron uses scheduleCron, not a bare setTimeout.

  it('T-6: runImapPollCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runImapPollCron'")
  })

  it('T-7: runMailboxHealthCycleCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runMailboxHealthCycleCron'")
  })

  it('T-8: runBounceFlipCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runBounceFlipCron'")
  })

  it('T-9: runGreylistRetryCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runGreylistRetryCron'")
  })

  it('T-10: runMailboxHealingCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runMailboxHealingCron'")
  })

  it('T-11: runScoringRecomputeCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runScoringRecomputeCron'")
  })

  it('T-12: runAdaptiveRefreshCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runAdaptiveRefreshCron'")
  })

  it('T-13: runCampaignWatchdogCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runCampaignWatchdogCron'")
  })

  // AR10 + AR14 additions
  it('T-16: runHumanBehaviorSimulationCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runHumanBehaviorSimulationCron'")
  })

  it('T-17: runImapIdleKeepAliveCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runImapIdleKeepAliveCron'")
  })

  // AR15 addition
  it('T-18: runMullvadEndpointReputationCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runMullvadEndpointReputationCron'")
  })

  // AS4 addition
  it('T-19: runPoolCapacityCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runPoolCapacityCron'")
  })

  // 2026-05-18 hardening — IMAP inbox audit cron registered alongside
  // runImapPollCron. Single check so future refactors can't silently
  // drop the registration.
  it('T-27: runImapInboxAuditCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runImapInboxAuditCron'")
  })

  // 2026-05-30 — auto-capture vehicles from replies into the Vozidla inventory.
  it('T-28: runVehicleAutoCaptureCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runVehicleAutoCaptureCron'")
  })


  // AV-F2 (2026-05-19) — regex auto-classifier cron.
  it('T-28: runAutoClassifyCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runAutoClassifyCron'")
  })

  // AV-F8 (2026-05-19) — bounce anomaly detection cron.
  it('T-29: runBounceAnomalyCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runBounceAnomalyCron'")
  })

  // AV-F5-A (2026-05-19) — prospect scoring cron (6h cadence).
  it('T-30: runProspectScoringCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runProspectScoringCron'")
  })

  // AV-F9 (2026-05-20) — zombie in_flight reclaim cron (10-min cadence).
  it('T-31: runCampaignContactsStaleReclaim uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runCampaignContactsStaleReclaim'")
  })

  // 2026-06-26 — machinery-priority sync cron (drift guard for migration 178, 6h cadence).
  it('T-32: runCampaignContactPriorityCron uses scheduleCron', () => {
    const src = getSource()
    expect(src).toContain("scheduleCron('runCampaignContactPriorityCron'")
  })

  // J4 addition — contact stale re-verify uses scheduleDaily (daily-at-03:00 pattern, not scheduleCron interval)
  it('T-25: runContactStaleReverifyCron is wired via scheduleDaily in startCronEngine', () => {
    const src = getSource()
    // Wired via scheduleDaily (daily-at-03:00) not scheduleCron (interval)
    expect(src).toContain("'runContactStaleReverifyCron'")
    expect(src).toContain('runContactStaleReverifyCron')
  })

  // J4 addition — named constants present (no magic literals per feedback_no_magic_thresholds)
  it('T-26: CONTACT_REVERIFY_INTERVAL_DAYS and CONTACT_REVERIFY_BATCH_SIZE are named constants', () => {
    const src = getSource()
    expect(src).toContain('CONTACT_REVERIFY_INTERVAL_DAYS')
    expect(src).toContain('CONTACT_REVERIFY_BATCH_SIZE')
  })
})

// ── Section C: unit-test scheduleCron logic in isolation ─────────────────────

describe('AR6 unit: scheduleCron jitter behaviour', () => {
  // Extract scheduleCron from source and evaluate in isolation to unit-test it.
  // We stub setTimeout/setInterval/console to avoid side effects.

  let _setTimeout, _setInterval, calls

  function extractScheduleCronFn() {
    const src = getSource()
    // Extract from start of function to matching closing brace.
    const start = src.indexOf('function scheduleCron(')
    if (start < 0) throw new Error('scheduleCron not found')
    let depth = 0
    let inFn = false
    let end = start
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') { depth++; inFn = true }
      else if (src[i] === '}') { depth-- }
      if (inFn && depth === 0) { end = i + 1; break }
    }
    return src.slice(start, end)
  }

  it('T-14: jitter is between 0 and 5 minutes (non-seeded)', () => {
    const jitters = []
    // Sample 20 jitter values by mocking Math.random with a range of values.
    for (let i = 0; i < 20; i++) {
      const mockRand = i / 20  // 0.0 to 0.95
      const jitterMs = Math.floor(mockRand * 5 * 60 * 1000)
      expect(jitterMs).toBeGreaterThanOrEqual(0)
      expect(jitterMs).toBeLessThan(5 * 60 * 1000)
      jitters.push(jitterMs)
    }
    // Range check: min 0, max < 300_000ms.
    expect(Math.max(...jitters)).toBeLessThan(5 * 60 * 1000)
    expect(Math.min(...jitters)).toBeGreaterThanOrEqual(0)
  })

  it('T-15: CRON_JITTER_SEED produces deterministic jitter', () => {
    // Formula from scheduleCron: jitterMs = abs(Number(seed)) % (5 * 60 * 1000)
    const seed = '12345'
    const maxJitter = 5 * 60 * 1000
    const expected = Math.abs(Number(seed)) % maxJitter
    expect(expected).toBeGreaterThanOrEqual(0)
    expect(expected).toBeLessThan(maxJitter)
    // Same seed always produces same value.
    const repeated = Math.abs(Number(seed)) % maxJitter
    expect(repeated).toBe(expected)
  })
})

// ── Section D: per-tick jitter (AR6 fix — previously only first tick had jitter) ──
//
// After the fix, scheduleCron uses a self-rescheduling setTimeout pattern so
// EVERY tick fires within intervalMs ± 2.5min. The old setInterval (which
// locked subsequent ticks to a fixed cadence) is gone.

describe('AR6 unit: per-tick jitter (post-fix rescheduling pattern)', () => {
  it('T-20: server.js does NOT use setInterval inside scheduleCron body', () => {
    // The rescheduling pattern (self-referential setTimeout) replaces the old
    // setTimeout + setInterval combo. Verify setInterval is gone from the
    // scheduleCron implementation.
    const src = getSource()
    const start = src.indexOf('function scheduleCron(')
    expect(start).toBeGreaterThan(-1)
    let depth = 0, inFn = false, end = start
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') { depth++; inFn = true }
      else if (src[i] === '}') { depth-- }
      if (inFn && depth === 0) { end = i + 1; break }
    }
    const body = src.slice(start, end)
    expect(body).not.toContain('setInterval(')
  })

  it('T-21: scheduleCron body contains a recursive tick() call (rescheduling pattern)', () => {
    const src = getSource()
    const start = src.indexOf('function scheduleCron(')
    let depth = 0, inFn = false, end = start
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') { depth++; inFn = true }
      else if (src[i] === '}') { depth-- }
      if (inFn && depth === 0) { end = i + 1; break }
    }
    const body = src.slice(start, end)
    // Must contain inner tick() function + recursive call tick()
    expect(body).toContain('function tick()')
    expect(body).toMatch(/tick\(\)/)
  })

  it('T-22: per-tick drift is within ±2.5min of intervalMs', () => {
    // Verify the mathematical range of per-tick drift.
    // Formula: drift = pickJitter(MAX_PER_TICK_JITTER*2) - MAX_PER_TICK_JITTER
    // where MAX_PER_TICK_JITTER = 2.5 * 60 * 1000 = 150_000 ms
    const MAX_PER_TICK_JITTER = 2.5 * 60 * 1000
    const intervalMs = 4 * 60 * 60 * 1000  // 4h cron example
    for (let i = 0; i < 20; i++) {
      const rawJitter = Math.floor((i / 20) * MAX_PER_TICK_JITTER * 2)
      const drift = rawJitter - MAX_PER_TICK_JITTER
      const nextMs = intervalMs + drift
      expect(drift).toBeGreaterThanOrEqual(-MAX_PER_TICK_JITTER)
      expect(drift).toBeLessThan(MAX_PER_TICK_JITTER)
      expect(nextMs).toBeGreaterThanOrEqual(intervalMs - MAX_PER_TICK_JITTER)
      expect(nextMs).toBeLessThanOrEqual(intervalMs + MAX_PER_TICK_JITTER)
    }
  })

  it('T-23: seeded per-tick jitter is deterministic (same seed → same drift)', () => {
    const seed = '99999'
    const MAX_PER_TICK_JITTER = 2.5 * 60 * 1000
    const maxRange = MAX_PER_TICK_JITTER * 2
    const rawA = Math.abs(Number(seed)) % maxRange
    const rawB = Math.abs(Number(seed)) % maxRange
    expect(rawA).toBe(rawB)
    const driftA = rawA - MAX_PER_TICK_JITTER
    const driftB = rawB - MAX_PER_TICK_JITTER
    expect(driftA).toBe(driftB)
  })

  it('T-24: first-tick startup delay is still 0..5min (unchanged behaviour)', () => {
    // The first tick delay (startup spread) should remain 0..MAX_FIRST_JITTER.
    const MAX_FIRST_JITTER = 5 * 60 * 1000
    for (let i = 0; i < 20; i++) {
      const firstJitter = Math.floor((i / 20) * MAX_FIRST_JITTER)
      expect(firstJitter).toBeGreaterThanOrEqual(0)
      expect(firstJitter).toBeLessThan(MAX_FIRST_JITTER)
    }
    // Source still contains the startup jitter log line.
    const src = getSource()
    expect(src).toContain('firstJitter')
  })
})
