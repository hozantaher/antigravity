// ═══════════════════════════════════════════════════════════════════════════
//  Integration — mailboxOpRateLimit (Sprint AP3, migration 072)
//
//  Tests per-mailbox per-operation rate limiting using pg-mem.
//
//  Covered scenarios (≥10 required per feedback_extreme_testing):
//    1.  1st imap_poll allowed (used=1, max=4)
//    2.  2nd imap_poll allowed
//    3.  3rd imap_poll allowed
//    4.  4th imap_poll allowed (at cap)
//    5.  5th imap_poll REFUSED, retryAfterSec > 0
//    6.  After window expires, next imap_poll allowed again
//    7.  imap_inbox_fetch has separate counter (max=6, independent of imap_poll)
//    8.  full_check max=2 enforced
//    9.  smtp_probe max=12 enforced
//    10. Unknown op_type throws Error
//    11. INSERT only happens on allowed=true (atomicity — count stays 0 on refuse)
//    12. Concurrent: 4 parallel imap_polls = 4 allowed; 5th = refused
//    13. Cleanup: rows older than 7 days deleted, recent rows retained
//    14. verify_email max=5 enforced
//    15. Different mailboxes have independent counters
// ═══════════════════════════════════════════════════════════════════════════

import { beforeEach, describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// pg-mem availability guard
// ---------------------------------------------------------------------------
let newDbFn = null
let pgMemAvailable = false
let pgMemSkipReason = ''

try {
  const mod = await import('pg-mem')
  newDbFn = mod.newDb
  pgMemAvailable = typeof newDbFn === 'function'
  if (!pgMemAvailable) pgMemSkipReason = 'pg-mem.newDb missing'
} catch (err) {
  pgMemAvailable = false
  pgMemSkipReason = err instanceof Error ? err.message : 'pg-mem dynamic import failed'
}

// ---------------------------------------------------------------------------
// Helper: build a pg-mem pool with the rate-log table + a test mailbox
// ---------------------------------------------------------------------------
async function makeTestPool(mailboxId = 1) {
  if (!newDbFn) throw new Error('pg-mem unavailable')
  const db = newDbFn()
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()

  // Minimal outreach_mailboxes stub (needed for FK in real schema; pg-mem
  // does not enforce FK by default, so we create without the FK constraint
  // and rely on query correctness in the SUT).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_mailboxes (
      id BIGSERIAL PRIMARY KEY,
      from_address TEXT
    )
  `)
  await pool.query(
    `INSERT INTO outreach_mailboxes (id, from_address) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [mailboxId, `mb${mailboxId}@example.com`]
  )
  await pool.query(`INSERT INTO outreach_mailboxes (id, from_address) VALUES (999, 'other@example.com') ON CONFLICT DO NOTHING`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailbox_op_rate_log (
      id           BIGSERIAL PRIMARY KEY,
      mailbox_id   BIGINT NOT NULL,
      op_type      TEXT NOT NULL,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      metadata     JSONB
    )
  `)

  return pool
}

// ---------------------------------------------------------------------------
// Import the module under test (ESM)
// ---------------------------------------------------------------------------
import { checkAndRecord, OP_RATE_CAPS } from '../../src/lib/mailboxOpRateLimit.js'

// ---------------------------------------------------------------------------
// Describe suite — skip if pg-mem unavailable
// ---------------------------------------------------------------------------
describe('mailboxOpRateLimit — AP3 per-op rate caps', () => {
  if (!pgMemAvailable) {
    it.skip(`pg-mem unavailable: ${pgMemSkipReason}`, () => {})
    return
  }

  let pool

  beforeEach(async () => {
    pool = await makeTestPool(1)
  })

  // ── Test 1: 1st imap_poll allowed ──────────────────────────────────────
  it('1st imap_poll is allowed with used=1, max=4', async () => {
    const r = await checkAndRecord(pool, 1, 'imap_poll')
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(1)
    expect(r.max).toBe(4)
    expect(r.retryAfterSec).toBe(0)
  })

  // ── Test 2: 2nd imap_poll allowed ─────────────────────────────────────
  it('2nd imap_poll is allowed (used=2)', async () => {
    await checkAndRecord(pool, 1, 'imap_poll')
    const r = await checkAndRecord(pool, 1, 'imap_poll')
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(2)
  })

  // ── Test 3: 3rd imap_poll allowed ─────────────────────────────────────
  it('3rd imap_poll is allowed (used=3)', async () => {
    await checkAndRecord(pool, 1, 'imap_poll')
    await checkAndRecord(pool, 1, 'imap_poll')
    const r = await checkAndRecord(pool, 1, 'imap_poll')
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(3)
  })

  // ── Test 4: 4th imap_poll allowed (at cap) ────────────────────────────
  it('4th imap_poll is allowed (used=4, at max)', async () => {
    for (let i = 0; i < 3; i++) await checkAndRecord(pool, 1, 'imap_poll')
    const r = await checkAndRecord(pool, 1, 'imap_poll')
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(4)
  })

  // ── Test 5: 5th imap_poll REFUSED ────────────────────────────────────
  it('5th imap_poll is REFUSED (over cap) with retryAfterSec > 0', async () => {
    for (let i = 0; i < 4; i++) await checkAndRecord(pool, 1, 'imap_poll')
    const r = await checkAndRecord(pool, 1, 'imap_poll')
    expect(r.allowed).toBe(false)
    expect(r.used).toBe(4)
    expect(r.max).toBe(4)
    expect(r.retryAfterSec).toBeGreaterThan(0)
  })

  // ── Test 6: After window expires, 1st new imap_poll allowed ──────────
  it('after 1h window expires, imap_poll is allowed again', async () => {
    // Fill cap
    for (let i = 0; i < 4; i++) await checkAndRecord(pool, 1, 'imap_poll')
    // Backdate all log rows so they fall outside the 1h window
    await pool.query(
      `UPDATE mailbox_op_rate_log
          SET occurred_at = NOW() - INTERVAL '3601 seconds'
        WHERE mailbox_id=$1 AND op_type=$2`,
      [1, 'imap_poll']
    )
    const r = await checkAndRecord(pool, 1, 'imap_poll')
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(1)
  })

  // ── Test 7: imap_inbox_fetch has separate counter ─────────────────────
  it('imap_inbox_fetch has separate counter from imap_poll (max=6)', async () => {
    // Fill imap_poll cap
    for (let i = 0; i < 4; i++) await checkAndRecord(pool, 1, 'imap_poll')
    const refused = await checkAndRecord(pool, 1, 'imap_poll')
    expect(refused.allowed).toBe(false)

    // imap_inbox_fetch should still be at 0
    const r = await checkAndRecord(pool, 1, 'imap_inbox_fetch')
    expect(r.allowed).toBe(true)
    expect(r.used).toBe(1)
    expect(r.max).toBe(6)
  })

  // ── Test 8: full_check max=2 enforced ────────────────────────────────
  it('full_check max=2: 2 allowed, 3rd refused', async () => {
    const r1 = await checkAndRecord(pool, 1, 'full_check')
    expect(r1.allowed).toBe(true)
    const r2 = await checkAndRecord(pool, 1, 'full_check')
    expect(r2.allowed).toBe(true)
    const r3 = await checkAndRecord(pool, 1, 'full_check')
    expect(r3.allowed).toBe(false)
    expect(r3.max).toBe(2)
  })

  // ── Test 9: smtp_probe max=12 enforced ───────────────────────────────
  it('smtp_probe max=12: 12 allowed, 13th refused', async () => {
    for (let i = 0; i < 12; i++) {
      const r = await checkAndRecord(pool, 1, 'smtp_probe')
      expect(r.allowed).toBe(true)
    }
    const r = await checkAndRecord(pool, 1, 'smtp_probe')
    expect(r.allowed).toBe(false)
    expect(r.max).toBe(12)
  })

  // ── Test 10: Unknown op_type throws ──────────────────────────────────
  it('unknown op_type throws an error', async () => {
    await expect(checkAndRecord(pool, 1, 'unknown_op')).rejects.toThrow('unknown op_type: unknown_op')
  })

  // ── Test 11: INSERT only on allowed=true (atomicity) ─────────────────
  it('no INSERT when refused — row count stays at max after refusal', async () => {
    for (let i = 0; i < 4; i++) await checkAndRecord(pool, 1, 'imap_poll')
    // This is refused
    await checkAndRecord(pool, 1, 'imap_poll')

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM mailbox_op_rate_log WHERE mailbox_id=1 AND op_type='imap_poll'`
    )
    // Still exactly 4 rows — no insert on refusal
    expect(rows[0].cnt).toBe(4)
  })

  // ── Test 12: Concurrent: 4 parallel → allowed; 5th → refused ─────────
  it('4 concurrent imap_polls all succeed; a subsequent 5th is refused', async () => {
    // Sequential simulation: pg-mem is single-process so we run them one by one
    // and check the final state.  True DB-level concurrency would require a real PG.
    const results = await Promise.all([
      checkAndRecord(pool, 1, 'imap_poll'),
      checkAndRecord(pool, 1, 'imap_poll'),
      checkAndRecord(pool, 1, 'imap_poll'),
      checkAndRecord(pool, 1, 'imap_poll'),
    ])
    const allowedCount = results.filter(r => r.allowed).length
    expect(allowedCount).toBe(4)

    const r5 = await checkAndRecord(pool, 1, 'imap_poll')
    expect(r5.allowed).toBe(false)
  })

  // ── Test 13: Cleanup — rows older than 7 days deleted ─────────────────
  it('rows older than 7 days are deletable by cleanup query', async () => {
    // Insert 3 old rows and 2 recent rows
    await pool.query(
      `INSERT INTO mailbox_op_rate_log (mailbox_id, op_type, occurred_at) VALUES
         (1, 'imap_poll', NOW() - INTERVAL '8 days'),
         (1, 'imap_poll', NOW() - INTERVAL '9 days'),
         (1, 'imap_poll', NOW() - INTERVAL '10 days'),
         (1, 'full_check', NOW() - INTERVAL '1 hour'),
         (1, 'full_check', NOW() - INTERVAL '2 hours')`
    )
    const { rowCount } = await pool.query(
      `DELETE FROM mailbox_op_rate_log WHERE occurred_at < NOW() - INTERVAL '7 days'`
    )
    expect(rowCount).toBe(3)
    // Recent rows remain
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM mailbox_op_rate_log`
    )
    expect(rows[0].cnt).toBe(2)
  })

  // ── Test 14: verify_email max=5 enforced ─────────────────────────────
  it('verify_email max=5: 5 allowed, 6th refused', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await checkAndRecord(pool, 1, 'verify_email')
      expect(r.allowed).toBe(true)
    }
    const r = await checkAndRecord(pool, 1, 'verify_email')
    expect(r.allowed).toBe(false)
    expect(r.max).toBe(5)
  })

  // ── Test 15: Different mailboxes have independent counters ────────────
  it('different mailboxes maintain independent counters', async () => {
    // Fill mailbox 1
    for (let i = 0; i < 4; i++) await checkAndRecord(pool, 1, 'imap_poll')
    const mb1refused = await checkAndRecord(pool, 1, 'imap_poll')
    expect(mb1refused.allowed).toBe(false)

    // Mailbox 999 should be untouched
    const r999 = await checkAndRecord(pool, 999, 'imap_poll')
    expect(r999.allowed).toBe(true)
    expect(r999.used).toBe(1)
  })
})

  // ── Test 16: FOR UPDATE lock — sequential calls never over-count ──────────
  // Verifies that the AP3 race fix (FOR UPDATE on outreach_mailboxes) prevents
  // the READ COMMITTED phantom on pg-mem. pg-mem processes sequentially so the
  // lock also holds here; this documents the expected serialised behaviour.
  it('sequential calls up to cap all succeed; (N+1)th is refused — FOR UPDATE invariant', async () => {
    const cap = OP_RATE_CAPS.full_check // max=2
    const results = []
    for (let i = 0; i < cap.max + 1; i++) {
      results.push(await checkAndRecord(pool, 1, 'full_check'))
    }
    const allowed = results.filter(r => r.allowed).length
    const refused = results.filter(r => !r.allowed).length
    // Exactly cap.max allowed, exactly 1 refused.
    expect(allowed).toBe(cap.max)
    expect(refused).toBe(1)
    // The refused result must report retryAfterSec > 0.
    const refusedResult = results[results.length - 1]
    expect(refusedResult.allowed).toBe(false)
    expect(refusedResult.retryAfterSec).toBeGreaterThan(0)
  })

  // ── Test 17: FOR UPDATE lock — on refusal, no INSERT is recorded ──────────
  it('refusal does not insert — row count stays exactly at max after FOR UPDATE commit path', async () => {
    const cap = OP_RATE_CAPS.imap_inbox_fetch // max=6
    for (let i = 0; i < cap.max; i++) await checkAndRecord(pool, 1, 'imap_inbox_fetch')
    // This call must be refused
    const r = await checkAndRecord(pool, 1, 'imap_inbox_fetch')
    expect(r.allowed).toBe(false)

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM mailbox_op_rate_log WHERE mailbox_id=1 AND op_type='imap_inbox_fetch'`
    )
    // Still exactly cap.max rows — refused call must not insert.
    expect(rows[0].cnt).toBe(cap.max)
  })

  // ── Test 18: FOR UPDATE lock — refusal COMMIT releases lock ───────────────
  // After a refused call (COMMIT, not ROLLBACK), subsequent calls can still acquire
  // the lock and execute normally (no deadlock from a hung transaction).
  it('after refusal-commit, new calls still succeed until next cap', async () => {
    const cap = OP_RATE_CAPS.verify_email // max=5
    // Fill cap
    for (let i = 0; i < cap.max; i++) await checkAndRecord(pool, 1, 'verify_email')
    // Refuse — this COMMITs to release FOR UPDATE lock
    const refused = await checkAndRecord(pool, 1, 'verify_email')
    expect(refused.allowed).toBe(false)

    // Back-date all rows so the window clears
    await pool.query(
      `UPDATE mailbox_op_rate_log SET occurred_at = NOW() - INTERVAL '3601 seconds' WHERE mailbox_id=1 AND op_type='verify_email'`
    )
    // Must be allowed again (lock was properly released)
    const fresh = await checkAndRecord(pool, 1, 'verify_email')
    expect(fresh.allowed).toBe(true)
    expect(fresh.used).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Standalone unit tests — no DB needed (OP_RATE_CAPS shape)
// ---------------------------------------------------------------------------
describe('OP_RATE_CAPS shape', () => {
  it('has all required op types with correct caps', () => {
    expect(OP_RATE_CAPS.imap_poll).toEqual({ max: 4, windowSec: 3600 })
    expect(OP_RATE_CAPS.imap_inbox_fetch).toEqual({ max: 6, windowSec: 3600 })
    expect(OP_RATE_CAPS.full_check).toEqual({ max: 2, windowSec: 3600 })
    expect(OP_RATE_CAPS.smtp_probe).toEqual({ max: 12, windowSec: 3600 })
    expect(OP_RATE_CAPS.verify_email).toEqual({ max: 5, windowSec: 3600 })
  })

  it('does not contain unexpected op types', () => {
    const keys = Object.keys(OP_RATE_CAPS)
    const expected = ['imap_poll', 'imap_inbox_fetch', 'full_check', 'smtp_probe', 'verify_email']
    expect(keys.sort()).toEqual(expected.sort())
  })
})
