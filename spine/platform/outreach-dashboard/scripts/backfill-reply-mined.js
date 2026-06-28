// backfill-reply-mined.js — one-time backfill of reply_inbox.mined (#1578 M1
// persistence, migration 150). The miner is JS (lib/mineReplySignals.js), so the
// backfill runs here rather than in SQL. Idempotent: only touches rows where
// mined IS NULL, so it is safe to re-run after migration 150 or after new
// inbound arrives. Reads body_text, computes the signal bundle, persists as
// jsonb. No audit-log row — this is a derived-data backfill, not an
// operator-visible state change.
//
// Run:  DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" node scripts/backfill-reply-mined.js
// Env:  DATABASE_URL (same connection string as the BFF)

import pg from 'pg'
import { mineReplySignals } from '../src/lib/mineReplySignals.js'
import { htmlToText } from '../src/lib/htmlToText.js'

const { Pool } = pg

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL not set'); process.exit(1)
  }
  const pool = new Pool({ connectionString })
  try {
    // Mine rows that are not yet mined, PLUS HTML-only rows whose earlier
    // text-only backfill produced an empty bundle (#1579 H1.1 — body_text empty
    // but body_html carries the message). Re-mining the latter is idempotent.
    const { rows } = await pool.query(
      `SELECT id, body_text, body_html FROM reply_inbox
        WHERE mined IS NULL
           OR ((body_text IS NULL OR body_text = '') AND body_html IS NOT NULL AND body_html <> '')
        ORDER BY id`,
    )
    console.log(`rows to mine: ${rows.length}`)

    let updated = 0
    let withPhone = 0
    let withPrice = 0
    let withCallback = 0
    let withUrgent = 0
    let withLocation = 0

    for (const row of rows) {
      const body = (row.body_text && row.body_text.trim()) ? row.body_text : htmlToText(row.body_html)
      const mined = mineReplySignals(body)
      await pool.query('UPDATE reply_inbox SET mined = $1 WHERE id = $2', [
        JSON.stringify(mined),
        row.id,
      ])
      updated += 1
      if (mined.phones.length) withPhone += 1
      if (mined.prices.length) withPrice += 1
      if (mined.callback) withCallback += 1
      if (mined.urgent) withUrgent += 1
      if (mined.locations.length) withLocation += 1
    }

    // Rows with no body (or empty) get an empty bundle so the list filter sees a
    // populated column everywhere — "no phone" is distinct from "not yet mined".
    const { rowCount: emptied } = await pool.query(
      `UPDATE reply_inbox SET mined = $1
        WHERE mined IS NULL`,
      [JSON.stringify({ phones: [], prices: [], callback: false, urgent: false, locations: [] })],
    )

    console.log('── backfill complete ──')
    console.log(`updated (with body):  ${updated}`)
    console.log(`empty-bundle (no body): ${emptied}`)
    console.log(`  with phone:    ${withPhone}`)
    console.log(`  with price:    ${withPrice}`)
    console.log(`  callback:      ${withCallback}`)
    console.log(`  urgent:        ${withUrgent}`)
    console.log(`  with location: ${withLocation}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
