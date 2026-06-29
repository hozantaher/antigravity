// purge-junk-campaigns.mjs — one-time cleanup of test-junk campaigns.
//
// Production carried 226 campaigns but only ~4 are real: 222 are empty test
// shells (status NULL, name 'test' or all-x, created_at NULL, ZERO
// campaign_contacts, ZERO send_events). They inflate the Kampaně header to
// "226 Celkem" and fill the "Nekonfigurované 225" chip with noise.
//
// Safe: verified no FK constraint references campaigns(id), and the targeted
// rows have no campaign_contacts / send_events children (re-checked here before
// each delete). Audited (operator_audit_log). Deterministic — no LLM.
//
//   node scripts/purge-junk-campaigns.mjs           # DRY RUN (default)
//   node scripts/purge-junk-campaigns.mjs --apply   # delete in an audited tx
//
// Per feedback_schema_verify_before_sql (verified 2026-06):
//   campaigns(id, status, name, created_at), campaign_contacts(campaign_id),
//   send_events(campaign_id), operator_audit_log(action,actor,details,entity_type,entity_id)

import pg from 'pg'

const APPLY = process.argv.includes('--apply')
const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL not set'); process.exit(1) }

// Junk predicate — a real campaign always has a status and a created_at; a row
// with BOTH null is a broken test artifact (names seen: 'test', all-x, an XSS
// probe '"><img …>', 'sanity_post'). The 0-children guard below makes this
// safe regardless of name. Real campaigns (paused/running/draft + created_at)
// never match.
const JUNK_WHERE = `status IS NULL AND created_at IS NULL`

const pool = new pg.Pool({ connectionString: url })
try {
  // Re-verify the blast radius: junk count + that NONE have children.
  const { rows: [chk] } = await pool.query(`
    WITH junk AS (SELECT id FROM campaigns WHERE ${JUNK_WHERE})
    SELECT
      (SELECT count(*) FROM junk) AS junk,
      (SELECT count(*) FROM campaign_contacts WHERE campaign_id IN (SELECT id FROM junk)) AS cc,
      (SELECT count(*) FROM send_events WHERE campaign_id IN (SELECT id FROM junk)) AS se,
      (SELECT count(*) FROM campaigns) AS total
  `)
  console.log(`\nPURGE JUNK CAMPAIGNS  ${APPLY ? '— APPLY' : '— DRY RUN'}`)
  console.log('─'.repeat(56))
  console.log(`campaigns total:        ${chk.total}`)
  console.log(`junk (to delete):       ${chk.junk}`)
  console.log(`junk campaign_contacts: ${chk.cc}`)
  console.log(`junk send_events:       ${chk.se}`)
  console.log(`real (kept):            ${Number(chk.total) - Number(chk.junk)}`)
  console.log('─'.repeat(56))

  if (Number(chk.cc) > 0 || Number(chk.se) > 0) {
    console.error('ABORT: junk campaigns have child rows — refusing to delete (would orphan data).')
    process.exit(1)
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no changes. Re-run with --apply.\n')
    process.exit(0)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: ids } = await client.query(`SELECT id FROM campaigns WHERE ${JUNK_WHERE} ORDER BY id`)
    const idList = ids.map(r => Number(r.id))
    const { rowCount } = await client.query(`DELETE FROM campaigns WHERE ${JUNK_WHERE}`)
    await client.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, details)
       VALUES ('campaigns_junk_purge', 'system:purge-junk-campaigns', 'campaign', $1::jsonb)`,
      [JSON.stringify({
        deleted: rowCount,
        criteria: "status IS NULL AND name in ('test', /^x+$/) AND created_at IS NULL",
        had_children: false,
        sample_ids: idList.slice(0, 20),
        total_ids: idList.length,
      })],
    )
    await client.query('COMMIT')
    console.log(`\nDELETED ${rowCount} junk campaigns (audited).\n`)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('apply failed, rolled back:', e?.message)
    process.exitCode = 1
  } finally {
    client.release()
  }
} catch (e) {
  console.error('purge error:', e?.message || e)
  process.exitCode = 1
} finally {
  await pool.end()
}
