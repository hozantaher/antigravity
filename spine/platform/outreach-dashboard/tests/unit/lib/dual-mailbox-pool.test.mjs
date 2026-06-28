// Sprint S6.1 — dual mailbox pool primary/backup/legacy unit tests
// Tests pickActivePool + fetchEligibleMailboxes from campaign-send-batch.js.
//
// Pool mock: minimal pg Pool interface (query only).
// Real DB not required — all assertions operate on mock query responses.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { pickActivePool, fetchEligibleMailboxes } from '../../../src/lib/campaign-send-batch.js'

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mailbox row with sane defaults. */
function mb(id, overrides = {}) {
  return {
    id,
    smtp_username: `mb${id}@example.com`,
    password: 'password1234',
    smtp_host: 'smtp.example.com',
    smtp_port: 587,
    from_address: `mb${id}@example.com`,
    last_score: 90,
    circuit_opened_at: null,
    consecutive_bounces: 0,
    ...overrides,
  }
}

/**
 * Build a mock pool where pool.query() for SELECT returns the given rows
 * (only when called with ids array containing any element in `matchIds`),
 * and INSERT returns empty rows (audit log).
 *
 * @param {Map<number[], object[]>} plan  — id-set → rows to return
 */
function mockPool(plan) {
  return {
    query: vi.fn(async (sql, params) => {
      // INSERT (audit log) — always succeed, empty rows
      if (sql.trim().toUpperCase().startsWith('INSERT')) {
        return { rows: [] }
      }
      // SELECT — match by first param (array of ids)
      const queryIds = params?.[0] ?? []
      for (const [idSet, rows] of plan.entries()) {
        if (idSet.some(id => queryIds.includes(id))) {
          return { rows }
        }
      }
      return { rows: [] }
    }),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchEligibleMailboxes — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchEligibleMailboxes', () => {
  it('returns empty array when mailboxIds is empty', async () => {
    const pool = { query: vi.fn() }
    const result = await fetchEligibleMailboxes(pool, [])
    expect(result).toEqual([])
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('returns empty array when mailboxIds is null', async () => {
    const pool = { query: vi.fn() }
    const result = await fetchEligibleMailboxes(pool, null)
    expect(result).toEqual([])
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('passes ids to query and returns rows', async () => {
    const rows = [mb(1), mb(3)]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const result = await fetchEligibleMailboxes(pool, [1, 3])
    expect(result).toEqual(rows)
    expect(pool.query).toHaveBeenCalledOnce()
    const [sql, params] = pool.query.mock.calls[0]
    expect(sql).toContain('last_score >= 80')
    expect(sql).toContain('circuit_opened_at IS NULL')
    expect(sql).toContain('consecutive_bounces < 3')
    expect(params[0]).toEqual([1, 3])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// pickActivePool — core tier tests
// ─────────────────────────────────────────────────────────────────────────────

describe('pickActivePool — tier selection', () => {
  // T1: primary all healthy → use primary
  it('T1: primary all healthy → tier=primary', async () => {
    const pool = mockPool(new Map([
      [[1, 3], [mb(1), mb(3)]],
    ]))
    const cfg = { mailbox_pool_primary: [1, 3], mailbox_pool_backup: [631, 632], mailbox_pool: [999] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('primary')
    expect(result.mailboxes).toHaveLength(2)
  })

  // T2: primary all score <80 → fetchEligible returns [] → fallback backup
  it('T2: primary score <80 → fallback to backup', async () => {
    // primary ids [1,3] return empty (all unhealthy); backup ids [631,632] return rows
    const pool = mockPool(new Map([
      [[1, 3], []],           // primary unhealthy
      [[631, 632], [mb(631)]],  // backup healthy
    ]))
    const cfg = { mailbox_pool_primary: [1, 3], mailbox_pool_backup: [631, 632] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('backup')
    expect(result.mailboxes[0].id).toBe(631)
  })

  // T3: primary all circuit tripped → fallback backup
  it('T3: primary circuit tripped → fallback to backup', async () => {
    const pool = mockPool(new Map([
      [[1, 3], []],
      [[631, 632], [mb(631), mb(632)]],
    ]))
    const cfg = { mailbox_pool_primary: [1, 3], mailbox_pool_backup: [631, 632] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('backup')
    expect(result.mailboxes).toHaveLength(2)
  })

  // T4: primary all paused (status!=active, filtered by DB) → fallback backup
  it('T4: primary all paused (DB returns empty) → fallback backup', async () => {
    const pool = mockPool(new Map([
      [[10, 20], []],          // paused, DB returns nothing
      [[631], [mb(631)]],
    ]))
    const cfg = { mailbox_pool_primary: [10, 20], mailbox_pool_backup: [631] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('backup')
  })

  // T5: primary AND backup all unhealthy → fallback legacy
  it('T5: primary+backup unhealthy → fallback legacy', async () => {
    const pool = mockPool(new Map([
      [[1, 3], []],
      [[631, 632], []],
      [[999], [mb(999)]],
    ]))
    const cfg = { mailbox_pool_primary: [1, 3], mailbox_pool_backup: [631, 632], mailbox_pool: [999] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('legacy')
    expect(result.mailboxes[0].id).toBe(999)
  })

  // T6: all tiers empty → throw error
  it('T6: all tiers empty → throws NO_MAILBOXES', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const cfg = { mailbox_pool_primary: [1], mailbox_pool_backup: [2], mailbox_pool: [3] }
    await expect(pickActivePool(pool, cfg, 457)).rejects.toMatchObject({
      code: 'NO_MAILBOXES',
      message: expect.stringContaining('no eligible mailboxes'),
    })
  })

  // T7: primary partial healthy (1 of 4) → use that 1 from primary, no fallback
  it('T7: primary 1-of-4 healthy → use primary (no fallback)', async () => {
    const pool = mockPool(new Map([
      [[1, 2, 3, 4], [mb(2)]],  // only id=2 returned (others filtered by DB)
      [[631], [mb(631)]],        // backup also healthy but should not be used
    ]))
    const cfg = { mailbox_pool_primary: [1, 2, 3, 4], mailbox_pool_backup: [631] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('primary')
    expect(result.mailboxes).toHaveLength(1)
    expect(result.mailboxes[0].id).toBe(2)
  })

  // T8: legacy only (no primary, no backup) → tier=legacy
  it('T8: no primary/backup configured → tier=legacy', async () => {
    const pool = mockPool(new Map([
      [[1, 3], [mb(1), mb(3)]],
    ]))
    const cfg = { mailbox_pool: [1, 3] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('legacy')
    expect(result.mailboxes).toHaveLength(2)
  })

  // T9: all three tiers configured → primary wins
  it('T9: primary+backup+legacy all healthy → primary wins', async () => {
    const pool = mockPool(new Map([
      [[1], [mb(1)]],
      [[2], [mb(2)]],
      [[3], [mb(3)]],
    ]))
    const cfg = { mailbox_pool_primary: [1], mailbox_pool_backup: [2], mailbox_pool: [3] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('primary')
    expect(result.mailboxes[0].id).toBe(1)
  })

  // T10: consecutive_bounces >= 3 excludes mailbox (DB filters, empty returned)
  it('T10: consecutive_bounces >=3 → excluded by DB query (empty primary → backup)', async () => {
    // The SQL WHERE clause filters out high-bounce mailboxes at DB level.
    // We simulate this by having primary return [] (as if all had bounces>=3).
    const pool = mockPool(new Map([
      [[5], []],         // primary: bouncy mailbox, DB returns nothing
      [[6], [mb(6)]],    // backup healthy
    ]))
    const cfg = { mailbox_pool_primary: [5], mailbox_pool_backup: [6] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('backup')
  })

  // T11: last_score NULL = eligible (new mailbox)
  it('T11: last_score NULL treated as eligible (new mailbox)', async () => {
    const newMailbox = mb(7, { last_score: null })
    const pool = mockPool(new Map([
      [[7], [newMailbox]],
    ]))
    const cfg = { mailbox_pool_primary: [7] }
    const result = await pickActivePool(pool, cfg, 457)
    expect(result.tier).toBe('primary')
    expect(result.mailboxes[0].last_score).toBeNull()
  })

  // T12: backup activation writes audit log
  it('T12: backup activation writes campaign_pool_failover audit log', async () => {
    const querySpy = vi.fn().mockImplementation(async (sql) => {
      if (sql.trim().toUpperCase().startsWith('INSERT')) return { rows: [] }
      if (sql.includes('$1::int[]')) {
        // Primary call (first SELECT) → empty; backup call → healthy
        if (querySpy.mock.calls.filter(c => c[0].includes('$1::int[]')).length <= 1) {
          return { rows: [] }
        }
        return { rows: [mb(631)] }
      }
      return { rows: [] }
    })
    const pool = { query: querySpy }
    const cfg = { mailbox_pool_primary: [1], mailbox_pool_backup: [631] }
    await pickActivePool(pool, cfg, 457)
    const auditCall = querySpy.mock.calls.find(c =>
      c[0].includes('campaign_pool_failover'),
    )
    expect(auditCall).toBeDefined()
    expect(auditCall[1][0]).toBe('457')  // campaignId as string
  })

  // T13: sending_config with no pool fields + no legacy → throws
  it('T13: empty sending_config (no fields at all) → throws NO_MAILBOXES', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await expect(pickActivePool(pool, {}, 457)).rejects.toMatchObject({ code: 'NO_MAILBOXES' })
  })

  // T14: null sending_config → throws NO_MAILBOXES (no crash)
  it('T14: null sending_config → throws gracefully', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    await expect(pickActivePool(pool, null, 457)).rejects.toMatchObject({ code: 'NO_MAILBOXES' })
  })
})
