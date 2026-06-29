#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// AV-F2 — one-shot backfill: classify every existing reply
// ════════════════════════════════════════════════════════════════════════
//
// Iterates EVERY row in reply_inbox + unmatched_inbound, runs the regex
// classifier (apps/outreach-dashboard/src/lib/replyClassifier.js), writes a
// row into reply_classifications_log, and — when confidence ≥
// AUTO_APPLY_THRESHOLD AND the source row is still un-handled —
// auto-applies the verdict to the source classification + handled flag.
//
// Idempotent: re-runs short-circuit on the unique (reply_id,
// classifier_version) index. Safe to run multiple times.
//
// Usage:
//   DATABASE_URL=... node scripts/backfill-classify-existing.js
//   DATABASE_URL=... node scripts/backfill-classify-existing.js --dry-run
//
// Memory:
//   feedback_no_pii_in_commands — no body content echoed to stdout.

import pg from 'pg'
import {
  autoClassifyReply,
} from '../apps/outreach-dashboard/src/server-routes/replyClassifyEndpoint.js'

const DRY_RUN = process.argv.includes('--dry-run')

async function main() {
  const dsn = process.env.DATABASE_URL
  if (!dsn) {
    console.error('FATAL: DATABASE_URL not set')
    process.exit(1)
  }
  const pool = new pg.Pool({ connectionString: dsn })

  if (DRY_RUN) {
    console.log('── DRY RUN: no writes will be performed ──')
  }

  // Count work first so the operator sees the scope.
  const { rows: [reCount] } = await pool.query(
    `SELECT count(*)::int AS total FROM reply_inbox`,
  )
  const { rows: [umCount] } = await pool.query(
    `SELECT count(*)::int AS total FROM unmatched_inbound`,
  )
  console.log(`reply_inbox total=${reCount.total}  unmatched_inbound total=${umCount.total}`)

  let okCount = 0
  let appliedCount = 0
  let errCount = 0

  // reply_inbox ──────────────────────────────────────────────────────────
  const { rows: replyRows } = await pool.query(
    `SELECT id FROM reply_inbox ORDER BY id ASC`,
  )
  for (const r of replyRows) {
    try {
      if (DRY_RUN) {
        okCount++
        continue
      }
      const v = await autoClassifyReply(pool, Number(r.id))
      okCount++
      if (v.applied) appliedCount++
    } catch (e) {
      errCount++
      console.warn(`[backfill] reply_inbox=${r.id} err=${e?.message}`)
    }
  }

  // unmatched_inbound ────────────────────────────────────────────────────
  const { rows: umRows } = await pool.query(
    `SELECT id FROM unmatched_inbound ORDER BY id ASC`,
  )
  for (const u of umRows) {
    try {
      if (DRY_RUN) {
        okCount++
        continue
      }
      const v = await autoClassifyReply(pool, -Number(u.id))
      okCount++
      if (v.applied) appliedCount++
    } catch (e) {
      errCount++
      console.warn(`[backfill] unmatched_inbound=${u.id} err=${e?.message}`)
    }
  }

  console.log(`── DONE ──  ok=${okCount}  applied=${appliedCount}  errors=${errCount}`)
  await pool.end()
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
