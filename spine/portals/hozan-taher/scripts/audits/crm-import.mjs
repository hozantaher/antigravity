#!/usr/bin/env node
// crm-import.mjs — eWAY-CRM XLSX import → crm_clients + FK linkage.
//
// Reads two XLSX exports from eWAY-CRM:
//   1. Klienti_výběr.xlsx — all clients (Stav: Potenciální | Aktuální | Nezajímavý)
//   2. Obchodní_případy_výběr.xlsx — only Stav='Začínáme' rows imported
//      (Výhra/Zrušeno/Proběhlo jednání ignored per operator 2026-05-05)
//
// For each row:
//   - UPSERT into crm_clients ON (imported_from, entity_id)
//   - Match to existing companies via ICO → set companies.crm_client_id
//   - Match to existing contacts via email_primary OR email_secondary →
//     set contacts.crm_client_id
//
// Reads DATABASE_URL from apps/outreach-dashboard/.env per memory
// feedback_no_pii_in_commands. Aggregate counts only in stdout — no PII.
//
// Usage:
//   pnpm crm:import                           # default paths in ~/Downloads
//   node scripts/audits/crm-import.mjs --klienti=<path> --op=<path>
//   pnpm crm:import --dry-run                 # preview, no DB writes

import ExcelJS from 'exceljs'
import pg from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const envPath = join(repoRoot, 'apps', 'outreach-dashboard', '.env')

// ── arg parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
function arg(name, def) {
  const m = args.find(a => a.startsWith(`--${name}=`))
  return m ? m.split('=')[1] : def
}
const defaultDl = join(homedir(), 'Downloads')
const klientiPath = arg('klienti', join(defaultDl, 'Klienti_výběr.xlsx'))
const opPath = arg('op', join(defaultDl, 'Obchodní_případy_výběr.xlsx'))

if (!existsSync(klientiPath)) {
  console.error(`✗ Klienti XLSX not found: ${klientiPath}`)
  process.exit(2)
}
if (!existsSync(opPath)) {
  console.error(`✗ OP XLSX not found: ${opPath}`)
  process.exit(2)
}

// ── DB connect ──────────────────────────────────────────────────────────
const envText = readFileSync(envPath, 'utf8')
const dsnLine = envText.split('\n').find(l => /^(DATABASE_URL|OUTREACH_DATABASE_URL)=/.test(l))
if (!dsnLine) {
  console.error(`✗ DATABASE_URL missing in ${envPath}`)
  process.exit(2)
}
const dsn = dsnLine.split('=', 2)[1].replace(/^"|"$/g, '')

const client = new pg.Client({ connectionString: dsn })
await client.connect()

// ── XLSX read helpers ──────────────────────────────────────────────────
async function readSheet(path) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  const ws = wb.worksheets[0]
  // Header on row 2 (row 1 is title banner like "Klient - Výběr")
  const header = ws.getRow(2).values.slice(1)
  const rows = []
  for (let r = 3; r <= ws.rowCount; r++) {
    const v = ws.getRow(r).values.slice(1)
    if (!v.length || !v.some(x => x != null && x !== '')) continue
    const obj = {}
    header.forEach((h, i) => { obj[h] = v[i] })
    rows.push(obj)
  }
  return rows
}

function clean(v) {
  if (v == null) return null
  const s = typeof v === 'string' ? v.trim() : (v.text ?? v.result ?? String(v))
  return s === '' ? null : s
}
function cleanEmail(v) {
  const s = clean(v)
  return s ? s.toLowerCase() : null
}
function cleanDate(v) {
  if (!v) return null
  if (v instanceof Date) return v.toISOString()
  const s = clean(v)
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// ── Read both files ────────────────────────────────────────────────────
console.log(`→ Reading ${klientiPath}…`)
const klientiRows = await readSheet(klientiPath)
console.log(`  ${klientiRows.length} rows`)

console.log(`→ Reading ${opPath}…`)
const opRowsAll = await readSheet(opPath)
// Filter: only Stav='Začínáme' per operator 2026-05-05
const opRows = opRowsAll.filter(r => (r['Stav'] || '').trim() === 'Začínáme')
console.log(`  ${opRowsAll.length} rows total, ${opRows.length} after Stav='Začínáme' filter`)

// ── Map XLSX → crm_clients schema ──────────────────────────────────────
function mapKlient(r) {
  return {
    entity_id: r['ID entity'] != null ? Number(r['ID entity']) : null,
    imported_from: 'eway-klienti',
    ico: clean(r['IČO']),
    dic: clean(r['DIČ']),
    name: clean(r['Název/Jméno']) || '(unnamed)',
    email_primary: cleanEmail(r['Email']),
    email_secondary: cleanEmail(r['Email 2']),
    phone_primary: clean(r['Tel 1']),
    phone_secondary: clean(r['Tel 2']),
    crm_status: clean(r['Stav']),
    crm_relationship: clean(r['Vztah']),
    rating: clean(r['Rating']),
    city: clean(r['Město (kontaktní)']) || clean(r['Město (sídlo)']),
    region: clean(r['Kraj (region - kontaktní)']) || clean(r['Kraj (region - sídlo)']),
    country: clean(r['Země (kontaktní)']) || clean(r['Země (sídlo)']),
    zip: clean(r['PSČ (kontaktní)']) || clean(r['PSČ (sídlo)']),
    street: clean(r['Ulice (kontaktní)']) || clean(r['Ulice (sídlo)']),
    owner_email: clean(r['Vlastník']) || clean(r['Naposledy změnil']),
    last_activity: cleanDate(r['Poslední aktivita']),
    notes: clean(r['Poznámka']),
    op_code: null,
    op_subject: null,
    op_opened_at: null,
    op_estimated_close: null,
  }
}

function mapOP(r) {
  return {
    entity_id: r['ID entity'] != null ? Number(r['ID entity']) : null,
    imported_from: 'eway-op-zacinam',
    ico: clean(r['IČO']),
    dic: clean(r['DIČ']),
    name: clean(r['Klient']) || '(unnamed)',
    email_primary: cleanEmail(r['Klient - e-mail']),
    email_secondary: cleanEmail(r['Kontaktní osoba - e-mail']),
    phone_primary: clean(r['Klient - telefon']),
    phone_secondary: clean(r['Kontaktní osoba - telefon']),
    crm_status: clean(r['Stav']),
    crm_relationship: 'Odběratel',
    rating: null,
    city: clean(r['Město']),
    region: clean(r['Kraj (Region)']),
    country: clean(r['Země']),
    zip: clean(r['PSČ']),
    street: clean(r['Ulice']),
    owner_email: clean(r['Vlastník']) || clean(r['Naposledy změnil']),
    last_activity: cleanDate(r['Naposledy změněno']),
    notes: clean(r['Popis']),
    op_code: clean(r['Kód']),
    op_subject: clean(r['Předmět']),
    op_opened_at: cleanDate(r['Otevřeno od']),
    op_estimated_close: cleanDate(r['Odhad uzavření']),
  }
}

const allRows = [
  ...klientiRows.map(mapKlient),
  ...opRows.map(mapOP),
]
console.log(`→ ${allRows.length} total rows to import (${klientiRows.length} klienti + ${opRows.length} OP-Začínáme)`)

if (dryRun) {
  console.log('\nDry run — no DB writes. Sample mapped row:')
  console.log(JSON.stringify(allRows[0], null, 2))
  await client.end()
  process.exit(0)
}

// ── UPSERT into crm_clients ────────────────────────────────────────────
let inserted = 0, updated = 0, skipped = 0
for (const row of allRows) {
  if (row.entity_id == null) {
    skipped++
    continue // can't UPSERT without entity_id (idempotency key)
  }
  const r = await client.query(`
    INSERT INTO crm_clients (
      entity_id, imported_from, ico, dic, name,
      email_primary, email_secondary, phone_primary, phone_secondary,
      crm_status, crm_relationship, rating,
      city, region, country, zip, street,
      owner_email, last_activity, notes,
      op_code, op_subject, op_opened_at, op_estimated_close,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12,
      $13,$14,$15,$16,$17, $18,$19,$20,
      $21,$22,$23,$24, now()
    )
    ON CONFLICT (imported_from, entity_id) DO UPDATE SET
      ico = EXCLUDED.ico,
      dic = EXCLUDED.dic,
      name = EXCLUDED.name,
      email_primary = EXCLUDED.email_primary,
      email_secondary = EXCLUDED.email_secondary,
      phone_primary = EXCLUDED.phone_primary,
      phone_secondary = EXCLUDED.phone_secondary,
      crm_status = EXCLUDED.crm_status,
      crm_relationship = EXCLUDED.crm_relationship,
      rating = EXCLUDED.rating,
      city = EXCLUDED.city,
      region = EXCLUDED.region,
      country = EXCLUDED.country,
      zip = EXCLUDED.zip,
      street = EXCLUDED.street,
      owner_email = EXCLUDED.owner_email,
      last_activity = EXCLUDED.last_activity,
      notes = EXCLUDED.notes,
      op_code = EXCLUDED.op_code,
      op_subject = EXCLUDED.op_subject,
      op_opened_at = EXCLUDED.op_opened_at,
      op_estimated_close = EXCLUDED.op_estimated_close,
      updated_at = now()
    RETURNING (xmax = 0) AS inserted
  `, [
    row.entity_id, row.imported_from, row.ico, row.dic, row.name,
    row.email_primary, row.email_secondary, row.phone_primary, row.phone_secondary,
    row.crm_status, row.crm_relationship, row.rating,
    row.city, row.region, row.country, row.zip, row.street,
    row.owner_email, row.last_activity, row.notes,
    row.op_code, row.op_subject, row.op_opened_at, row.op_estimated_close,
  ])
  if (r.rows[0].inserted) inserted++
  else updated++
}
console.log(`✓ crm_clients: ${inserted} inserted, ${updated} updated, ${skipped} skipped (no entity_id)`)

// ── FK linkage: companies via ICO ──────────────────────────────────────
const lc = await client.query(`
  UPDATE companies c
  SET crm_client_id = cc.id
  FROM crm_clients cc
  WHERE c.crm_client_id IS DISTINCT FROM cc.id
    AND c.ico = cc.ico
    AND cc.ico IS NOT NULL AND cc.ico <> ''
`)
console.log(`✓ companies linked by ICO: ${lc.rowCount}`)

// ── FK linkage: contacts via email ─────────────────────────────────────
const lt1 = await client.query(`
  UPDATE contacts ct
  SET crm_client_id = cc.id
  FROM crm_clients cc
  WHERE ct.crm_client_id IS DISTINCT FROM cc.id
    AND lower(trim(ct.email)) = lower(trim(cc.email_primary))
    AND cc.email_primary IS NOT NULL AND cc.email_primary <> ''
`)
console.log(`✓ contacts linked via email_primary: ${lt1.rowCount}`)

const lt2 = await client.query(`
  UPDATE contacts ct
  SET crm_client_id = cc.id
  FROM crm_clients cc
  WHERE ct.crm_client_id IS NULL
    AND lower(trim(ct.email)) = lower(trim(cc.email_secondary))
    AND cc.email_secondary IS NOT NULL AND cc.email_secondary <> ''
`)
console.log(`✓ contacts linked via email_secondary: ${lt2.rowCount}`)

// ── Audit log row ──────────────────────────────────────────────────────
await client.query(`
  INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
  VALUES ('crm_import', 'crm-import.mjs', 'crm_clients', 'all',
    jsonb_build_object(
      'klienti_count', $1::int,
      'op_zacinam_count', $2::int,
      'inserted', $3::int,
      'updated', $4::int,
      'skipped', $5::int,
      'linked_companies', $6::int,
      'linked_contacts_primary', $7::int,
      'linked_contacts_secondary', $8::int
    ),
    now()
  )
`, [
  klientiRows.length, opRows.length, inserted, updated, skipped,
  lc.rowCount, lt1.rowCount, lt2.rowCount,
])

await client.end()
console.log('\n✓ Import complete. Next: pnpm crm:suppress-backfill')
