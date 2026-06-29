// CRM clients route surface — list, detail, stats, freshness.
// ─────────────────────────────────────────────────────────────────────────────
// Sprint CRM-7 (2026-05-05): operator UI for /api/crm/clients paginated list
// with filters (status, relationship, has_email, owner, search), expandable
// detail drawer showing linked company + linked contacts.
//
// Routes covered (4 total):
//   GET  /api/crm/clients              — paginated list with facets
//   GET  /api/crm/clients/:id          — single client + linked company/contacts
//   GET  /api/crm/clients/stats        — aggregate counts (status × relationship)
//   GET  /api/crm/clients/freshness    — last import timestamp + staleness flag

/**
 * Mount the CRM clients route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, unknown>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountCrmRoutes(app, deps) {
  const { pool, setRouteTags, capture500, safeError } = deps

  // GET /api/crm/clients — paginated list with filters
  app.get('/api/crm/clients', async (req, res) => {
    setRouteTags({ 'page.type': 'crm-clients-list' })
    try {
      const {
        search,
        status,
        relationship,
        has_email,
        owner,
        limit = 100,
        offset = 0,
        sort = 'name',
        dir = 'asc',
      } = req.query

      const conds = ['1=1']
      const params = []
      let p = 1

      // Search: name, email_primary, ico
      if (search) {
        conds.push(`(cc.name ILIKE $${p} OR cc.email_primary ILIKE $${p} OR cc.ico ILIKE $${p})`)
        params.push(`%${search}%`)
        p++
      }

      // Status filter
      if (status) {
        if (Array.isArray(status)) {
          conds.push(`cc.crm_status = ANY($${p}::text[])`)
          params.push(status)
        } else {
          conds.push(`cc.crm_status = $${p}`)
          params.push(status)
        }
        p++
      }

      // Relationship filter
      if (relationship) {
        if (Array.isArray(relationship)) {
          conds.push(`cc.crm_relationship = ANY($${p}::text[])`)
          params.push(relationship)
        } else {
          conds.push(`cc.crm_relationship = $${p}`)
          params.push(relationship)
        }
        p++
      }

      // Has email filter
      if (has_email === '1') {
        conds.push(`cc.email_primary IS NOT NULL AND cc.email_primary <> ''`)
      } else if (has_email === '0') {
        conds.push(`(cc.email_primary IS NULL OR cc.email_primary = '')`)
      }

      // Owner filter
      if (owner) {
        conds.push(`cc.owner_email = $${p}`)
        params.push(owner)
        p++
      }

      const whereClause = conds.join(' AND ')

      // Parallel: fetch list + count + facets
      const [
        { rows: clients },
        { rows: [{ total }] },
        { rows: statusFacets },
        { rows: relationshipFacets },
      ] = await Promise.all([
        pool.query(
          `SELECT cc.id, cc.name, cc.ico, cc.email_primary, cc.crm_status, cc.crm_relationship,
                  cc.owner_email, cc.last_activity, cc.imported_from,
                  (SELECT COUNT(*) FROM companies WHERE crm_client_id = cc.id)::int AS linked_companies,
                  (SELECT COUNT(*) FROM contacts WHERE crm_client_id = cc.id)::int AS linked_contacts
           FROM crm_clients cc
           WHERE ${whereClause}
           ORDER BY ${sort === 'activity' ? 'cc.last_activity' : 'cc.name'} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, cc.id ASC
           LIMIT $${p} OFFSET $${p + 1}`,
          [...params, Number(limit), Number(offset)]
        ),
        pool.query(`SELECT COUNT(*)::int AS total FROM crm_clients cc WHERE ${whereClause}`, params),
        pool.query(
          `SELECT crm_status AS value, COUNT(*)::int AS count
           FROM crm_clients cc
           GROUP BY crm_status
           ORDER BY count DESC`
        ),
        pool.query(
          `SELECT crm_relationship AS value, COUNT(*)::int AS count
           FROM crm_clients cc
           GROUP BY crm_relationship
           ORDER BY count DESC`
        ),
      ])

      const facets = {
        status: statusFacets.filter((f) => f.value != null),
        relationship: relationshipFacets.filter((f) => f.value != null),
      }

      res.json({ rows: clients, total, facets })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // GET /api/crm/clients/:id — detail with linked company + contacts.
  // String-named subroutes (/stats, /freshness, /import) MUST be registered
  // BEFORE this :id catch-all (Express 5 path-to-regexp 8 doesn't support
  // inline `:id(\d+)` regex). The :id route falls through to next handler
  // when id is non-numeric so /stats etc. can match.
  app.get('/api/crm/clients/:id', async (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next()
    setRouteTags({ 'crm.action': 'detail' })
    try {
      const { id } = req.params
      const [
        { rows: [client] },
        { rows: linkedCompanies },
        { rows: linkedContacts },
      ] = await Promise.all([
        pool.query(
          `SELECT id, name, ico, email_primary, crm_status, crm_relationship, owner_email,
                  last_activity, last_activity_at, imported_from, created_at, updated_at
           FROM crm_clients WHERE id = $1`,
          [id]
        ),
        pool.query(
          `SELECT id, ico, name, email, category_path, best_targeting_score, email_status, last_contacted
           FROM companies WHERE crm_client_id = $1`,
          [id]
        ),
        pool.query(
          `SELECT id, email, first_name, last_name, company_name, status, email_status,
                  (SELECT COUNT(*) FROM send_events se WHERE se.contact_id = c.id)::int AS total_sent
           FROM contacts c WHERE crm_client_id = $1
           ORDER BY created_at DESC`,
          [id]
        ),
      ])

      if (!client) {
        return res.status(404).json({ error: 'not found' })
      }

      client.linked_companies = linkedCompanies
      client.linked_contacts = linkedContacts

      res.json(client)
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // GET /api/crm/clients/stats — aggregate counts
  app.get('/api/crm/clients/stats', async (req, res) => {
    setRouteTags({ 'crm.action': 'stats' })
    try {
      const { rows } = await pool.query(`
        SELECT crm_status, crm_relationship, COUNT(*)::int AS count
        FROM crm_clients
        GROUP BY crm_status, crm_relationship
        ORDER BY crm_status, crm_relationship
      `)

      const stats = {
        total: rows.reduce((sum, r) => sum + r.count, 0),
        by_status: {},
        by_relationship: {},
      }

      for (const r of rows) {
        if (!stats.by_status[r.crm_status]) stats.by_status[r.crm_status] = 0
        if (!stats.by_relationship[r.crm_relationship]) stats.by_relationship[r.crm_relationship] = 0
        stats.by_status[r.crm_status] += r.count
        stats.by_relationship[r.crm_relationship] += r.count
      }

      res.json(stats)
    } catch (e) {
      capture500(res, e, safeError)
    }
  })

  // POST /api/crm/clients/import — multipart XLSX upload
  app.post('/api/crm/clients/import', async (req, res) => {
    setRouteTags({ 'crm.action': 'import' })
    // Whole import (N upserts + 3 FK-linkage UPDATEs + audit row) runs in ONE
    // transaction: a mid-import failure rolls back partial writes, and the audit
    // row is never committed without the data it claims to describe.
    let client
    try {
      client = await pool.connect()
      const ExcelJS = await import('exceljs')
      const wb = new ExcelJS.default.Workbook()

      const files = req.files || {}
      if (!files.klienti && !files.op) {
        return res.status(400).json({ error: 'no files uploaded' })
      }

      // Helper functions (mirrored from crm-import.mjs)
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

      // Read sheet from buffer
      async function readSheetFromBuffer(buffer) {
        const wb2 = new ExcelJS.default.Workbook()
        await wb2.xlsx.load(buffer)
        const ws = wb2.worksheets[0]
        if (!ws) return []
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

      // Map functions
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

      // Read files
      let klientiRows = []
      let opRows = []
      let opRowsFiltered = 0

      if (files.klienti) {
        klientiRows = await readSheetFromBuffer(files.klienti.data)
        klientiRows = klientiRows.map(mapKlient)
      }

      if (files.op) {
        const opRowsAll = await readSheetFromBuffer(files.op.data)
        opRows = opRowsAll.filter(r => (r['Stav'] || '').trim() === 'Začínáme').map(mapOP)
        // Count of OP rows FILTERED OUT (Stav != 'Začínáme') — the audit + response
        // key is `*_filtered`, not the grand total (which is opRowsAll.length).
        opRowsFiltered = opRowsAll.length - opRows.length
      }

      const allRows = [...klientiRows, ...opRows]

      // UPSERT
      await client.query('BEGIN')
      let inserted = 0, updated = 0, skipped = 0
      for (const row of allRows) {
        if (row.entity_id == null) {
          skipped++
          continue
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

      // FK linkage: companies via ICO
      const lc = await client.query(`
        UPDATE companies c
        SET crm_client_id = cc.id
        FROM crm_clients cc
        WHERE c.crm_client_id IS DISTINCT FROM cc.id
          AND c.ico = cc.ico
          AND cc.ico IS NOT NULL AND cc.ico <> ''
      `)

      // FK linkage: contacts via email
      const lt1 = await client.query(`
        UPDATE contacts ct
        SET crm_client_id = cc.id
        FROM crm_clients cc
        WHERE ct.crm_client_id IS DISTINCT FROM cc.id
          AND lower(trim(ct.email)) = lower(trim(cc.email_primary))
          AND cc.email_primary IS NOT NULL AND cc.email_primary <> ''
      `)

      const lt2 = await client.query(`
        UPDATE contacts ct
        SET crm_client_id = cc.id
        FROM crm_clients cc
        WHERE ct.crm_client_id IS NULL
          AND lower(trim(ct.email)) = lower(trim(cc.email_secondary))
          AND cc.email_secondary IS NOT NULL AND cc.email_secondary <> ''
      `)

      // Audit log
      const auditRes = await client.query(`
        INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details, created_at)
        VALUES ('crm_import', 'dashboard-ui', 'crm_clients', 'all',
          jsonb_build_object(
            'rows_in_klienti', $1::int,
            'rows_in_op', $2::int,
            'klienti_filtered', $3::int,
            'inserted', $4::int,
            'updated', $5::int,
            'skipped', $6::int,
            'linked_companies', $7::int,
            'linked_contacts_email_primary', $8::int,
            'linked_contacts_email_secondary', $9::int
          ),
          now()
        )
        RETURNING id
      `, [
        klientiRows.length, opRows.length, opRowsFiltered,
        inserted, updated, skipped,
        lc.rowCount, lt1.rowCount, lt2.rowCount,
      ])

      const auditId = auditRes.rows[0]?.id

      await client.query('COMMIT')

      res.json({
        rows_in_klienti: klientiRows.length,
        rows_in_op: opRows.length,
        klienti_filtered: opRowsFiltered,
        inserted,
        updated,
        linked_companies: lc.rowCount,
        linked_contacts_email_primary: lt1.rowCount,
        linked_contacts_email_secondary: lt2.rowCount,
        audit_log_id: auditId,
      })
    } catch (e) {
      if (client) { try { await client.query('ROLLBACK') } catch { /* ignored */ } }
      capture500(res, e, safeError)
    } finally {
      if (client) client.release()
    }
  })

  // GET /api/crm/clients/freshness — last import timestamp + staleness flag
  app.get('/api/crm/clients/freshness', async (req, res) => {
    setRouteTags({ 'crm.action': 'freshness' })
    try {
      const thresholdDays = parseInt(req.query.threshold || '7', 10)

      const { rows } = await pool.query(`
        SELECT created_at
        FROM operator_audit_log
        WHERE action = 'crm_import'
        ORDER BY created_at DESC
        LIMIT 1
      `)

      if (rows.length === 0) {
        return res.json({
          last_import_at: null,
          days_stale: null,
          threshold_days: thresholdDays,
          is_stale: true,
          never_imported: true,
        })
      }

      const lastImportAt = new Date(rows[0].created_at)
      const now = new Date()
      const daysStale = Math.floor((now - lastImportAt) / (1000 * 60 * 60 * 24))

      res.json({
        last_import_at: lastImportAt.toISOString(),
        days_stale: daysStale,
        threshold_days: thresholdDays,
        is_stale: daysStale >= thresholdDays,
        never_imported: false,
      })
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}
