// reclassify-backfill.mjs — one-time correction of reply_inbox rows that the
// v1 classifier mis-labelled (declines tagged 'positive' because v1 scored the
// quoted original outbound). Re-runs the DETERMINISTIC regex_v2 classifier
// (quote-stripping + price/offer + short-decline) over already-classified rows
// and flips classification where the new high-confidence verdict differs.
//
// Deterministic only — no LLM, no send, no suppression cascade. Just corrects
// the label + writes reply_classifications_log(regex_v2) + operator_audit_log.
// The operator reviews the newly-negative rows in the Odpovědi UI.
//
//   node scripts/reclassify-backfill.mjs            # DRY RUN (default) — prints diff
//   node scripts/reclassify-backfill.mjs --apply    # mutate in an audited tx
//
// Per feedback_schema_verify_before_sql (verified 2026-05-31):
//   reply_inbox(id,from_email,subject,body_text,classification,handled)
//   reply_classifications_log(reply_id,classifier_version,classification,confidence,reasoning,applied)
//   operator_audit_log(action,actor,details,entity_id,entity_type)

import pg from 'pg'
import { classifyReply, CLASSIFIER_VERSION, AUTO_APPLY_THRESHOLD } from '../src/lib/replyClassifier.js'

const APPLY = process.argv.includes('--apply')
const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL not set — run via `node --env-file=.env` or export it.'); process.exit(1) }

const maskDomain = (e) => (e && e.includes('@')) ? '@' + e.split('@')[1] : '(none)'

const pool = new pg.Pool({ connectionString: url })
try {
  // Re-evaluate every already-classified reply (reply_inbox is small, ~100s).
  const { rows } = await pool.query(
    `SELECT id, from_email, subject, body_text, classification, handled
       FROM reply_inbox
      WHERE classification IS NOT NULL
        AND COALESCE(body_text,'') <> ''`,
  )

  const flips = []
  for (const r of rows) {
    const verdict = classifyReply(r.body_text, r.subject, r.from_email)
    const next = verdict.classification
    // Only act on a confident, DIFFERENT verdict. Null/low-confidence leaves
    // the existing label untouched (operator already triaged it, or it's
    // genuinely ambiguous — don't churn it).
    if (next && next !== r.classification && verdict.confidence >= AUTO_APPLY_THRESHOLD) {
      flips.push({ id: Number(r.id), from: maskDomain(r.from_email), old: r.classification, next, conf: verdict.confidence, reasoning: verdict.reasoning })
    }
  }

  // Summary table
  const byTransition = {}
  for (const f of flips) {
    const k = `${f.old} → ${f.next}`
    byTransition[k] = (byTransition[k] || 0) + 1
  }
  console.log(`\nRECLASSIFY BACKFILL  (${CLASSIFIER_VERSION})  ${APPLY ? '— APPLY' : '— DRY RUN'}`)
  console.log('─'.repeat(64))
  console.log(`scanned classified replies: ${rows.length}`)
  console.log(`high-confidence flips:      ${flips.length}`)
  for (const [k, n] of Object.entries(byTransition).sort((a,b)=>b[1]-a[1])) {
    console.log(`  ${k.padEnd(28)} ${n}`)
  }
  console.log('─'.repeat(64))
  for (const f of flips) {
    console.log(`  id=${String(f.id).padStart(4)}  ${f.from.padEnd(22)} ${f.old} → ${f.next}  (${f.conf})`)
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — no changes written. Re-run with --apply to commit.\n`)
    process.exit(0)
  }

  // ── APPLY ────────────────────────────────────────────────────────────────
  const client = await pool.connect()
  let applied = 0
  try {
    for (const f of flips) {
      await client.query('BEGIN')
      await client.query(`UPDATE reply_inbox SET classification = $1 WHERE id = $2`, [f.next, f.id])
      await client.query(
        `INSERT INTO reply_classifications_log
           (reply_id, classifier_version, classification, confidence, reasoning, applied)
         VALUES ($1, $2, $3, $4, $5::jsonb, TRUE)
         ON CONFLICT (reply_id, classifier_version) DO UPDATE
           SET classification = EXCLUDED.classification,
               confidence     = EXCLUDED.confidence,
               reasoning      = EXCLUDED.reasoning,
               applied        = TRUE`,
        [f.id, CLASSIFIER_VERSION, f.next, f.conf, JSON.stringify({ ...f.reasoning, backfill: true })],
      )
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('reply_reclassify_backfill', 'system:reclassify-backfill', 'reply_inbox', $1, $2::jsonb)`,
        [f.id, JSON.stringify({ from_old: f.old, to_new: f.next, confidence: f.conf, classifier_version: CLASSIFIER_VERSION })],
      )
      await client.query('COMMIT')
      applied++
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('apply failed, rolled back current row:', e?.message)
    process.exitCode = 1
  } finally {
    client.release()
  }
  console.log(`\nAPPLIED ${applied}/${flips.length} flips (each audited in operator_audit_log).\n`)
} catch (e) {
  console.error('backfill error:', e?.message || e)
  process.exitCode = 1
} finally {
  await pool.end()
}
