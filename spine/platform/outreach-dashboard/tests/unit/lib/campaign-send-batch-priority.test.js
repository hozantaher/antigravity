// campaign-send-batch-priority.test.js
//
// Lead-score-priority ordering tests for the SendBatchPanel pipeline
// (migration 111 — campaign_contacts.priority REAL, idx_campaign_contacts_priority).
//
// Surface covered:
//   - tierFromPriority() — boundary cases for A/B/C/D/E classification
//   - computeTierBreakdown() — aggregates a row list by tier
//   - sendCampaignBatch() — SELECT cohort SQL contains the new ORDER BY
//   - sendCampaignBatch() — result includes tier_breakdown computed from
//     the LIA-approved cohort
//   - sendCampaignBatch() — batch-audit-log row carries tier_breakdown
//
// Risk-proportional: this PR mutates send ordering AND state. 10+ tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  tierFromPriority,
  computeTierBreakdown,
  sendCampaignBatch,
} from '../../../src/lib/campaign-send-batch.js'

describe('tierFromPriority()', () => {
  it('classifies 0.95 → A', () => expect(tierFromPriority(0.95)).toBe('A'))
  it('classifies 0.90 boundary → A (inclusive)', () => expect(tierFromPriority(0.90)).toBe('A'))
  it('classifies 0.89 → B', () => expect(tierFromPriority(0.89)).toBe('B'))
  it('classifies 0.78 boundary → B (inclusive)', () => expect(tierFromPriority(0.78)).toBe('B'))
  it('classifies 0.77 → C', () => expect(tierFromPriority(0.77)).toBe('C'))
  it('classifies 0.65 boundary → C (inclusive)', () => expect(tierFromPriority(0.65)).toBe('C'))
  it('classifies 0.50 boundary → D (inclusive)', () => expect(tierFromPriority(0.50)).toBe('D'))
  it('classifies 0.49 → E', () => expect(tierFromPriority(0.49)).toBe('E'))
  it('classifies 0 → E', () => expect(tierFromPriority(0)).toBe('E'))
  it('classifies null → E (default fallback)', () => expect(tierFromPriority(null)).toBe('E'))
  it('classifies undefined → E', () => expect(tierFromPriority(undefined)).toBe('E'))
  it('classifies NaN → E', () => expect(tierFromPriority(NaN)).toBe('E'))
})

describe('computeTierBreakdown()', () => {
  it('returns all-zero shape for empty array', () => {
    expect(computeTierBreakdown([])).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0 })
  })

  it('returns all-zero shape for null/undefined input', () => {
    expect(computeTierBreakdown(null)).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0 })
    expect(computeTierBreakdown(undefined)).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0 })
  })

  it('aggregates rows by tier', () => {
    const rows = [
      { priority: 0.95 }, { priority: 0.92 }, { priority: 0.80 },
      { priority: 0.70 }, { priority: 0.60 }, { priority: 0.10 },
    ]
    expect(computeTierBreakdown(rows)).toEqual({ A: 2, B: 1, C: 1, D: 1, E: 1 })
  })

  it('treats missing priority as E-tier', () => {
    const rows = [{ priority: null }, {}, { priority: 0.99 }]
    expect(computeTierBreakdown(rows)).toEqual({ A: 1, B: 0, C: 0, D: 0, E: 2 })
  })
})

// ─── sendCampaignBatch() SQL ordering ────────────────────────────────────────
//
// We mock the pg pool + client and assert (a) the cohort SELECT carries the
// new ORDER BY clause and (b) the resulting tier_breakdown is computed and
// flowed into the audit log.

function makeClient(queryFn) {
  return {
    _log: [],
    async query(sql, params) {
      this._log.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      return queryFn(sql, params)
    },
    async release() {},
  }
}

function makePool({ poolQuery, client }) {
  return {
    async connect() { return client },
    async query(sql, params) { return poolQuery(sql, params) },
  }
}

describe('sendCampaignBatch — lead-score ORDER BY', () => {
  let client, pool, poolCalls

  beforeEach(() => {
    poolCalls = []
  })

  function mkSetup({ cohort = [], tplBody = 'Hello {{firma}}', sendingCfg = { mailbox_pool: [1] } } = {}) {
    // Pool answers in order:
    //   1) AR8 aggregate-cap function → not exceeded
    //   2) LIA scope row → empty (use legacy fallback)
    //   3) Campaign SELECT
    //   4) Template SELECT
    //   5) Mailbox eligibility SELECT (returns [{id:1,...}])
    //   6..n) Per-contact audit/idempotency/update queries
    //   last) batch-level INSERT operator_audit_log
    const audits = []

    const queryFn = (sql, params) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      poolCalls.push({ sql: s, params })

      if (s.includes('check_aggregate_volume_cap')) {
        return { rows: [{ exceeded: false, sends_in_window: 0, cap: 50 }] }
      }
      if (s.includes('FROM operator_settings WHERE key = \'lia_nace_scope\'')) {
        return { rows: [] }
      }
      if (s.includes('FROM campaigns WHERE id=$1')) {
        return { rows: [{
          id: 457, name: 'Test',
          sequence_config: [{ template: 'cold-1' }],
          sending_config: sendingCfg,
        }] }
      }
      if (s.includes('FROM email_templates WHERE name=$1')) {
        return { rows: [{
          id: 1, name: 'cold-1', subject: 'Hi', body: tplBody, body_html: '',
        }] }
      }
      if (s.includes('FROM outreach_mailboxes')) {
        return { rows: [{
          id: 1, smtp_username: 'mb@seznam.cz', password: 'super-strong-pw',
          smtp_host: 'smtp.seznam.cz', smtp_port: 465, from_address: 'mb@seznam.cz',
          imap_host: 'imap.seznam.cz', imap_port: 993,
          last_score: 90, circuit_opened_at: null, consecutive_bounces: 0,
        }] }
      }
      // Idempotency check
      if (s.includes('operator_audit_log') && s.includes("action='campaign_contact_send'")) {
        return { rows: [] }
      }
      // LIA skip revert / status updates / audit best-effort inserts
      if (s.includes('INSERT INTO operator_audit_log')) {
        audits.push({ sql: s, params })
        return { rows: [], rowCount: 1 }
      }
      if (s.includes('UPDATE campaign_contacts')) {
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    client = makeClient((sql) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (s.includes('FROM campaign_contacts cc')) {
        return { rows: cohort }
      }
      if (s.includes("status='queued'")) {
        return { rows: [], rowCount: cohort.length }
      }
      return { rows: [], rowCount: 0 }
    })

    pool = makePool({ poolQuery: queryFn, client })
    return { audits }
  }

  it('cohort SELECT uses priority DESC NULLS LAST as primary ORDER BY', async () => {
    mkSetup({ cohort: [] })
    // Fake fetch to keep relay happy (no contacts → no fetch anyway)
    global.fetch = vi.fn().mockResolvedValue({ text: async () => '{}' })

    await sendCampaignBatch({
      pool, campaignId: 457, count: 10,
      relayURL: 'http://relay', relayToken: 't',
    })

    const cohortSelect = client._log.find(e =>
      e.sql.includes('FROM campaign_contacts cc') && e.sql.includes('FOR UPDATE')
    )
    expect(cohortSelect).toBeDefined()
    expect(cohortSelect.sql).toMatch(/ORDER BY cc\.priority DESC NULLS LAST/)
    expect(cohortSelect.sql).toMatch(/cc\.next_send_at ASC NULLS FIRST/)
    expect(cohortSelect.sql).toMatch(/cc\.contact_id ASC/)
    expect(cohortSelect.sql).toMatch(/FOR UPDATE OF cc SKIP LOCKED/)
    // SELECT must surface priority for downstream tier_breakdown
    expect(cohortSelect.sql).toMatch(/cc\.priority/)
  })

  it('cohort SELECT preserves the WHERE clause + LIMIT $2', async () => {
    mkSetup({ cohort: [] })
    global.fetch = vi.fn().mockResolvedValue({ text: async () => '{}' })

    await sendCampaignBatch({
      pool, campaignId: 457, count: 7,
      relayURL: 'http://relay', relayToken: 't',
    })

    const cohortSelect = client._log.find(e =>
      e.sql.includes('FROM campaign_contacts cc') && e.sql.includes('FOR UPDATE')
    )
    expect(cohortSelect.sql).toMatch(/WHERE cc\.campaign_id=\$1 AND cc\.status='pending'/)
    expect(cohortSelect.sql).toMatch(/LIMIT \$2/)
    expect(cohortSelect.params).toEqual([457, 7])
  })

  it('result envelopes carry tier_breakdown computed from cohort priorities', async () => {
    const cohort = [
      { cc_id: 1, contact_id: 100, status: 'pending', priority: 0.95,
        email: 'a@b.cz', first_name: 'A', last_name: 'B', company_name: 'F1',
        region: 'P', ico: '1', nace_codes: ['41200'] },
      { cc_id: 2, contact_id: 101, status: 'pending', priority: 0.82,
        email: 'c@d.cz', first_name: 'C', last_name: 'D', company_name: 'F2',
        region: 'P', ico: '2', nace_codes: ['43110'] },
      { cc_id: 3, contact_id: 102, status: 'pending', priority: 0.40,
        email: 'e@f.cz', first_name: 'E', last_name: 'F', company_name: 'F3',
        region: 'P', ico: '3', nace_codes: ['42110'] },
    ]
    mkSetup({ cohort })

    // Relay rejects everything → 0 sends, but tier_breakdown still computed.
    global.fetch = vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ error: 'relay down' }),
    })

    const result = await sendCampaignBatch({
      pool, campaignId: 457, count: 10,
      relayURL: 'http://relay', relayToken: 't',
    })

    expect(result.tier_breakdown).toBeDefined()
    expect(result.tier_breakdown).toEqual({ A: 1, B: 1, C: 0, D: 0, E: 1 })
  })

  it('batch-level audit INSERT includes tier_breakdown payload', async () => {
    const cohort = [
      { cc_id: 1, contact_id: 100, status: 'pending', priority: 0.92,
        email: 'a@b.cz', first_name: 'A', last_name: 'B', company_name: 'F1',
        region: 'P', ico: '1', nace_codes: ['41200'] },
    ]
    const { audits } = mkSetup({ cohort })
    global.fetch = vi.fn().mockResolvedValue({
      text: async () => JSON.stringify({ envelope_id: 'env-1' }),
    })

    await sendCampaignBatch({
      pool, campaignId: 457, count: 5,
      relayURL: 'http://relay', relayToken: 't',
    })

    const batchAudit = audits.find(a => a.sql.includes("'campaign_send_batch'"))
    expect(batchAudit).toBeDefined()
    // tier_breakdown is the 8th positional param (after requested/picked/sent/...).
    const tierJson = batchAudit.params[7]
    expect(typeof tierJson).toBe('string')
    const parsed = JSON.parse(tierJson)
    expect(parsed).toEqual({ A: 1, B: 0, C: 0, D: 0, E: 0 })
  })
})
