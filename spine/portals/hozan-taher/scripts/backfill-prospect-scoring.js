#!/usr/bin/env node
// AV-F5-A — One-shot backfill of contacts.prospect_score for all unsent prospects.
//
// Usage:
//   DATABASE_URL=postgresql://… node scripts/backfill-prospect-scoring.js
//
// Behaviour:
//   - SELECTs contacts (with company JOIN) where crm_client_id IS NULL AND
//     (prospect_score_at IS NULL OR prospect_score_at < NOW() - 30 days).
//   - Processes BATCH_SIZE rows per transaction, prints progress every
//     LOG_EVERY rows.
//   - Idempotent — re-running picks up where it left off via the 30-day window.
//
// Per estimate (424 393 contacts × ~1 ms scoreProspect + ~5 ms UPDATE round-trip),
// total expected runtime over the Railway proxy: ~5-10 minutes.
//
// HARD rules:
//   - feedback_audit_log_on_mutations T0 — emits one aggregated audit row per
//     run start + per run end (not per contact — these are recomputations).
//   - feedback_no_magic_thresholds T0 — BATCH_SIZE / LOG_EVERY / WINDOW_DAYS
//     named constants below.

import pg from 'pg'
import { scoreProspect, SCORER_VERSION } from '../apps/outreach-dashboard/src/lib/prospectScorer.js'

const BATCH_SIZE   = 500
const LOG_EVERY    = 5000
const WINDOW_DAYS  = 30

function nowIso() {
  return new Date().toISOString()
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is required')
    process.exit(2)
  }
  const pool = new pg.Pool({ connectionString, max: 4, keepAlive: true })

  console.log(`[backfill] ${nowIso()} start (scorer=${SCORER_VERSION}, batch=${BATCH_SIZE}, window_days=${WINDOW_DAYS})`)

  // Audit: run start.
  try {
    await pool.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ('prospect_score_backfill_start', 'script:backfill-prospect-scoring', 'contacts', NULL, $1::jsonb)`,
      [JSON.stringify({ scorer_version: SCORER_VERSION, batch_size: BATCH_SIZE, window_days: WINDOW_DAYS })],
    )
  } catch (e) {
    console.error(`[backfill] audit start failed: ${e.message}`)
  }

  // Estimate total candidates up front so the operator sees a denominator.
  let totalCandidates = null
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM contacts
        WHERE crm_client_id IS NULL
          AND (prospect_score_at IS NULL
               OR prospect_score_at < NOW() - ($1 || ' days')::interval)`,
      [String(WINDOW_DAYS)],
    )
    totalCandidates = rows[0]?.total ?? null
    console.log(`[backfill] candidate pool size: ${totalCandidates}`)
  } catch (e) {
    console.warn(`[backfill] COUNT estimate failed: ${e.message}`)
  }

  const t0 = Date.now()
  let scored = 0
  let batches = 0
  let errors = 0

  while (true) {
    let rows
    try {
      const result = await pool.query(
        `SELECT c.id,
                c.email_status,
                c.email_confidence,
                c.last_contacted,
                c.created_at,
                c.crm_client_id,
                c.ico,
                co.icp_tier,
                co.sector_primary,
                co.category_path,
                co.name AS company_name
           FROM contacts c
           LEFT JOIN companies co ON co.ico = c.ico
          WHERE c.crm_client_id IS NULL
            AND (c.prospect_score_at IS NULL
                 OR c.prospect_score_at < NOW() - ($1 || ' days')::interval)
          ORDER BY c.prospect_score_at NULLS FIRST, c.id
          LIMIT $2`,
        [String(WINDOW_DAYS), BATCH_SIZE],
      )
      rows = result.rows
    } catch (e) {
      console.error(`[backfill] SELECT failed: ${e.message}`)
      errors++
      // Keep iterating — transient proxy hiccups are common over Railway public DSN.
      if (errors >= 5) {
        console.error('[backfill] too many SELECT failures — aborting')
        break
      }
      await new Promise((r) => setTimeout(r, 1000 * errors))
      continue
    }

    if (rows.length === 0) {
      console.log('[backfill] caught up — no more candidates')
      break
    }

    const now = new Date()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const row of rows) {
        const contact = {
          crm_client_id: row.crm_client_id,
          email_status: row.email_status,
          email_confidence: row.email_confidence,
          last_contacted: row.last_contacted,
          created_at: row.created_at,
        }
        const company = row.icp_tier != null || row.sector_primary != null || row.company_name != null
          ? {
              icp_tier: row.icp_tier,
              sector_primary: row.sector_primary,
              category_path: row.category_path,
              name: row.company_name,
            }
          : null
        const result = scoreProspect(contact, company, { now })
        await client.query(
          `UPDATE contacts
              SET prospect_score         = $2,
                  prospect_score_at      = NOW(),
                  prospect_score_factors = $3::jsonb
            WHERE id = $1`,
          [row.id, result.score, JSON.stringify(result.factors)],
        )
        scored++
        if (scored % LOG_EVERY === 0) {
          const elapsed = (Date.now() - t0) / 1000
          const rate = scored / elapsed
          const remaining = totalCandidates != null ? totalCandidates - scored : null
          const eta = remaining != null && rate > 0 ? Math.round(remaining / rate) : null
          console.log(`[backfill] progress scored=${scored}${totalCandidates != null ? '/' + totalCandidates : ''} rate=${rate.toFixed(1)}/s eta=${eta != null ? eta + 's' : 'unknown'}`)
        }
      }
      await client.query('COMMIT')
      batches++
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      errors++
      console.error(`[backfill] batch failed: ${e.message}`)
      if (errors >= 10) {
        console.error('[backfill] too many batch failures — aborting')
        break
      }
    } finally {
      client.release()
    }

    // Caught up — last batch shorter than requested means no more rows.
    if (rows.length < BATCH_SIZE) {
      console.log('[backfill] caught up — partial batch')
      break
    }
  }

  const duration_s = (Date.now() - t0) / 1000

  // Coverage snapshot.
  let scoreSummary = null
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE prospect_score IS NOT NULL)::int AS scored_rows,
              COUNT(*) FILTER (WHERE prospect_score >= 70)::int        AS top_prospects_70,
              COUNT(*) FILTER (WHERE prospect_score >= 80)::int        AS top_prospects_80,
              ROUND(AVG(prospect_score) FILTER (WHERE prospect_score IS NOT NULL)::numeric, 2) AS avg_score
         FROM contacts
        WHERE crm_client_id IS NULL`,
    )
    scoreSummary = rows[0] || null
    if (scoreSummary) {
      console.log(`[backfill] coverage: scored_rows=${scoreSummary.scored_rows} avg=${scoreSummary.avg_score} top_70=${scoreSummary.top_prospects_70} top_80=${scoreSummary.top_prospects_80}`)
    }
  } catch (e) {
    console.warn(`[backfill] coverage SELECT failed: ${e.message}`)
  }

  // Audit: run end.
  try {
    await pool.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ('prospect_score_backfill_end', 'script:backfill-prospect-scoring', 'contacts', NULL, $1::jsonb)`,
      [JSON.stringify({
        scorer_version: SCORER_VERSION,
        duration_s: Math.round(duration_s),
        scored, batches, errors,
        coverage: scoreSummary,
      })],
    )
  } catch (e) {
    console.error(`[backfill] audit end failed: ${e.message}`)
  }

  console.log(`[backfill] ${nowIso()} done duration_s=${Math.round(duration_s)} scored=${scored} batches=${batches} errors=${errors}`)

  await pool.end()
  // Non-zero exit when something went wrong but we still produced data.
  process.exit(errors > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`[backfill] fatal: ${e?.stack || e?.message || e}`)
  process.exit(2)
})
