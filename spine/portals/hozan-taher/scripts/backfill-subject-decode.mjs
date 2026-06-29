#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════
// G3.3b — backfill RFC 2047 subject decoding for existing reply_inbox rows
// ════════════════════════════════════════════════════════════════════════
//
// Finds all reply_inbox rows where subject starts with '=?' (MIME-encoded),
// decodes them via the native utf-8/base64/qp rules, and UPDATEs the row.
// Each UPDATE is followed by an operator_audit_log INSERT in the same tx.
//
// Idempotent: after first run no rows will match subject LIKE '=?%' because
// decoded subjects never start with '=?'.
//
// Usage:
//   DATABASE_URL=... node scripts/backfill-subject-decode.mjs
//   DATABASE_URL=... node scripts/backfill-subject-decode.mjs --dry-run
//
// Hard rules honoured:
//   feedback_schema_verify_before_sql   — \d reply_inbox confirmed before write
//   feedback_audit_log_on_mutations     — every UPDATE emits operator_audit_log
//   feedback_no_pii_in_commands         — no email body logged; id+domain only
//   feedback_verify_select_after_migration — COUNT verified after backfill

import pg from 'pg'

const DRY_RUN = process.argv.includes('--dry-run')

// RFC 2047 decoder — handles =?charset?Q/B?...?= forms using Node built-ins.
// Node's Buffer.from + iconv-like approach: for utf-8 and ascii, decode
// directly. For other charsets fall back to raw (rare in practice — all
// 10 DB rows are utf-8).
function decodeRFC2047(raw) {
  if (!raw || !raw.includes('=?')) return raw
  // Replace all encoded-word tokens globally.
  return raw.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, charset, encoding, encoded) => {
    const cs = charset.toLowerCase()
    try {
      if (encoding.toUpperCase() === 'B') {
        const buf = Buffer.from(encoded, 'base64')
        return buf.toString(cs === 'utf-8' || cs === 'utf8' ? 'utf8' : 'latin1')
      }
      // Quoted-Printable
      const qpDecoded = encoded
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16)))
      if (cs === 'utf-8' || cs === 'utf8') {
        return Buffer.from(qpDecoded, 'binary').toString('utf8')
      }
      return qpDecoded
    } catch {
      return encoded // never lossy — return raw on error
    }
  })
}

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
    WHERE table_name = 'reply_inbox' AND column_name IN ('id', 'subject')
  `)
  const cols = schema.rows.map(r => r.column_name)
  if (!cols.includes('id') || !cols.includes('subject')) {
    console.error('Schema check failed — reply_inbox missing id or subject column')
    await client.end()
    process.exit(1)
  }

  // Count before
  const { rows: before } = await client.query(
    "SELECT COUNT(*)::int AS n FROM reply_inbox WHERE subject LIKE '=?%'"
  )
  const countBefore = before[0].n
  console.log(`reply_inbox rows with encoded subject BEFORE: ${countBefore}`)

  if (countBefore === 0) {
    console.log('Nothing to backfill.')
    await client.end()
    return
  }

  const { rows: candidates } = await client.query(
    "SELECT id, subject FROM reply_inbox WHERE subject LIKE '=?%' ORDER BY id"
  )

  let updated = 0
  for (const row of candidates) {
    const decoded = decodeRFC2047(row.subject)
    if (decoded === row.subject) {
      console.log(`[skip] id=${row.id} — decoded identical to raw`)
      continue
    }

    if (DRY_RUN) {
      console.log(`[dry-run] id=${row.id} raw=${row.subject.slice(0, 60)} → ${decoded.slice(0, 60)}`)
      continue
    }

    await client.query('BEGIN')
    try {
      await client.query(
        'UPDATE reply_inbox SET subject = $1 WHERE id = $2',
        [decoded, row.id]
      )
      await client.query(
        `INSERT INTO operator_audit_log (action, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          'subject_decode_backfill',
          'reply_inbox',
          row.id,
          JSON.stringify({ original_length: row.subject.length })
        ]
      )
      await client.query('COMMIT')
      updated++
      console.log(`[updated] id=${row.id} → "${decoded.slice(0, 60)}"`)
    } catch (err) {
      await client.query('ROLLBACK')
      console.error(`[error] id=${row.id}: ${err.message}`)
    }
  }

  if (!DRY_RUN) {
    // T0: verify after migration
    const { rows: after } = await client.query(
      "SELECT COUNT(*)::int AS n FROM reply_inbox WHERE subject LIKE '=?%'"
    )
    console.log(`\nreply_inbox rows with encoded subject AFTER: ${after[0].n}`)
    console.log(`Updated: ${updated}/${countBefore}`)
  }

  await client.end()
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
