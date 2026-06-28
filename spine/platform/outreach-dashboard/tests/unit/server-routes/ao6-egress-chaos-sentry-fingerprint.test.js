// Sprint AO6 — Sentry fingerprint test for egress_chaos_detection cron.
//
// The AO6 change adds:
//   - fingerprint: ['egress_chaos', String(mbId)]
//   - tags.country_list: comma-joined countries
//
// These ensure Sentry groups by mailbox (not by detection run) and enables
// country_list as a fast triage filter tag in the Sentry UI.
//
// Tests:
//   F01 fingerprint present + contains mailbox_id
//   F02 fingerprint groups same mailbox (identical across two detections)
//   F03 tags.country_list is comma-joined string
//   F04 tags.mailbox_id is string (not number)
//   F05 tags.component = egress_chaos_detection

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runEgressChaosDetectionCron } from '../../../src/server-routes/egressChaosDetection.js'

function makeSentry() {
  return { captureMessage: vi.fn() }
}

function makePool(chaos) {
  let idx = 0
  // pool.query covers detect_mailbox_egress_chaos + the per-mailbox state SELECT.
  // The status flip + mailbox_egress_chaos_flag audit INSERT now run in one tx
  // on a connected client (pool.connect() → BEGIN/UPDATE/INSERT/COMMIT), so the
  // Sentry captureMessage (and its fingerprint/tags) only fires after COMMIT.
  const sequence = [
    { rows: chaos },
    { rows: [{ lifecycle_phase: 'production', status: 'active', created_at: '2026-01-01T00:00:00Z' }] },
  ]
  const clientQuery = vi.fn(async (sql) => {
    const t = typeof sql === 'string' ? sql.trim().toUpperCase() : ''
    if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 1 }
  })
  return {
    query: vi.fn().mockImplementation(() => {
      const r = sequence[idx] ?? { rows: [] }
      idx++
      return Promise.resolve(r)
    }),
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ observations: [] }),
  }))
  process.env.ANTI_TRACE_RELAY_URL = 'http://relay.test'
})

afterEach(() => {
  delete process.env.ANTI_TRACE_RELAY_URL
})

const CHAOS_ROW = { mailbox_id: '99', country_count: 2, country_list: ['CZ', 'DE'] }

// F01: fingerprint is present and contains mailbox_id as second element
describe('F01 Sentry fingerprint present', () => {
  it('fingerprint array contains mailbox_id', async () => {
    const Sentry = makeSentry()
    const pool = makePool([CHAOS_ROW])
    await runEgressChaosDetectionCron(pool, { Sentry })

    const opts = Sentry.captureMessage.mock.calls[0][1]
    expect(Array.isArray(opts.fingerprint)).toBe(true)
    expect(opts.fingerprint).toContain('99')
  })
})

// F02: same mailbox_id → identical fingerprint (groups in Sentry)
describe('F02 same mailbox same fingerprint', () => {
  it('two detections for same mailbox produce identical fingerprint', async () => {
    // Simulate two separate cron runs — each gets its own pool + connected client.
    const Sentry = makeSentry()

    // Run 1
    await runEgressChaosDetectionCron(makePool([CHAOS_ROW]), { Sentry })
    // Run 2 — fresh pool: mailbox state SELECT returns 'active' (not already flagged)
    await runEgressChaosDetectionCron(makePool([CHAOS_ROW]), { Sentry })

    expect(Sentry.captureMessage).toHaveBeenCalledTimes(2)
    const fp1 = Sentry.captureMessage.mock.calls[0][1].fingerprint
    const fp2 = Sentry.captureMessage.mock.calls[1][1].fingerprint
    expect(fp1).toEqual(fp2)
  })
})

// F03: tags.country_list is comma-joined string
describe('F03 tags.country_list is string', () => {
  it('country_list tag is comma-joined ISO codes', async () => {
    const Sentry = makeSentry()
    const pool = makePool([CHAOS_ROW])
    await runEgressChaosDetectionCron(pool, { Sentry })

    const opts = Sentry.captureMessage.mock.calls[0][1]
    expect(typeof opts.tags.country_list).toBe('string')
    expect(opts.tags.country_list).toBe('CZ,DE')
  })
})

// F04: tags.mailbox_id is string (Sentry tag values must be string)
describe('F04 tags.mailbox_id is string', () => {
  it('mailbox_id tag is a string type', async () => {
    const Sentry = makeSentry()
    const pool = makePool([CHAOS_ROW])
    await runEgressChaosDetectionCron(pool, { Sentry })

    const opts = Sentry.captureMessage.mock.calls[0][1]
    expect(typeof opts.tags.mailbox_id).toBe('string')
    expect(opts.tags.mailbox_id).toBe('99')
  })
})

// F05: tags.component = egress_chaos_detection
describe('F05 tags.component correct', () => {
  it('component tag is egress_chaos_detection', async () => {
    const Sentry = makeSentry()
    const pool = makePool([CHAOS_ROW])
    await runEgressChaosDetectionCron(pool, { Sentry })

    const opts = Sentry.captureMessage.mock.calls[0][1]
    expect(opts.tags.component).toBe('egress_chaos_detection')
  })
})
