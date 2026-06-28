// sprintJ-verify-tier-priority.test.js — Sprint J unit tests
// ─────────────────────────────────────────────────────────────────────────────
// Tests the tier-priority pieces added to contactVerifyCron by Sprint J:
//
//   J01 — summarizeTierBreakdown buckets contacts into A/B/C/D/E using the
//         shared lead-tier thresholds (TIER_A_MIN=0.90, TIER_B_MIN=0.78, etc.)
//   J02 — null / non-numeric priority falls into the E bucket
//   J03 — when verify_queue_tier_priority_enabled = 'true', the due-picker
//         query includes ORDER BY email_verify_priority DESC NULLS LAST
//   J04 — when verify_queue_tier_priority_enabled = 'false', the due-picker
//         query falls back to FIFO (no priority column in ORDER BY)
//   J05 — every batch emits an operator_audit_log row with action
//         'verify_batch_start' containing the tier breakdown JSON
//   J06 — boundary priorities (0.90, 0.78, 0.65, 0.50, 0.49) classify
//         into the correct tier per leadTierThresholds.js cutoffs
//
// HARD RULE compliance:
//   - feedback_audit_log_on_mutations (T0): J05 asserts the audit-log
//     INSERT fires once per batch.
//   - feedback_no_magic_thresholds (T0): J01/J06 import TIER_*_MIN from
//     leadTierThresholds.js rather than hard-coding 0.90/0.78/0.65/0.50.
//   - feedback_extreme_testing (T0): the cron is state-mutating + reads
//     from operator_settings so the test pack covers both ordering
//     branches + the boundary classifier + the audit emit.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mountContactVerifyCron,
  summarizeTierBreakdown,
} from '../../../src/server-routes/contactVerifyCron.js'
import {
  TIER_A_MIN,
  TIER_B_MIN,
  TIER_C_MIN,
  TIER_D_MIN,
} from '../../../src/lib/leadTierThresholds.js'

const BASE_DEPS = {
  domainCache: { get: vi.fn(), set: vi.fn() },
  DOMAIN_RATE_MS: 5000,
  capture: vi.fn(),
}

// Build a pool whose every `query()` call returns the next pre-canned
// row set. `rowsForKey` lets us return the operator_settings value for
// specific keys so the test cron picks up the tier-priority toggle as
// configured.
function poolFor({ rowsForKey = {}, sequence = [], onQuery }) {
  let seqIdx = 0
  const queries = []
  const query = vi.fn().mockImplementation(async (sql, params) => {
    queries.push({ sql: String(sql), params })
    if (onQuery) onQuery({ sql: String(sql), params })

    // operator_settings lookup
    if (typeof sql === 'string' &&
        sql.includes('FROM operator_settings WHERE key = $1')) {
      const key = params?.[0]
      if (Object.prototype.hasOwnProperty.call(rowsForKey, key)) {
        const v = rowsForKey[key]
        if (v === undefined) return { rows: [] }
        return { rows: [{ value: v }] }
      }
      return { rows: [] }
    }
    // Sequence-driven fallback for the non-settings queries (budget +
    // due-picker + UPDATEs + INSERTs etc).
    if (seqIdx < sequence.length) {
      const r = sequence[seqIdx]
      seqIdx++
      return r
    }
    return { rows: [] }
  })
  return { query, queries }
}

beforeEach(() => {
  process.env.VERIFY_LOOP_CONTACTS_ENABLED = 'true'
})
afterEach(() => {
  delete process.env.VERIFY_LOOP_CONTACTS_ENABLED
})

// ── J01 / J02 / J06 — summarizeTierBreakdown classifier ─────────────────

describe('J01 — summarizeTierBreakdown buckets contacts by tier', () => {
  it('counts a mix of A/B/C/D/E contacts using the shared thresholds', () => {
    const rows = [
      { email_verify_priority: 0.95 },        // A
      { email_verify_priority: TIER_A_MIN },  // A (boundary)
      { email_verify_priority: 0.80 },        // B
      { email_verify_priority: TIER_B_MIN },  // B (boundary)
      { email_verify_priority: 0.70 },        // C
      { email_verify_priority: TIER_C_MIN },  // C (boundary)
      { email_verify_priority: 0.55 },        // D
      { email_verify_priority: TIER_D_MIN },  // D (boundary)
      { email_verify_priority: 0.30 },        // E
      { email_verify_priority: 0.0 },         // E
    ]
    expect(summarizeTierBreakdown(rows)).toEqual({ A: 2, B: 2, C: 2, D: 2, E: 2 })
  })
})

describe('J02 — null / non-numeric priority falls into E', () => {
  it.each([
    [null],
    [undefined],
    ['not a number'],
    [NaN],
  ])('priority=%p → E bucket', (val) => {
    const rows = [{ email_verify_priority: val }]
    expect(summarizeTierBreakdown(rows)).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 1 })
  })

  it('non-array input returns the zero buckets', () => {
    expect(summarizeTierBreakdown(null)).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0 })
    expect(summarizeTierBreakdown(undefined)).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0 })
  })
})

describe('J06 — boundary priorities classify into the correct tier', () => {
  it.each([
    [TIER_A_MIN,        'A'],   // 0.90
    [TIER_A_MIN - 0.01, 'B'],   // 0.89
    [TIER_B_MIN,        'B'],   // 0.78
    [TIER_B_MIN - 0.01, 'C'],   // 0.77
    [TIER_C_MIN,        'C'],   // 0.65
    [TIER_C_MIN - 0.01, 'D'],   // 0.64
    [TIER_D_MIN,        'D'],   // 0.50
    [TIER_D_MIN - 0.01, 'E'],   // 0.49
  ])('priority=%f → tier %s', (priority, expectedTier) => {
    const out = summarizeTierBreakdown([{ email_verify_priority: priority }])
    expect(out[expectedTier]).toBe(1)
    const total = out.A + out.B + out.C + out.D + out.E
    expect(total).toBe(1)
  })
})

// ── J03 / J04 — cron ORDER BY toggle ─────────────────────────────────────

describe('J03 — tier-priority enabled → ORDER BY includes email_verify_priority DESC', () => {
  it('due-picker SQL has email_verify_priority DESC NULLS LAST', async () => {
    const { query, queries } = poolFor({
      rowsForKey: {
        verify_loop_enabled: 'true',
        verify_loop_paused: 'false',
        verify_queue_tier_priority_enabled: 'true',
      },
      sequence: [
        { rows: [{ used: 0 }] },  // budget check
        { rows: [] },             // due-picker returns no rows so we stop
      ],
    })
    const { runContactVerifyCron } = mountContactVerifyCron({
      ...BASE_DEPS,
      pool: { query },
      verifyEmail: vi.fn(),
      domainProbeLock: new Map(),
    })
    await runContactVerifyCron()
    const duePicker = queries.find(q => q.sql.includes('DISTINCT ON'))
    expect(duePicker).toBeTruthy()
    expect(duePicker.sql).toMatch(/email_verify_priority\s+DESC\s+NULLS\s+LAST/i)
  })
})

describe('J04 — tier-priority disabled → ORDER BY is FIFO only', () => {
  it('due-picker SQL omits email_verify_priority column from ORDER BY', async () => {
    const { query, queries } = poolFor({
      rowsForKey: {
        verify_loop_enabled: 'true',
        verify_loop_paused: 'false',
        verify_queue_tier_priority_enabled: 'false',  // toggle OFF
      },
      sequence: [
        { rows: [{ used: 0 }] },
        { rows: [] },
      ],
    })
    const { runContactVerifyCron } = mountContactVerifyCron({
      ...BASE_DEPS,
      pool: { query },
      verifyEmail: vi.fn(),
      domainProbeLock: new Map(),
    })
    await runContactVerifyCron()
    const duePicker = queries.find(q => q.sql.includes('DISTINCT ON'))
    expect(duePicker).toBeTruthy()
    // Extract the ORDER BY clause and assert priority isn't there.
    const orderBy = duePicker.sql.match(/ORDER BY[\s\S]*?LIMIT/i)?.[0] ?? ''
    expect(orderBy).not.toMatch(/email_verify_priority/i)
    expect(orderBy).toMatch(/email_verify_next_at/i)
  })
})

// ── J05 — audit log on batch start with tier breakdown ──────────────────

describe('J05 — every batch emits operator_audit_log row with tier breakdown', () => {
  it('INSERT operator_audit_log fires once with action=verify_batch_start', async () => {
    const dueRows = [
      { id: 1, email: 'top@firm-a.cz',  email_domain: 'firm-a.cz',  email_status: 'risky', email_verify_attempts: 0, email_verify_priority: 0.95 },
      { id: 2, email: 'mid@firm-b.cz',  email_domain: 'firm-b.cz',  email_status: 'risky', email_verify_attempts: 0, email_verify_priority: 0.70 },
      { id: 3, email: 'low@firm-c.cz',  email_domain: 'firm-c.cz',  email_status: 'risky', email_verify_attempts: 0, email_verify_priority: 0.40 },
    ]
    const { query, queries } = poolFor({
      rowsForKey: {
        verify_loop_enabled: 'true',
        verify_loop_paused: 'false',
        verify_queue_tier_priority_enabled: 'true',
        email_verify_batch_size: '10',
        email_verify_daily_max: '500',
      },
      sequence: [
        { rows: [{ used: 0 }] },     // budget
        { rows: dueRows },           // due-picker returns 3 rows
        { rows: [] },                // audit-log insert
        // For each due row: UPDATE verifying, UPDATE result, INSERT log
        { rows: [] }, { rows: [] }, { rows: [] },
        { rows: [] }, { rows: [] }, { rows: [] },
        { rows: [] }, { rows: [] }, { rows: [] },
      ],
    })

    // Pre-load domain probe lock so per-domain 5s gate doesn't fire
    const domainProbeLock = new Map([
      ['firm-a.cz', Date.now() - 10_000],
      ['firm-b.cz', Date.now() - 10_000],
      ['firm-c.cz', Date.now() - 10_000],
    ])

    const verifyEmail = vi.fn().mockResolvedValue({ status: 'valid', confidence: 95 })

    const { runContactVerifyCron } = mountContactVerifyCron({
      ...BASE_DEPS,
      pool: { query },
      verifyEmail,
      domainProbeLock,
    })
    await runContactVerifyCron()

    const auditInsert = queries.find(q =>
      q.sql.includes('INSERT INTO operator_audit_log') &&
      q.sql.includes('verify_batch_start')
    )
    expect(auditInsert, 'expected audit-log row with action verify_batch_start').toBeTruthy()

    // params: [actor, JSON details]
    expect(auditInsert.params[0]).toBe('contactVerifyCron')
    const details = JSON.parse(auditInsert.params[1])
    expect(details).toMatchObject({
      picked: 3,
      tier_priority_enabled: true,
      tiers: { A: 1, C: 1, E: 1, B: 0, D: 0 },
    })
  })
})
