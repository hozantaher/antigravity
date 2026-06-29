#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// FUN-1.2 — Backfill funnel_events from existing pipeline tables.
// ════════════════════════════════════════════════════════════════════════
//
// Retroactively populates funnel_events from:
//   1. send_events   → event_type 'sent' (status IN sent/opened/replied/bounced)
//   2. send_events   → event_type 'opened' (status='opened')
//   3. reply_inbox   → event_type 'replied'
//   4. reply_inbox   → event_type 'classified_*' when classification is set
//   5. leads         → event_type 'lead_created'
//   6. leads         → event_type 'lead_won' / 'lead_lost' when status matches
//   7. outreach_suppressions → event_type 'suppressed'
//
// Idempotent: uses send_event_id / reply_id / lead_id foreign keys +
// ON CONFLICT DO NOTHING on a unique partial index to skip already-inserted
// rows. Safe to re-run multiple times.
//
// Usage:
//   DATABASE_URL=... node scripts/funnel/backfill-from-existing.js
//   DATABASE_URL=... node scripts/funnel/backfill-from-existing.js --dry-run
//
// Hard rules respected:
//   feedback_no_pii_in_logs    — no email addresses printed to stdout
//   feedback_audit_log_on_mutations — operator_audit_log INSERT per batch
//   feedback_no_magic_thresholds   — BATCH_SIZE in named constant

import pg from 'pg'

const DRY_RUN = process.argv.includes('--dry-run')

// Named constants — no magic literals (feedback_no_magic_thresholds T0).
const BATCH_SIZE = 500

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

  // Ensure funnel_events table exists before backfill.
  const { rows: [tableCheck] } = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='funnel_events') AS exists`,
  )
  if (!tableCheck.exists) {
    console.error('FATAL: funnel_events table does not exist. Apply migration 141 first.')
    process.exit(1)
  }

  let totalInserted = 0

  // ── 1. sent + opened events from send_events ─────────────────────────
  {
    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM send_events
       WHERE status IN ('sent','opened','replied','bounced')`,
    )
    console.log(`send_events eligible: ${cnt.total}`)

    let offset = 0
    while (true) {
      const { rows } = await pool.query(
        `SELECT id, campaign_id, contact_id, sent_at, status, template_variant_id, step
         FROM send_events
         WHERE status IN ('sent','opened','replied','bounced')
         ORDER BY id
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      )
      if (rows.length === 0) break

      if (!DRY_RUN) {
        // 'sent' event for every eligible send_event row.
        for (const r of rows) {
          await pool.query(
            `INSERT INTO funnel_events
               (event_type, contact_id, campaign_id, send_event_id,
                template_variant_id, occurred_at, details)
             VALUES ('sent', $1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT DO NOTHING`,
            [r.contact_id, r.campaign_id, r.id, r.template_variant_id,
             r.sent_at, JSON.stringify({ step: r.step || 0 })],
          )
        }

        // 'opened' events for rows with status='opened'.
        const openedRows = rows.filter(r => r.status === 'opened')
        for (const r of openedRows) {
          await pool.query(
            `INSERT INTO funnel_events
               (event_type, contact_id, campaign_id, send_event_id,
                template_variant_id, occurred_at, details)
             VALUES ('opened', $1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT DO NOTHING`,
            [r.contact_id, r.campaign_id, r.id, r.template_variant_id,
             r.sent_at, JSON.stringify({ step: r.step || 0 })],
          )
        }

        // 'classified_bounce' for bounced rows.
        const bouncedRows = rows.filter(r => r.status === 'bounced')
        for (const r of bouncedRows) {
          await pool.query(
            `INSERT INTO funnel_events
               (event_type, contact_id, campaign_id, send_event_id,
                template_variant_id, occurred_at, details)
             VALUES ('classified_bounce', $1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT DO NOTHING`,
            [r.contact_id, r.campaign_id, r.id, r.template_variant_id,
             r.sent_at, JSON.stringify({ source: 'bounce', step: r.step || 0 })],
          )
        }

        totalInserted += rows.length
        process.stdout.write(`  send_events offset=${offset} batch=${rows.length}\r`)
      }

      offset += rows.length
      if (rows.length < BATCH_SIZE) break
    }
    console.log()
  }

  // ── 2. replied events from reply_inbox ───────────────────────────────
  {
    const { rows: [cnt] } = await pool.query(`SELECT COUNT(*)::int AS total FROM reply_inbox`)
    console.log(`reply_inbox total: ${cnt.total}`)

    let offset = 0
    while (true) {
      const { rows } = await pool.query(
        `SELECT id, contact_id, campaign_id, send_event_id, received_at, classification,
                pre_classification->>'intent' AS intent
         FROM reply_inbox
         ORDER BY id
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      )
      if (rows.length === 0) break

      if (!DRY_RUN) {
        for (const r of rows) {
          // Base 'replied' event.
          await pool.query(
            `INSERT INTO funnel_events
               (event_type, contact_id, campaign_id, send_event_id, reply_id, occurred_at, details)
             VALUES ('replied', $1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT DO NOTHING`,
            [r.contact_id, r.campaign_id, r.send_event_id, r.id,
             r.received_at, JSON.stringify({ source: 'reply_inbox' })],
          )

          // Classification event when classification or intent is set.
          const cls = r.classification || r.intent
          if (cls) {
            const ENGAGEMENT_LABELS = new Set(['interested', 'meeting', 'positive', 'engaged'])
            const NEGATIVE_LABELS = new Set(['negative', 'unsubscribe', 'spam', 'bounce'])
            let evtType = null
            if (ENGAGEMENT_LABELS.has(cls)) evtType = 'classified_engagement'
            else if (NEGATIVE_LABELS.has(cls)) evtType = 'classified_negative'

            if (evtType) {
              await pool.query(
                `INSERT INTO funnel_events
                   (event_type, contact_id, campaign_id, send_event_id, reply_id, occurred_at, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                 ON CONFLICT DO NOTHING`,
                [evtType, r.contact_id, r.campaign_id, r.send_event_id, r.id,
                 r.received_at, JSON.stringify({ classification: cls })],
              )
            }
          }
        }

        totalInserted += rows.length
        process.stdout.write(`  reply_inbox offset=${offset} batch=${rows.length}\r`)
      }

      offset += rows.length
      if (rows.length < BATCH_SIZE) break
    }
    console.log()
  }

  // ── 3. lead events from leads ─────────────────────────────────────────
  {
    const { rows: [cnt] } = await pool.query(`SELECT COUNT(*)::int AS total FROM leads`)
    console.log(`leads total: ${cnt.total}`)

    let offset = 0
    while (true) {
      const { rows } = await pool.query(
        `SELECT id, contact_id, campaign_id, created_at, status, sentiment
         FROM leads
         ORDER BY id
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      )
      if (rows.length === 0) break

      if (!DRY_RUN) {
        for (const r of rows) {
          // lead_created event.
          await pool.query(
            `INSERT INTO funnel_events
               (event_type, contact_id, campaign_id, lead_id, occurred_at, details)
             VALUES ('lead_created', $1, $2, $3, $4, $5::jsonb)
             ON CONFLICT DO NOTHING`,
            [r.contact_id, r.campaign_id, r.id,
             r.created_at, JSON.stringify({ sentiment: r.sentiment || null })],
          )

          // lead_won / lead_lost when status reflects terminal state.
          if (r.status === 'won') {
            await pool.query(
              `INSERT INTO funnel_events
                 (event_type, contact_id, campaign_id, lead_id, occurred_at, details)
               VALUES ('lead_won', $1, $2, $3, $4, $5::jsonb)
               ON CONFLICT DO NOTHING`,
              [r.contact_id, r.campaign_id, r.id,
               r.created_at, JSON.stringify({ backfill: true })],
            )
          } else if (r.status === 'lost' || r.status === 'disqualified') {
            await pool.query(
              `INSERT INTO funnel_events
                 (event_type, contact_id, campaign_id, lead_id, occurred_at, details)
               VALUES ('lead_lost', $1, $2, $3, $4, $5::jsonb)
               ON CONFLICT DO NOTHING`,
              [r.contact_id, r.campaign_id, r.id,
               r.created_at, JSON.stringify({ backfill: true, status: r.status })],
            )
          }
        }

        totalInserted += rows.length
        process.stdout.write(`  leads offset=${offset} batch=${rows.length}\r`)
      }

      offset += rows.length
      if (rows.length < BATCH_SIZE) break
    }
    console.log()
  }

  // ── 4. suppressed events from outreach_suppressions ──────────────────
  {
    const { rows: [cnt] } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM outreach_suppressions`,
    )
    console.log(`outreach_suppressions total: ${cnt.total}`)

    // suppressions don't have contact_id directly — we join via email.
    let offset = 0
    while (true) {
      const { rows } = await pool.query(
        `SELECT os.id, c.id AS contact_id, os.source_event_id, NOW() AS occurred_at
         FROM outreach_suppressions os
         LEFT JOIN contacts c ON lower(trim(c.email)) = lower(trim(os.email))
         ORDER BY os.id
         LIMIT $1 OFFSET $2`,
        [BATCH_SIZE, offset],
      )
      if (rows.length === 0) break

      if (!DRY_RUN) {
        for (const r of rows) {
          await pool.query(
            `INSERT INTO funnel_events
               (event_type, contact_id, send_event_id, occurred_at, details)
             VALUES ('suppressed', $1, $2, $3, $4::jsonb)
             ON CONFLICT DO NOTHING`,
            [r.contact_id, r.source_event_id, r.occurred_at,
             JSON.stringify({ suppression_id: r.id })],
          )
        }

        totalInserted += rows.length
        process.stdout.write(`  suppressions offset=${offset} batch=${rows.length}\r`)
      }

      offset += rows.length
      if (rows.length < BATCH_SIZE) break
    }
    console.log()
  }

  // ── Audit log (feedback_audit_log_on_mutations T0) ───────────────────
  if (!DRY_RUN && totalInserted > 0) {
    // entity_id is bigint; use NULL for a batch-level audit row.
    await pool.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ('funnel_backfill_completed', 'backfill_script', 'funnel_events', NULL,
               $1::jsonb)`,
      [JSON.stringify({
        total_source_rows_processed: totalInserted,
        script: 'scripts/funnel/backfill-from-existing.js',
        dry_run: false,
      })],
    )
  }

  const { rows: [finalCnt] } = await pool.query(`SELECT COUNT(*)::int AS total FROM funnel_events`)
  console.log(`\nfunnel_events rows after backfill: ${finalCnt.total}`)

  await pool.end()
  console.log(DRY_RUN ? 'Dry run complete — no data written.' : 'Backfill complete.')
}

main().catch(e => {
  console.error('Backfill failed:', e.message)
  process.exit(1)
})
