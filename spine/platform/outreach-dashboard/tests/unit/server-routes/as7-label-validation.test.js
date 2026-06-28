// AS7 — Endpoint label validation post-migration audit tests.
// Sprint AS7 (migration 085) hardcoded endpoint labels. If the pool was already
// expanded, orphan pins may exist (labels in DB not in current WIREPROXY_POOL_CONFIG).
//
// This is an audit/structural test — not a migration change. The audit verifies:
//   T01 migration 085 SQL exists and is idempotent (WHERE pinned_endpoint_label IS NULL guard)
//   T02 migration 085 hardcoded labels are a known set (document contract)
//   T03 SQL uses round-robin assignment (row_number() OVER ORDER BY label)
//   T04 migration does NOT overwrite existing pins (WHERE guard check)
//   T05 migration 086 SQL creates partial index on send_events (AR8 fix)
//   T06 migration 087 SQL creates covering index on send_events (AR15 fix)
//   T07 migration 088 SQL fixes aggregate cap semantics (>= → >)
//   T08 migration 086 index name is idx_send_events_aggregate
//   T09 migration 087 index name is idx_send_events_mailbox_used_recent
//   T10 all three new migrations use IF NOT EXISTS / ON CONFLICT DO NOTHING (idempotent)

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../../../../../scripts/migrations')

function readMigration(filename) {
  return readFileSync(resolve(MIGRATIONS_DIR, filename), 'utf8')
}

describe('AS7 — migration 085 endpoint label contract', () => {
  it('T01 migration 085 exists and is idempotent (WHERE pinned_endpoint_label IS NULL)', () => {
    const sql = readMigration('085_backfill_pin_existing.sql')
    expect(sql).toContain('085_backfill_pin_existing')
    expect(sql).toContain('pinned_endpoint_label IS NULL')
  })

  it('T02 migration 085 contains known CZ+SK endpoint labels as of sprint', () => {
    const sql = readMigration('085_backfill_pin_existing.sql')
    // These labels were hardcoded in 085 — contract is documented here
    expect(sql).toContain('cz-prg-wg-101')
    expect(sql).toContain('cz-prg-wg-102')
    expect(sql).toContain('sk-bts-wg-201')
  })

  it('T03 migration 085 uses round-robin via row_number() OVER ORDER BY', () => {
    const sql = readMigration('085_backfill_pin_existing.sql')
    expect(sql).toContain('row_number()')
    expect(sql).toContain('ORDER BY')
  })

  it('T04 migration 085 does NOT overwrite existing pins (WHERE guard in CTE)', () => {
    const sql = readMigration('085_backfill_pin_existing.sql')
    // The guard lives in the unpinned CTE: WHERE pinned_endpoint_label IS NULL
    // The UPDATE joins against this CTE so only unpinned rows are updated
    expect(sql).toContain('pinned_endpoint_label IS NULL')
    // CTE named 'unpinned' must be defined with the IS NULL guard
    expect(sql).toContain('unpinned')
    // The UPDATE must join against the unpinned CTE (not do an unconditional SET)
    const updateBlock = sql.substring(sql.indexOf('UPDATE outreach_mailboxes'))
    expect(updateBlock).toContain('unpinned')
  })
})

describe('AS7 — migrations 086/087/088 index + semantics fixes', () => {
  it('T05 migration 086 creates partial index for AR8 aggregate query', () => {
    const sql = readMigration('086_send_events_aggregate_idx.sql')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_send_events_aggregate')
    expect(sql).toContain("status IN ('sent', 'queued')")
    expect(sql).toContain('send_events')
  })

  it('T06 migration 087 creates covering index for AR15 mailbox_used query', () => {
    const sql = readMigration('087_send_events_mailbox_used_partial_idx.sql')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_send_events_mailbox_used_recent')
    expect(sql).toContain('mailbox_used')
    expect(sql).toContain('sent_at DESC')
    expect(sql).toContain('send_events')
  })

  it('T07 migration 088 uses > (not >=) in the live SQL function body', () => {
    const sql = readMigration('088_fix_aggregate_cap_semantics.sql')
    // The CREATE OR REPLACE FUNCTION body must use > (strictly greater than)
    expect(sql).toContain('count(*) > max_sends')
    // The count >= form should only appear in comments (describing old behavior)
    // Strip single-line SQL comments before checking
    const sqlNoComments = sql.replace(/--[^\n]*/g, '')
    expect(sqlNoComments).not.toContain('count(*) >= max_sends')
  })

  it('T08 migration 086 index name is idx_send_events_aggregate', () => {
    const sql = readMigration('086_send_events_aggregate_idx.sql')
    expect(sql).toContain('idx_send_events_aggregate')
  })

  it('T09 migration 087 index name is idx_send_events_mailbox_used_recent', () => {
    const sql = readMigration('087_send_events_mailbox_used_partial_idx.sql')
    expect(sql).toContain('idx_send_events_mailbox_used_recent')
  })

  it('T10 all three new migrations are idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING)', () => {
    const m086 = readMigration('086_send_events_aggregate_idx.sql')
    const m087 = readMigration('087_send_events_mailbox_used_partial_idx.sql')
    const m088 = readMigration('088_fix_aggregate_cap_semantics.sql')

    for (const [name, sql] of [['086', m086], ['087', m087], ['088', m088]]) {
      expect(sql, `${name} missing IF NOT EXISTS or CREATE OR REPLACE`)
        .toMatch(/IF NOT EXISTS|CREATE OR REPLACE/)
      expect(sql, `${name} missing ON CONFLICT DO NOTHING`)
        .toContain('ON CONFLICT DO NOTHING')
    }
  })
})
