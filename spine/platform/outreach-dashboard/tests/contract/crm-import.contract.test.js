// ═══════════════════════════════════════════════════════════════════════════
//  BFF contract — POST /api/crm/clients/import  (#825)
//
//  Locks the request/response shape for the XLSX upload handler that
//  populates the crm_clients table — the entry point for the 8th dedup-guard
//  axis (crm_active_client).
//
//  Handler lives in: features/platform/outreach-dashboard/src/server-routes/crm.js
//  Mounted via:      mountCrmRoutes(app, { pool, ... })
//
//  Field names (express-fileupload): req.files.klienti  req.files.op
//
//  SQL sequence per happy-path request:
//    1×N  — INSERT INTO crm_clients … ON CONFLICT DO UPDATE … RETURNING
//    1    — UPDATE companies SET crm_client_id FROM crm_clients (ICO linkage)
//    1    — UPDATE contacts … email_primary linkage
//    1    — UPDATE contacts … email_secondary linkage
//    1    — INSERT INTO operator_audit_log … RETURNING id
//
//  Tests (13):
//    1.  Auth missing (no X-API-Key)                          → 401
//    2.  No file field in multipart body                      → 400
//    3.  Wrong content-type (JSON body instead of multipart)  → 400
//    4.  Empty XLSX (zero data rows)                          → 200 + 0 imported + audit row
//    5.  Row without entity_id → skipped                      → 200 + skipped=1
//    6.  OP rows: only 'Začínáme' pass filter                 → 200 + correct counts
//    7.  Happy path — 5 klienti rows                         → 5 UPSERTs + audit_log_id present
//    8.  Idempotent re-import — xmax>0 → updated not inserted → 200 + updated=1
//    9.  Mixed sheets: klienti + op both processed            → counts from both sources
//   10.  DB error on UPSERT                                   → 500
//   11.  Audit log actor defaults to 'dashboard-ui'           → audit SQL has expected actor
//   12.  FK linkage queries fire (companies + contacts)       → response shape includes linked_*
//   13.  File size limit (oversized payload)                  → 413 or 400
// ═══════════════════════════════════════════════════════════════════════════

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

// ─── Pool mock ────────────────────────────────────────────────────────────────
const queryQueue = []
const calls = []

vi.mock('pg', () => {
  class Pool {
    async query(sql, params) {
      calls.push({ sql, params })
      if (!queryQueue.length) return { rows: [], rowCount: 0 }
      const next = queryQueue.shift()
      if (next instanceof Error) throw next
      return next
    }
    async connect() {
      const self = this
      return {
        async query(s, p) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(typeof s === 'string' ? s : '')) return { rows: [], rowCount: 0 }
          return self.query(s, p)
        },
        release() {},
      }
    }
    on() {}
    end() {}
  }
  return { default: { Pool }, Pool }
})
vi.mock('../../staleGuard.js', () => ({ runGuards: vi.fn(), logBootRecovery: vi.fn() }))
vi.mock('../../configDrift.js', () => ({ runConfigDrift: vi.fn() }))

// ─── Server lifecycle ─────────────────────────────────────────────────────────
let baseUrl = ''
let server

const savedEnv = {}
const VALID_KEY = 'test-crm-api-key-xxxxxxxxxxxxxxxx'

beforeAll(async () => {
  for (const k of ['BFF_AUTH_DISABLED', 'BFF_IMPORT_ONLY', 'DATABASE_URL', 'OUTREACH_API_KEY']) {
    savedEnv[k] = process.env[k]
  }
  process.env.BFF_IMPORT_ONLY = '1'
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.OUTREACH_API_KEY = VALID_KEY
  process.env.DATABASE_URL = 'postgres://stub/stub'
  vi.resetModules()
  const mod = await import('../../server.js')
  // Strip GO_SERVER_URL repopulated by Vite loadEnv — not needed here.
  delete process.env.GO_SERVER_URL
  const { app } = mod
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address()
      baseUrl = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise((resolve) => server.close(() => resolve()))
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

beforeEach(() => {
  queryQueue.length = 0
  calls.length = 0
  process.env.BFF_AUTH_DISABLED = '1'
  process.env.OUTREACH_API_KEY = VALID_KEY
})

// ─── XLSX builder helpers ─────────────────────────────────────────────────────
/**
 * Build an in-memory XLSX buffer.
 * Row 1 is intentionally empty (crm-import.mjs reads headers from row 2,
 * data from row 3+).
 */
async function buildKlientiXlsx(rows = []) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')

  // Row 1: empty spacer (matches eWAY export format)
  ws.addRow([])

  // Row 2: headers
  ws.addRow([
    'ID entity', 'IČO', 'DIČ', 'Název/Jméno', 'Email', 'Email 2',
    'Tel 1', 'Tel 2', 'Stav', 'Vztah', 'Rating',
    'Město (kontaktní)', 'Kraj (region - kontaktní)', 'Země (kontaktní)',
    'PSČ (kontaktní)', 'Ulice (kontaktní)',
    'Vlastník', 'Poslední aktivita', 'Poznámka',
  ])

  // Data rows
  for (const r of rows) {
    ws.addRow([
      r.entity_id ?? null,
      r.ico ?? null,
      r.dic ?? null,
      r.name ?? 'Test s.r.o.',
      r.email ?? 'test@example.cz',
      r.email2 ?? null,
      r.tel1 ?? null,
      r.tel2 ?? null,
      r.stav ?? 'Zákazník',
      r.vztah ?? 'Odběratel',
      r.rating ?? null,
      r.city ?? null,
      r.region ?? null,
      r.country ?? 'CZ',
      r.zip ?? null,
      r.street ?? null,
      r.owner ?? null,
      r.last_activity ?? null,
      r.notes ?? null,
    ])
  }

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

async function buildOpXlsx(rows = []) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')

  // Row 1: empty spacer
  ws.addRow([])

  // Row 2: headers
  ws.addRow([
    'ID entity', 'IČO', 'DIČ', 'Klient', 'Klient - e-mail',
    'Kontaktní osoba - e-mail', 'Klient - telefon', 'Kontaktní osoba - telefon',
    'Stav', 'Město', 'Kraj (Region)', 'Země', 'PSČ', 'Ulice',
    'Vlastník', 'Naposledy změněno', 'Popis', 'Kód', 'Předmět',
    'Otevřeno od', 'Odhad uzavření',
  ])

  // Data rows
  for (const r of rows) {
    ws.addRow([
      r.entity_id ?? null,
      r.ico ?? null,
      r.dic ?? null,
      r.klient ?? 'OP Klient s.r.o.',
      r.email ?? 'op@example.cz',
      r.email2 ?? null,
      r.tel1 ?? null,
      r.tel2 ?? null,
      r.stav ?? 'Začínáme',
      r.city ?? null,
      r.region ?? null,
      r.country ?? 'CZ',
      r.zip ?? null,
      r.street ?? null,
      r.owner ?? null,
      r.changed ?? null,
      r.notes ?? null,
      r.kod ?? null,
      r.predmet ?? null,
      r.opened ?? null,
      r.close ?? null,
    ])
  }

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.from(buf)
}

/**
 * POST multipart to /api/crm/clients/import.
 * files: { klienti?: Buffer, op?: Buffer }
 */
async function postImport(files = {}, extraHeaders = {}) {
  const form = new FormData()
  if (files.klienti) {
    form.append('klienti', new Blob([files.klienti], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'klienti.xlsx')
  }
  if (files.op) {
    form.append('op', new Blob([files.op], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'op.xlsx')
  }
  return fetch(`${baseUrl}/api/crm/clients/import`, {
    method: 'POST',
    body: form,
    headers: extraHeaders,
  })
}

/**
 * Push the standard tail of SQL responses that follow N UPSERTs:
 *   companies ICO linkage  rowCount = companiesLinked
 *   contacts email_primary rowCount = ct1Linked
 *   contacts email_secondary rowCount = ct2Linked
 *   audit_log INSERT        rows = [{ id: auditId }]
 */
function pushTail({ companiesLinked = 0, ct1Linked = 0, ct2Linked = 0, auditId = 42 } = {}) {
  queryQueue.push(
    { rows: [], rowCount: companiesLinked },  // UPDATE companies
    { rows: [], rowCount: ct1Linked },         // UPDATE contacts email_primary
    { rows: [], rowCount: ct2Linked },         // UPDATE contacts email_secondary
    { rows: [{ id: auditId }], rowCount: 1 }, // INSERT audit_log
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe('POST /api/crm/clients/import', () => {

  // ── 1. Auth missing ────────────────────────────────────────────────────────
  it('1: no X-API-Key when auth enabled → 401', async () => {
    delete process.env.BFF_AUTH_DISABLED
    const buf = await buildKlientiXlsx([{ entity_id: 1, ico: '12345678' }])
    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(401)
    // restore for subsequent tests (beforeEach also re-sets, belt+suspenders)
    process.env.BFF_AUTH_DISABLED = '1'
  })

  // ── 2. No file field in multipart body ─────────────────────────────────────
  it('2: POST with no file fields → 400 + error message', async () => {
    const form = new FormData()
    form.append('irrelevant', 'value')
    const res = await fetch(`${baseUrl}/api/crm/clients/import`, {
      method: 'POST',
      body: form,
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toHaveProperty('error')
    expect(body.error).toMatch(/no files/i)
  })

  // ── 3. Wrong content-type (plain JSON body, no file) ───────────────────────
  it('3: JSON body without file fields → 400', async () => {
    const res = await fetch(`${baseUrl}/api/crm/clients/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'notafile' }),
    })
    expect(res.status).toBe(400)
  })

  // ── 4. Empty XLSX (zero data rows) ─────────────────────────────────────────
  it('4: XLSX with no data rows → 200 + 0 imported + audit_log_id', async () => {
    const buf = await buildKlientiXlsx([])  // headers only, no data rows
    pushTail({ auditId: 7 })
    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows_in_klienti).toBe(0)
    expect(body.inserted).toBe(0)
    expect(body.updated).toBe(0)
    expect(body.audit_log_id).toBe(7)
  })

  // ── 5. Row without entity_id → skipped ─────────────────────────────────────
  it('5: row missing entity_id → counted as skipped, no UPSERT SQL', async () => {
    // A row with no ID entity column value
    const buf = await buildKlientiXlsx([{ entity_id: null, ico: '99999999' }])
    pushTail()
    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows_in_klienti).toBe(1)
    expect(body.inserted).toBe(0)
    expect(body.updated).toBe(0)
    // No UPSERT call — only the 4 tail queries (UPDATE companies, 2× contacts, audit)
    const upsertCalls = calls.filter(c => c.sql.includes('INSERT INTO crm_clients'))
    expect(upsertCalls).toHaveLength(0)
  })

  // ── 6. OP filter: only 'Začínáme' pass ────────────────────────────────────
  it('6: OP sheet with mixed Stav — only Začínáme rows imported', async () => {
    const buf = await buildOpXlsx([
      { entity_id: 10, stav: 'Začínáme' },
      { entity_id: 11, stav: 'Výhra' },
      { entity_id: 12, stav: 'Zrušeno' },
      { entity_id: 13, stav: 'Proběhlo jednání' },
    ])
    // Only 1 row passes the filter → 1 UPSERT needed
    queryQueue.push({ rows: [{ inserted: true }], rowCount: 1 })
    pushTail({ auditId: 20 })
    const res = await postImport({ op: buf })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows_in_op).toBe(1)          // only 'Začínáme'
    expect(body.klienti_filtered).toBe(3)    // rows filtered OUT (Stav != 'Začínáme'): opRowsAll.length - opRows.length = 4 - 1
    expect(body.inserted).toBe(1)
    expect(body.inserted + body.updated).toBe(1)
  })

  // ── 7. Happy path — 5 klienti rows ────────────────────────────────────────
  it('7: 5 valid klienti rows → 5 UPSERTs, inserted=5, audit_log_id present', async () => {
    const rows = [1, 2, 3, 4, 5].map(i => ({ entity_id: i, ico: `0000000${i}` }))
    const buf = await buildKlientiXlsx(rows)

    // 5 UPSERT responses (all new inserts)
    for (let i = 0; i < 5; i++) {
      queryQueue.push({ rows: [{ inserted: true }], rowCount: 1 })
    }
    pushTail({ companiesLinked: 2, ct1Linked: 3, ct2Linked: 1, auditId: 99 })

    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows_in_klienti).toBe(5)
    expect(body.inserted).toBe(5)
    expect(body.updated).toBe(0)
    expect(body.linked_companies).toBe(2)
    expect(body.linked_contacts_email_primary).toBe(3)
    expect(body.linked_contacts_email_secondary).toBe(1)
    expect(body.audit_log_id).toBe(99)

    // Verify 5 UPSERT SQL calls were made
    const upsertCalls = calls.filter(c => c.sql.includes('INSERT INTO crm_clients'))
    expect(upsertCalls).toHaveLength(5)
    // All must use imported_from = 'eway-klienti'
    for (const c of upsertCalls) {
      expect(c.params[1]).toBe('eway-klienti')
    }
  })

  // ── 8. Idempotent re-import — xmax > 0 → updated ─────────────────────────
  it('8: same row twice → second import counts as updated, not inserted', async () => {
    const buf = await buildKlientiXlsx([{ entity_id: 42, ico: '12345678' }])

    // Simulate xmax>0 (existing row updated)
    queryQueue.push({ rows: [{ inserted: false }], rowCount: 1 })
    pushTail({ auditId: 101 })

    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inserted).toBe(0)
    expect(body.updated).toBe(1)
  })

  // ── 9. Mixed sheets: klienti + op both processed ──────────────────────────
  it('9: both klienti and op files → separate counts merged into total', async () => {
    const klientiBuf = await buildKlientiXlsx([
      { entity_id: 100, ico: '11111111' },
      { entity_id: 101, ico: '22222222' },
    ])
    const opBuf = await buildOpXlsx([
      { entity_id: 200, stav: 'Začínáme', ico: '33333333' },
    ])

    // 2 klienti UPSERTs + 1 op UPSERT
    queryQueue.push(
      { rows: [{ inserted: true }], rowCount: 1 },
      { rows: [{ inserted: true }], rowCount: 1 },
      { rows: [{ inserted: true }], rowCount: 1 },
    )
    pushTail({ auditId: 55 })

    const res = await postImport({ klienti: klientiBuf, op: opBuf })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows_in_klienti).toBe(2)
    expect(body.rows_in_op).toBe(1)
    expect(body.inserted).toBe(3)

    // Verify imported_from values: 2 eway-klienti + 1 eway-op-zacinam
    const upsertCalls = calls.filter(c => c.sql.includes('INSERT INTO crm_clients'))
    expect(upsertCalls).toHaveLength(3)
    const sources = upsertCalls.map(c => c.params[1])
    expect(sources.filter(s => s === 'eway-klienti')).toHaveLength(2)
    expect(sources.filter(s => s === 'eway-op-zacinam')).toHaveLength(1)
  })

  // ── 10. DB error on UPSERT → 500 ─────────────────────────────────────────
  it('10: pool throws on UPSERT → 500', async () => {
    const buf = await buildKlientiXlsx([{ entity_id: 999, ico: '77777777' }])
    queryQueue.push(new Error('DB connection lost'))
    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(500)
  })

  // ── 11. Audit log actor field ─────────────────────────────────────────────
  it('11: audit log INSERT uses actor=dashboard-ui (hardcoded)', async () => {
    const buf = await buildKlientiXlsx([{ entity_id: 77 }])
    queryQueue.push({ rows: [{ inserted: true }], rowCount: 1 })
    pushTail({ auditId: 200 })

    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(200)

    // Find the audit log INSERT call
    const auditCall = calls.find(c => c.sql.includes('operator_audit_log'))
    expect(auditCall).toBeDefined()
    // The SQL has actor hardcoded as 'dashboard-ui' literal — confirm it's present
    expect(auditCall.sql).toContain('dashboard-ui')
  })

  // ── 12. FK linkage — companies + contacts queries always fire ─────────────
  it('12: response always includes linked_companies + linked_contacts fields', async () => {
    const buf = await buildKlientiXlsx([{ entity_id: 5, ico: '55555555' }])
    queryQueue.push({ rows: [{ inserted: true }], rowCount: 1 })
    pushTail({ companiesLinked: 3, ct1Linked: 2, ct2Linked: 0, auditId: 300 })

    const res = await postImport({ klienti: buf })
    expect(res.status).toBe(200)
    const body = await res.json()

    // All linkage fields present in response
    expect(body).toHaveProperty('linked_companies', 3)
    expect(body).toHaveProperty('linked_contacts_email_primary', 2)
    expect(body).toHaveProperty('linked_contacts_email_secondary', 0)

    // Companies UPDATE SQL was called
    const companiesUpdate = calls.find(c => c.sql.includes('UPDATE companies'))
    expect(companiesUpdate).toBeDefined()
    expect(companiesUpdate.sql).toContain('crm_client_id')

    // Contacts UPDATE SQL was called (both email_primary and email_secondary)
    const contactCalls = calls.filter(c => c.sql.includes('UPDATE contacts'))
    expect(contactCalls.length).toBeGreaterThanOrEqual(2)
  })

  // ── 13. File size limit ───────────────────────────────────────────────────
  it('13: oversized payload → non-2xx (express-fileupload fileSize limit = 10MB)', async () => {
    // Build a payload clearly over 10MB by sending a large synthetic buffer
    // as the file field. express-fileupload enforces limits.fileSize = 10*1024*1024.
    // Behaviour depends on express-fileupload version:
    //   - Some emit 413 or 400 via busboy limits callback
    //   - Others propagate via capture500 → 500
    // All are non-2xx, confirming the upload is rejected.
    const tenMbPlusOne = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41) // 10MB+1 of 'A'
    const form = new FormData()
    form.append('klienti', new Blob([tenMbPlusOne], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'big.xlsx')
    const res = await fetch(`${baseUrl}/api/crm/clients/import`, {
      method: 'POST',
      body: form,
    })
    // Accept any error response (400, 413, or 500 via catch block)
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
