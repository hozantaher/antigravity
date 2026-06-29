#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// G3.5b — backfill classification for reply_inbox rows where
//          classification IS NULL, using the fixed body source
//          (channel_messages inbound body, not outreach_messages outbound)
// ════════════════════════════════════════════════════════════════════════
//
// Idempotent: only touches rows with classification IS NULL.
// Each UPDATE paired with operator_audit_log INSERT in same tx.
//
// Usage:
//   DATABASE_URL=... node scripts/backfill-classify-unclassified.mjs
//   DATABASE_URL=... node scripts/backfill-classify-unclassified.mjs --dry-run
//
// Hard rules:
//   feedback_schema_verify_before_sql    T0
//   feedback_audit_log_on_mutations      T0
//   feedback_no_pii_in_commands          T0 — id only in logs
//   feedback_verify_select_after_migration T0

import pg from 'pg'
import { classifyReply } from '../apps/outreach-dashboard/src/lib/replyClassifier.js'

const DRY_RUN = process.argv.includes('--dry-run')

// Confidence threshold below which we skip the write (model uncertain).
// Named constant per feedback_no_magic_thresholds T0.
const MIN_APPLY_CONFIDENCE = 0.5

async function main() {
  const dsn = process.env.DATABASE_URL
  if (!dsn) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString: dsn })
  await client.connect()

  // T0: schema verify before SQL
  const schema = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'reply_inbox'
      AND column_name IN ('id', 'classification', 'from_email', 'subject', 'received_at')
  `)
  const cols = new Set(schema.rows.map(r => r.column_name))
  for (const required of ['id', 'classification', 'from_email', 'subject', 'received_at']) {
    if (!cols.has(required)) {
      console.error(`Schema check failed — reply_inbox missing column: ${required}`)
      await client.end()
      process.exit(1)
    }
  }

  const { rows: before } = await client.query(
    'SELECT COUNT(*)::int AS n FROM reply_inbox WHERE classification IS NULL'
  )
  console.log(`reply_inbox rows with classification=NULL BEFORE: ${before[0].n}`)

  // Load unclassified rows with their inbound body from channel_messages.
  const { rows: candidates } = await client.query(`
    SELECT r.id, r.from_email, r.subject,
           cm.body AS cm_body, cm.body_html AS cm_body_html
      FROM reply_inbox r
      LEFT JOIN channel_messages cm
        ON lower(cm.from_handle) LIKE ('%' || lower(r.from_email) || '%')
       AND cm.direction = 'inbound'
       AND cm.received_at BETWEEN r.received_at - interval '10 minutes'
                              AND r.received_at + interval '10 minutes'
     WHERE r.classification IS NULL
     ORDER BY r.id, cm.id DESC
  `)

  // Deduplicate — ORDER BY r.id, cm.id DESC means first occurrence per reply_id wins.
  const seen = new Set()
  const deduped = []
  for (const row of candidates) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    deduped.push(row)
  }

  let classified = 0
  let skipped_low_conf = 0
  let skipped_no_body = 0
  let errors = 0

  for (const row of deduped) {
    const body = String(row.cm_body || row.cm_body_html || '')
    if (!body.trim()) {
      skipped_no_body++
      continue
    }

    const verdict = classifyReply(body, row.subject || '', row.from_email || '')
    if (verdict.confidence < MIN_APPLY_CONFIDENCE) {
      skipped_low_conf++
      continue
    }

    if (DRY_RUN) {
      console.log(`[dry-run] id=${row.id} → ${verdict.classification} (conf=${verdict.confidence.toFixed(2)})`)
      classified++
      continue
    }

    await client.query('BEGIN')
    try {
      await client.query(
        `UPDATE reply_inbox SET classification = $1 WHERE id = $2`,
        [verdict.classification, row.id]
      )
      await client.query(
        `INSERT INTO operator_audit_log (action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          'classification_backfill_g35',
          'reply_inbox',
          row.id,
          JSON.stringify({
            classification: verdict.classification,
            confidence: verdict.confidence,
            source: 'regex_v1_fixed_body',
          })
        ]
      )
      await client.query('COMMIT')
      classified++
      console.log(`[updated] id=${row.id} → ${verdict.classification} (conf=${verdict.confidence.toFixed(2)})`)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`[error] id=${row.id}: ${err.message}`)
      errors++
    }
  }

  if (!DRY_RUN) {
    const { rows: after } = await client.query(
      'SELECT COUNT(*)::int AS n FROM reply_inbox WHERE classification IS NULL'
    )
    console.log(`\nreply_inbox rows with classification=NULL AFTER: ${after[0].n}`)
  }

  console.log(`\nSummary: classified=${classified} skipped_low_conf=${skipped_low_conf} skipped_no_body=${skipped_no_body} errors=${errors}`)
  await client.end()
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
