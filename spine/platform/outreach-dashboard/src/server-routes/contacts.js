// Contacts route surface — list, detail, patch, verify-email, delete.
// ─────────────────────────────────────────────────────────────────────────────
// D2.9 (2026-05-02): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after D2.6 mountTemplatesRoutes, D2.5 mountScoringRoutes, D2.2
// mountCompaniesRoutes). Behavior is byte-equivalent to the inline
// declarations: same SQL, same response shape, same Sentry capture, same
// Express route ordering.
//
// Routes covered (5 total):
//   GET    /api/contacts                  — paginated list with suppression flag
//   GET    /api/contacts/:id              — single contact + send_history (last 20)
//   PATCH  /api/contacts/:id              — partial update (status/first/last/company/dnt)
//   POST   /api/contacts/:id/verify-email — SMTP verify pipeline (rate-limited)
//   DELETE /api/contacts/:id              — drop row
//
// Suppression discipline: the list + detail SELECTs both consult the
// canonical `suppressionExistsFor('c.email')` fragment from
// src/lib/suppressionFilter.js — the EXISTS-OR-EXISTS shape that unions
// `outreach_suppressions` (Go-side) with `suppression_list` (BFF-side).
// `lower(trim(...))` normalisation lives inside the fragment so callers
// can't drift. Memory: project_two_suppression_tables.md.
//
// Helpers passed via `deps`:
//   - verifyEmail:       SMTP probe (src/lib/emailProbe.js).
//   - domainCache:       30-day MX/SPF/DMARC cache backed by `email_domains`.
//   - domainProbeLock:   Map<domain, last-probe-ts> guarding 5s/domain rate.
//   - DOMAIN_RATE_MS:    Numeric constant matching the rate window.
//   - capture500/safeError: standard error pipeline.
//
// All five live in server.js because non-contacts code paths
// (`/api/companies/:ico/verify-email`, full-check + greylist crons) also
// consume them. Exposing them via deps keeps the module dep-leaf.

/**
 * Mount the Contacts route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 *   suppressionExistsFor: (col: string) => string,
 *   verifyEmail: (email: string, opts: unknown) => Promise<{ status: string, confidence?: number }>,
 *   domainCache: { get: (d: string) => Promise<unknown>, set: (d: string, rec: unknown) => Promise<void> },
 *   domainProbeLock: Map<string, number>,
 *   DOMAIN_RATE_MS: number,
 *   checkOpRateLimit?: (pool: import('pg').Pool, mailboxId: number|string, opType: string, metadata?: Record<string, unknown>) => Promise<{ allowed: boolean, used: number, max: number, retryAfterSec: number }>,
 * }} deps
 */
export function mountContactsRoutes(app, deps) {
  const {
    pool,
    capture500,
    safeError,
    suppressionExistsFor,
    verifyEmail,
    domainCache,
    domainProbeLock,
    DOMAIN_RATE_MS,
    checkOpRateLimit,
  } = deps

  app.get('/api/contacts', async (req, res) => {
    try {
      const { search, status, engaged, company_ico, limit = 100, offset = 0 } = req.query
      const conds = ['1=1']
      const params = []
      let p = 1
      if (search) {
        conds.push(`(c.email ILIKE $${p} OR c.first_name ILIKE $${p} OR c.last_name ILIKE $${p} OR c.company_name ILIKE $${p} OR c.phone ILIKE $${p})`)
        params.push(`%${search}%`); p++
      }
      if (status) { conds.push(`c.status=$${p++}`); params.push(status) }
      // company_ico — list a company's contacts (firma→kontakty edge, #1586).
      if (company_ico) { conds.push(`c.ico=$${p++}`); params.push(String(company_ico)) }
      // engaged=1 — the operator-relevant universe: in the CRM, has replied, or
      // has a vehicle. Used by the Kontakty default view so it never dumps
      // 405k cold contacts. Search overrides to reach the full base.
      if (engaged === '1' || engaged === 'true') {
        conds.push(`(c.crm_client_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM reply_inbox r WHERE r.contact_id = c.id)
          OR EXISTS (SELECT 1 FROM vehicles v WHERE v.contact_id = c.id))`)
      }
      const countParams = [...params]
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM contacts c WHERE ${conds.join(' AND ')}`, countParams
      )
      const { rows } = await pool.query(
        `SELECT c.id, c.email, c.first_name, c.last_name, c.company_name, c.status,
                c.email_status, c.email_verified_at, c.email_confidence, c.phone,
                (SELECT MAX(se.sent_at) FROM send_events se WHERE se.contact_id=c.id) AS last_contact_at,
                (SELECT COUNT(*) FROM send_events se WHERE se.contact_id=c.id)::int AS total_sent,
                ${suppressionExistsFor('c.email')} AS suppressed,
                c.crm_client_id
         FROM contacts c
         WHERE ${conds.join(' AND ')}
         ORDER BY last_contact_at DESC NULLS LAST, c.id DESC
         LIMIT $${p++} OFFSET $${p++}`,
        [...params, Number(limit), Number(offset)]
      )
      // CRM-7: enrich list rows with crm status when crm_client_id is present
      for (const row of rows) {
        if (row.crm_client_id) {
          const { rows: [crm] } = await pool.query(
            `SELECT crm_status, crm_relationship, owner_email, last_activity,
                    imported_from
             FROM crm_clients WHERE id = $1`, [row.crm_client_id]
          ).catch(() => ({ rows: [] }))
          if (crm) row.crm = crm
        }
      }
      res.json({ rows, total: countRows[0]?.total ?? rows.length })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.get('/api/contacts/:id', async (req, res) => {
    try {
      // Validate ID is numeric before hitting DB. Non-numeric IDs from SPA
      // navigation with garbage params (e.g. monkey testing) would produce a
      // DB type error or waste a connection. Return 400 fast instead of 404
      // so the caller knows to stop retrying. useResource treats 404 as empty
      // via silentStatuses, but 400 is the correct semantic for bad input.
      const rawId = req.params.id
      if (!/^\d+$/.test(rawId)) {
        return res.status(400).json({ error: 'invalid_id' })
      }
      const { rows } = await pool.query(
        `SELECT c.id, c.email, c.first_name, c.last_name, c.company_name, c.status,
                c.email_status, c.email_verified_at, c.email_verification, c.email_confidence,
                c.dnt, c.phone, c.ico,
                (SELECT MAX(se.sent_at) FROM send_events se WHERE se.contact_id=c.id) AS last_contact_at,
                (SELECT COUNT(*) FROM send_events se WHERE se.contact_id=c.id)::int AS total_sent,
                ${suppressionExistsFor('c.email')} AS suppressed,
                c.crm_client_id
         FROM contacts c WHERE c.id=$1`, [rawId]
      )
      if (!rows.length) return res.status(404).json({ error: 'not found' })
      const contact = rows[0]
      // CRM-7: enrich contact drawer with CRM badge data
      if (contact.crm_client_id) {
        const { rows: [crm] } = await pool.query(
          `SELECT crm_status, crm_relationship, owner_email, last_activity, imported_from
           FROM crm_clients WHERE id = $1`, [contact.crm_client_id]
        ).catch(() => ({ rows: [] }))
        if (crm) contact.crm = crm
      }
      // Campaign membership + send timing — drives the contact detail's
      // per-contact "Reset časování" action (#1403).
      const { rows: campaigns } = await pool.query(
        `SELECT cc.campaign_id, cc.status, cc.next_send_at, c.name AS campaign_name
           FROM campaign_contacts cc
           JOIN campaigns c ON c.id = cc.campaign_id
          WHERE cc.contact_id = $1
          ORDER BY cc.next_send_at DESC NULLS LAST`, [req.params.id]
      ).catch(() => ({ rows: [] }))
      const { rows: history } = await pool.query(
        `SELECT se.sent_at, se.status, se.subject, se.smtp_response, m.from_address AS mailbox_email
         FROM send_events se
         LEFT JOIN outreach_mailboxes m ON m.from_address=se.mailbox_used
         WHERE se.contact_id=$1 ORDER BY se.sent_at DESC LIMIT 20`, [req.params.id]
      )
      res.json({ ...contact, send_history: history, campaigns })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.patch('/api/contacts/:id', async (req, res) => {
    // Validate dnt field early — must be a strict boolean (not string/number/null)
    if (req.body.dnt !== undefined && typeof req.body.dnt !== 'boolean') {
      return res.status(400).json({ error: 'dnt must be a boolean' })
    }
    // Phone (#1581 M2.2) — operator-confirmed save of a mined/signature number.
    // Accept an E.164-ish string (the mined tel is already +420XXXXXXXXX) or
    // null/'' to clear. Reject any other shape so a regex misfire can't land a
    // junk value on the canonical contact.
    let phoneUpdate // undefined = not touched
    if (req.body.phone !== undefined) {
      const raw = req.body.phone
      if (raw === null || raw === '') {
        phoneUpdate = null
      } else if (typeof raw === 'string' && /^\+?\d{9,15}$/.test(raw.replace(/[\s.\-/]/g, ''))) {
        const digits = raw.replace(/[\s.\-/]/g, '')
        phoneUpdate = digits.startsWith('+') ? digits : (digits.length === 9 ? `+420${digits}` : `+${digits}`)
      } else {
        return res.status(400).json({ error: 'phone must be an E.164-ish number or null' })
      }
    }

    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      // Fetch current state for audit details (include dnt for idempotency)
      const { rows: [contactBefore] } = await client.query(
        `SELECT id, email, status, dnt, phone FROM contacts WHERE id=$1`, [req.params.id]
      )
      if (!contactBefore) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(404).json({ error: 'not found' })
      }

      const allowed = ['status', 'first_name', 'last_name', 'company_name']
      const sets = []
      const params = []
      let p = 1
      for (const key of allowed) {
        if (req.body[key] !== undefined) { sets.push(`${key}=$${p++}`); params.push(req.body[key]) }
      }
      // dnt is boolean — handled separately from string fields
      if (req.body.dnt !== undefined) {
        sets.push(`dnt=$${p++}`)
        params.push(req.body.dnt)
      }
      // phone — pre-validated/normalized above (string or null)
      if (phoneUpdate !== undefined) {
        sets.push(`phone=$${p++}`)
        params.push(phoneUpdate)
      }
      if (!sets.length) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(400).json({ error: 'nothing to update' })
      }
      params.push(req.params.id)
      const { rows } = await client.query(
        `UPDATE contacts SET ${sets.join(',')} WHERE id=$${p} RETURNING id,email,first_name,last_name,company_name,status,dnt,phone`,
        params
      )

      const emailRedacted = contactBefore.email
        ? `${contactBefore.email.split('@')[0][0]}***@${contactBefore.email.split('@')[1]}`
        : 'unknown'

      // Audit status change (suppress/unsuppress)
      if (req.body.status && req.body.status !== contactBefore.status) {
        const action = req.body.status === 'suppressed' ? 'contact_suppress' : 'contact_unsuppress'
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            action,
            'dashboard',
            'contact',
            String(req.params.id),
            JSON.stringify({
              email_redacted: emailRedacted,
              prev_status: contactBefore.status,
              new_status: req.body.status,
            }),
          ]
        )
      }

      // Audit dnt change — only when value actually changes
      if (req.body.dnt !== undefined && req.body.dnt !== contactBefore.dnt) {
        const dntAction = req.body.dnt ? 'contact_dnt_set' : 'contact_dnt_clear'
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            dntAction,
            'dashboard',
            'contact',
            String(req.params.id),
            JSON.stringify({
              email_redacted: emailRedacted,
              prev_dnt: contactBefore.dnt ?? false,
              new_dnt: req.body.dnt,
            }),
          ]
        )
      }

      // Audit phone change (#1581 M2.2) — only when the value actually changes.
      // The number itself is operator-visible business contact data, redacted in
      // the audit detail to a suffix (HARD RULE: no full PII in logs).
      if (phoneUpdate !== undefined && phoneUpdate !== (contactBefore.phone ?? null)) {
        const redact = (n) => (n ? `…${String(n).slice(-3)}` : null)
        await client.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            phoneUpdate ? 'contact_phone_set' : 'contact_phone_clear',
            'dashboard',
            'contact',
            String(req.params.id),
            JSON.stringify({
              email_redacted: emailRedacted,
              prev_phone_redacted: redact(contactBefore.phone),
              new_phone_redacted: redact(phoneUpdate),
            }),
          ]
        )
      }

      await client.query('COMMIT')
      client.release()
      res.json(rows[0])
    } catch (e) {
      if (client) {
        try { await client.query('ROLLBACK') } catch { }
        client.release()
      }
      capture500(res, e, safeError)
    }
  })

  app.post('/api/contacts/:id/verify-email', async (req, res) => {
    try {
      const { rows: [ct] } = await pool.query(
        `SELECT id, email FROM contacts WHERE id=$1`, [req.params.id]
      )
      if (!ct) return res.status(404).json({ error: 'not found' })
      if (!ct.email) {
        await pool.query(
          `UPDATE contacts SET email_status='no_email', email_verified_at=now() WHERE id=$1`,
          [ct.id]
        )
        return res.json({ status: 'no_email', detail: 'Kontakt nemá e-mail' })
      }

      // AP3 rate limit: max 5 verify_email per mailbox per hour.
      // Look up the probe mailbox by EMAIL_VERIFY_FROM; skip gracefully if none found.
      if (checkOpRateLimit) {
        const fromAddr = process.env.EMAIL_VERIFY_FROM || null
        const { rows: mbRows } = await pool.query(
          `SELECT id FROM outreach_mailboxes WHERE from_address=$1 LIMIT 1`, [fromAddr]
        )
        const mbId = mbRows[0]?.id
        if (mbId) {
          const rl = await checkOpRateLimit(pool, mbId, 'verify_email')
          if (!rl.allowed) {
            res.set('Retry-After', String(rl.retryAfterSec))
            return res.status(429).json({ error: 'rate_limit', op: 'verify_email', used: rl.used, max: rl.max, retryAfterSec: rl.retryAfterSec })
          }
        }
      }

      const last = domainProbeLock.get(ct.email.split('@')[1]?.toLowerCase() ?? '')
      if (last && Date.now() - last < DOMAIN_RATE_MS) {
        await new Promise(r => setTimeout(r, DOMAIN_RATE_MS - (Date.now() - last)))
      }
      domainProbeLock.set(ct.email.split('@')[1]?.toLowerCase() ?? '', Date.now())
      const result = await verifyEmail(ct.email, {
        enableSMTP: process.env.EMAIL_VERIFY_SMTP !== '0',
        domainCache,
        fromAddr: process.env.EMAIL_VERIFY_FROM || 'probe@example.com',
      })
      await pool.query(
        `UPDATE contacts
           SET email_status=$1, email_verified_at=now(), email_verification=$2, email_confidence=$3
         WHERE id=$4`,
        [result.status, JSON.stringify(result), result.confidence ?? null, ct.id]
      )
      res.json(result)
    } catch (e) { capture500(res, e, safeError) }
  })

  app.delete('/api/contacts/:id', async (req, res) => {
    let client
    try {
      client = await pool.connect()
      await client.query('BEGIN')

      // Fetch current state for audit details
      const { rows: [contactBefore] } = await client.query(
        `SELECT id, email, status FROM contacts WHERE id=$1`, [req.params.id]
      )
      if (!contactBefore) {
        await client.query('ROLLBACK')
        client.release()
        return res.status(404).json({ error: 'not found' })
      }

      const { rows } = await client.query('DELETE FROM contacts WHERE id=$1 RETURNING id', [req.params.id])

      // Audit the deletion
      const emailRedacted = contactBefore.email
        ? `${contactBefore.email.split('@')[0][0]}***@${contactBefore.email.split('@')[1]}`
        : 'unknown'
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'contact_delete',
          'dashboard',
          'contact',
          String(req.params.id),
          JSON.stringify({
            email_redacted: emailRedacted,
            deleted_at: new Date().toISOString(),
          }),
        ]
      )

      await client.query('COMMIT')
      client.release()
      res.json({ ok: true })
    } catch (e) {
      if (client) {
        try { await client.query('ROLLBACK') } catch { }
        client.release()
      }
      capture500(res, e, safeError)
    }
  })
}
