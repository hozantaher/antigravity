#!/usr/bin/env node
// crm-backfill-contacts.mjs — propagate contacts.crm_client_id via ICO match.
//
// After pnpm crm:import, email-only matches miss ~7% of CRM-linked companies.
// This script fills the gap by propagating crm_client_id from companies where ICO matches.
//
// Usage:
//   node scripts/audits/crm-backfill-contacts.mjs
//   pnpm crm:backfill-contacts
//
// Reads DATABASE_URL from apps/outreach-dashboard/.env per feedback_no_pii_in_commands.
// Output is aggregate counts only — no email addresses.
// Audit log row written to operator_audit_log at end.
// Idempotent: re-running yields 0 updates after first successful run.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const envPath = join(repoRoot, 'apps', 'outreach-dashboard', '.env')

let envText
try { envText = readFileSync(envPath, 'utf8') } catch (e) {
  console.error(`✗ .env not found at ${envPath}`)
  process.exit(2)
}
const dsnLine = envText.split('\n').find(l => /^(DATABASE_URL|OUTREACH_DATABASE_URL)=/.test(l))
if (!dsnLine) {
  console.error(`✗ DATABASE_URL missing in ${envPath}`)
  process.exit(2)
}
const dsn = dsnLine.split('=', 2)[1].replace(/^"|"$/g, '')

const client = new pg.Client({ connectionString: dsn })
await client.connect()

try {
  const startTime = Date.now()

  // Verify required tables exist
  const { rows: tableCheck } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('contacts', 'companies', 'operator_audit_log')
  `)
  if (tableCheck.length !== 3) {
    console.error('✗ Required tables (contacts, companies, operator_audit_log) not found')
    process.exit(1)
  }

  // Count before
  const { rows: [{ count: beforeCount }] } = await client.query(`
    SELECT COUNT(*) FROM contacts ct
    WHERE ct.ico IS NOT NULL
      AND ct.crm_client_id IS NULL
      AND EXISTS (
        SELECT 1 FROM companies co
        WHERE co.ico = ct.ico AND co.crm_client_id IS NOT NULL
      )
  `)

  // Perform backfill
  const { rowCount } = await client.query(`
    UPDATE contacts ct
    SET crm_client_id = co.crm_client_id
    FROM companies co
    WHERE ct.ico = co.ico
      AND ct.crm_client_id IS NULL
      AND co.crm_client_id IS NOT NULL
  `)

  // Count after (should be 0 if idempotent re-run)
  const { rows: [{ count: afterCount }] } = await client.query(`
    SELECT COUNT(*) FROM contacts ct
    WHERE ct.ico IS NOT NULL
      AND ct.crm_client_id IS NULL
      AND EXISTS (
        SELECT 1 FROM companies co
        WHERE co.ico = ct.ico AND co.crm_client_id IS NOT NULL
      )
  `)

  // Write audit log
  await client.query(`
    INSERT INTO operator_audit_log (action, entity_type, entity_id, details, operator_email, performed_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    'crm_backfill_contacts',
    'contacts',
    'batch_' + Date.now(),
    JSON.stringify({
      rows_updated: parseInt(rowCount),
      remaining_null: parseInt(afterCount),
      via: 'ico_company_link'
    }),
    'operator@audit',
    new Date()
  ])

  const elapsedMs = Date.now() - startTime

  // Output
  console.log('\nCRM backfill — contacts via ICO match')
  console.log('─'.repeat(60))
  console.log(`  Candidates (before):          ${beforeCount}`)
  console.log(`  Rows updated:                 ${rowCount}`)
  console.log(`  Remaining null (after):       ${afterCount}`)
  console.log(`  Idempotent:                   ${afterCount === '0' ? 'yes ✓' : 'rerun may update ' + afterCount}`)
  console.log('')
  console.log(`  Query: ${elapsedMs} ms`)
  console.log('')
  console.log('Audit log entry written to operator_audit_log.')

} catch (e) {
  console.error('✗ Backfill failed:', e.message)
  process.exit(1)
} finally {
  await client.end()
}
