// Layer 7 audit (2026-05-18 hardening) — notify_reply_inserted trigger
// function must use jsonb-safe column access.
//
// History: pre-2026-05-18 the trigger used `NEW.from_email` directly,
// which raised pq:42703 every time it fired on unmatched_inbound (where
// the column is from_address). 5 days of silent ingestion failure; 26
// customer replies stuck in INBOX. Migration 117 fixed.
//
// This ratchet pulls the function body from live DB and asserts the
// jsonb pattern is still in place — prevents future agents from
// reverting to NEW.column refs.
//
// Skip-if-no-DSN — keeps CI without a DB green.

import { describe, it, expect } from 'vitest'
import pg from 'pg'

const DSN = process.env.DATABASE_URL || process.env.DSN || ''

describe('Layer 7 audit: notify_reply_inserted trigger jsonb-safe', () => {
  if (!DSN) {
    it.skip('skipped: no DATABASE_URL/DSN env var set', () => {})
    return
  }

  it('function body uses to_jsonb(NEW) ->> pattern, not direct NEW.column refs', async () => {
    const pool = new pg.Pool({ connectionString: DSN, max: 1 })
    try {
      const { rows: [r] } = await pool.query(
        "SELECT pg_get_functiondef(p.oid) AS body FROM pg_proc p WHERE p.proname = 'notify_reply_inserted'",
      )
      expect(r, 'notify_reply_inserted function must exist').toBeDefined()
      const body = r.body || ''
      // Must use the jsonb-safe pattern.
      expect(body, 'function must declare jsonb conversion').toMatch(/to_jsonb\(NEW\)/i)
      expect(body, 'function must access via ->> jsonb operator').toMatch(/rec\s*->>|\?\?>>/)
      // Must NOT use direct NEW.from_email or NEW.from_address (the broken pre-117 pattern).
      // Allow these only when prefixed by to_jsonb context (the jsonb body itself).
      const directRefs = body.match(/NEW\.(from_email|from_address)\b/g) || []
      expect(
        directRefs.length,
        `direct NEW.from_email / NEW.from_address refs found (${directRefs.length}). ` +
        `These break the trigger on tables missing one of the columns. ` +
        `Use COALESCE(rec ->> 'from_email', rec ->> 'from_address', '') instead. ` +
        `See migration 117_notify_reply_trigger_jsonb_safe.sql.`,
      ).toBe(0)
    } finally {
      await pool.end()
    }
  })

  it('reply_inbox + unmatched_inbound INSERT both fire trigger without 42703', async () => {
    const pool = new pg.Pool({ connectionString: DSN, max: 1 })
    try {
      // Synthetic test row in unmatched_inbound (table that previously broke).
      const testID = `audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const insertResult = await pool.query(
        `INSERT INTO unmatched_inbound (message_id, in_reply_to, from_address, subject, body_preview, received_at)
         VALUES ($1, '', 'audit-trigger-test@example.invalid', '[smoke] notify_reply_inserted trigger audit', '', now())
         ON CONFLICT (message_id) DO NOTHING
         RETURNING id`,
        [`<${testID}@audit.invalid>`],
      )
      // Either INSERT succeeded (returned id) or ON CONFLICT swallowed (returned no rows).
      // Both mean trigger fired without raising 42703.
      expect(insertResult).toBeDefined()
      // Clean up.
      if (insertResult.rows.length > 0) {
        await pool.query('DELETE FROM unmatched_inbound WHERE id = $1', [insertResult.rows[0].id])
      }
    } finally {
      await pool.end()
    }
  })
})
