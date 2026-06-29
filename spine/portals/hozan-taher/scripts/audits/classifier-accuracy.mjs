#!/usr/bin/env node
// classifier-accuracy.mjs — Sprint B2: generate ground-truth labeling CSV
//
// Fetches the 20 most-recent classified inbound replies from outreach_messages
// (direction='inbound', reply_type IS NOT NULL) and writes a CSV with one row
// per reply. The operator fills in `ground_truth_label` in a spreadsheet, then
// passes the filled CSV to `pnpm run audit:classifier-score <file>` to compute
// accuracy and per-label precision/recall.
//
// PII rule: sender email is redacted to mb1@/mb2@/mb3@/mb4@/mbN@ ordinals —
// never stored verbatim in the report file. Body truncated to 400 chars.
//
// Run: node --env-file-if-exists=../../apps/outreach-dashboard/.env scripts/audits/classifier-accuracy.mjs
// Or via pnpm from apps/outreach-dashboard: pnpm run audit:classifier-sample

import pg from 'pg'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Load .env from apps/outreach-dashboard if DATABASE_URL not already set
if (!process.env.DATABASE_URL) {
  const envPaths = [
    join(__dirname, '../../apps/outreach-dashboard/.env'),
    join(__dirname, '../../../apps/outreach-dashboard/.env'),
  ]
  for (const envPath of envPaths) {
    try {
      const raw = readFileSync(envPath, 'utf8')
      for (const line of raw.split('\n')) {
        const eq = line.indexOf('=')
        if (eq < 1) continue
        const key = line.slice(0, eq).trim()
        const val = line.slice(eq + 1).trim()
        if (key && val && !process.env[key]) {
          process.env[key] = val
        }
      }
      break
    } catch {
      // try next path
    }
  }
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[classifier-accuracy] DATABASE_URL not set. Set it in .env or export before running.')
  process.exit(1)
}

const LIMIT = 20
const BODY_TRUNC = 400
const SUBJECT_TRUNC = 80

// Map real emails to stable ordinals within this run — never stored verbatim.
const emailMap = new Map()
let emailCounter = 0
function redactEmail(email) {
  if (!email) return ''
  if (!emailMap.has(email)) {
    emailCounter++
    emailMap.set(email, `mb${emailCounter}@redacted`)
  }
  return emailMap.get(email)
}

function truncate(str, maxLen, suffix = '…[truncated]') {
  if (!str) return ''
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + suffix
}

// Escape a CSV field: wrap in double-quotes, escape embedded double-quotes.
function csvField(val) {
  if (val == null) return ''
  const s = String(val)
    .replace(/\r\n/g, ' ')
    .replace(/[\r\n]/g, ' ')
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

function csvRow(fields) {
  return fields.map(csvField).join(',')
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 })

  let rows
  try {
    // Join outreach_messages (inbound, classified) with outreach_threads and
    // outreach_contacts to get sender context. body_text (migration 012) is
    // preferred when available; body_preview (always present) is the fallback.
    //
    // No confidence_score column exists in outreach_messages (classifier does
    // not persist confidence). The llm_confidence column is left blank
    // in the CSV per schema reality — see docs/subsystem-maps/imap-inbound.md.
    // The column placeholder is kept in the CSV spec so the format is stable
    // when confidence tracking is added (KT-B3 / future).
    //
    // body_text column: probe schema first to determine if migration 012 has
    // been applied. Avoids "column does not exist" on DBs where it is absent.
    const { rows: colCheck } = await pool.query(`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_name = 'outreach_messages'
         AND column_name = 'body_text'
    `)
    const hasBodyText = colCheck.length > 0
    const bodyExpr = hasBodyText ? 'COALESCE(om.body_text, om.body_preview)' : 'om.body_preview'

    const { rows: queryRows } = await pool.query(`
      SELECT
        om.id,
        om.replied_at                          AS received_at,
        oc.email                               AS sender_email_raw,
        om.subject,
        ${bodyExpr}                            AS body,
        om.reply_type                          AS llm_label,
        om.sentiment
      FROM outreach_messages om
      JOIN outreach_threads  ot ON ot.id = om.thread_id
      JOIN outreach_contacts oc ON oc.id = ot.contact_id
      WHERE om.direction  = 'inbound'
        AND om.reply_type IS NOT NULL
        AND om.reply_type != ''
      ORDER BY om.replied_at DESC NULLS LAST, om.id DESC
      LIMIT $1
    `, [LIMIT])
    rows = queryRows
  } catch (err) {
    console.error('[classifier-accuracy] DB query failed:', err.message)
    process.exit(1)
  } finally {
    await pool.end()
  }

  if (rows.length === 0) {
    console.warn('[classifier-accuracy] No classified inbound replies found in outreach_messages.')
    console.warn('  Have any campaigns been run with the LLM classifier wired?')
    console.warn('  (reply_type column is populated by services/orchestrator/thread/inbound.go)')
    // Still write an empty CSV with headers so the caller has the file shape.
  }

  // Build CSV
  const dateStr = new Date().toISOString().slice(0, 10)
  const outDir = join(__dirname, `../../reports/classifier-accuracy`)
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${dateStr}-classifier-sample.csv`)

  const header = csvRow([
    'id',
    'received_at',
    'sender_email_redacted',
    'subject_truncated_80c',
    'body_truncated_400c',
    'llm_label',
    'llm_confidence',
    'ground_truth_label_BLANK',
    'notes_BLANK',
  ])

  const dataRows = rows.map(r => csvRow([
    r.id,
    r.received_at ? new Date(r.received_at).toISOString() : '',
    redactEmail(r.sender_email_raw),
    truncate(r.subject || '', SUBJECT_TRUNC, '…'),
    truncate(r.body || '', BODY_TRUNC),
    r.llm_label || '',
    '',      // llm_confidence — not stored; see comment above
    '',      // ground_truth_label_BLANK — operator fills this
    '',      // notes_BLANK — optional operator notes
  ]))

  const csv = [header, ...dataRows].join('\n') + '\n'
  writeFileSync(outPath, csv, 'utf8')

  console.log(`[classifier-accuracy] Wrote ${rows.length} rows → ${outPath}`)
  console.log()
  console.log('Next step:')
  console.log('  1. Open the CSV in a spreadsheet (Numbers / Excel / Google Sheets).')
  console.log('  2. Fill the "ground_truth_label_BLANK" column for each row.')
  console.log('     Valid labels: interested, meeting, later, objection, negative, ooo')
  console.log('  3. Save as CSV.')
  console.log(`  4. Run: pnpm run audit:classifier-score ${outPath}`)
}

main().catch(err => {
  console.error('[classifier-accuracy] Fatal:', err)
  process.exit(1)
})
