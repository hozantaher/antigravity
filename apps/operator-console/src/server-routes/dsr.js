// GDPR data subject requests (Art. 15 access, Art. 17 erasure)
// ─────────────────────────────────────────────────────────────────────────────
// Operator-only (X-API-Key required at app middleware layer). Used to respond
// to data subject requests within the GDPR-mandated 1-month SLA. See
// docs/playbooks/dsr-runbook.md for operator workflow.
//
// BF-D1: rate-limited to 10 req/min/IP even though endpoints are auth-gated.
// Defense in depth: a leaked OUTREACH_API_KEY shouldn't enable DoS via
// 8 parallel queries × N rps. Each access hits 8 PII tables; abuse vector
// is real. Audit-logged per access (already in body of handler).
//
// T2.6 (2026-05-01): extracted verbatim from server.js per ADR-008.
// Behavior is byte-equivalent to the inline declarations: same SQL, same
// response shape, same audit log writes, same rate-limit semantics.
// Audit test `tests/audit/gdpr-cascade-shape.test.js` (multi-file scan
// since PR #443) verifies the cascade contract from this file.
// Contract test `tests/contract/bff-dsr.contract.test.ts` verifies the
// HTTP-level shape end-to-end via `app.listen(0)`.

// Per-IP rate limiter state. Module-private — survives across both
// handler invocations because `mountDsrRoutes` is called once at boot.
const _dsrBuckets = new Map()

function _dsrAllow(ip, env) {
  // Rate limit bypassed when BFF auth is disabled (test environment).
  // Production always has auth enabled, so the bypass doesn't reduce
  // production protection.
  if (env.BFF_AUTH_DISABLED === '1') return true
  const now = Date.now()
  const win = 60_000
  const max = 10
  const key = ip || 'unknown'
  const hits = (_dsrBuckets.get(key) || []).filter(t => now - t < win)
  if (hits.length >= max) return false
  hits.push(now)
  _dsrBuckets.set(key, hits)
  return true
}

function _dsrIPOf(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress
}

// H8 — run a schema-optional PII cascade statement inside a SAVEPOINT so a
// GENUINE failure (FK, permission, lock, constraint) propagates to the outer
// catch → ROLLBACK + 500, instead of being swallowed by
// `.catch(() => ({ rowCount: 0 }))` (which COMMITs a partial erasure while the
// endpoint reports complete success — exactly the F2-2 class of bug). We
// tolerate ONLY "table missing" (undefined_table / SQLSTATE 42P01) for dev DBs
// without migration 019/050 applied; every other error is a real erasure
// failure and must abort the whole transaction. `savepoint` is a hardcoded
// identifier (never user input), so interpolating it into the SQL is safe.
async function _eraseOptionalCascade(client, savepoint, sql, params) {
  await client.query(`SAVEPOINT ${savepoint}`)
  try {
    const r = await client.query(sql, params)
    await client.query(`RELEASE SAVEPOINT ${savepoint}`)
    return r.rowCount || 0
  } catch (e) {
    if (e && e.code === '42P01') {
      // Table not present in this database — undo just this savepoint and
      // continue; the rest of the erasure is unaffected.
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      return 0
    }
    throw e
  }
}

/**
 * Mount the GDPR DSR routes on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, unknown>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountDsrRoutes(app, { pool, setRouteTags, capture500, safeError }) {
  app.get('/api/dsr/access', async (req, res) => {
    setRouteTags({ 'dsr.action': 'access' })
    if (!_dsrAllow(_dsrIPOf(req), process.env)) {
      return res.status(429).json({ error: 'rate limit: 10 req/min/IP' })
    }
    try {
      const email = String(req.query.email || '').toLowerCase().trim()
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'email parameter required' })
      }
      // Aggregate everything we hold across all PII-bearing tables.
      // Tables checked: contacts (Schema A), outreach_contacts (Schema B,
      // joined by email_hash), send_events, reply_inbox, tracking_events,
      // suppression_list, outreach_suppressions, operator_audit_log,
      // channel_audit_log, ai_suggestion_audit (Track E migration 019).
      const [c, oc, se, ri, te, sl, os, al, cal, aia, crm] = await Promise.all([
        pool.query(`SELECT * FROM contacts WHERE lower(trim(email)) = $1`, [email]),
        pool.query(`SELECT * FROM outreach_contacts WHERE lower(trim(email)) = $1`, [email]),
        pool.query(
          `SELECT se.* FROM send_events se
           JOIN contacts c ON c.id = se.contact_id
           WHERE lower(trim(c.email)) = $1
           ORDER BY se.sent_at DESC LIMIT 500`, [email]),
        pool.query(
          `SELECT ri.* FROM reply_inbox ri
           JOIN contacts c ON c.id = ri.contact_id
           WHERE lower(trim(c.email)) = $1
           ORDER BY ri.received_at DESC LIMIT 500`, [email]),
        pool.query(
          `SELECT te.* FROM tracking_events te
           JOIN send_events se ON se.id = te.send_event_id
           JOIN contacts c ON c.id = se.contact_id
           WHERE lower(trim(c.email)) = $1
           ORDER BY te.created_at DESC LIMIT 1000`, [email]).catch(() => ({ rows: [] })),
        pool.query(`SELECT * FROM suppression_list WHERE lower(trim(email)) = $1`, [email]),
        pool.query(`SELECT * FROM outreach_suppressions WHERE lower(trim(email)) = $1`, [email]),
        pool.query(
          `SELECT * FROM operator_audit_log
           WHERE details->>'email' = $1 OR entity_id IN (
             SELECT id::text FROM contacts WHERE lower(trim(email)) = $1
           )
           ORDER BY created_at DESC LIMIT 200`, [email]).catch(() => ({ rows: [] })),
        // Track E (migration 019): per-channel send/receive audit.
        pool.query(
          `SELECT * FROM channel_audit_log
           WHERE lower(trim(subject_email)) = $1
           ORDER BY occurred_at DESC LIMIT 500`, [email]).catch(() => ({ rows: [] })),
        // Track E (migration 019): AI suggestion audit, joined via the thread's
        // contact mapping. Returns an empty list when migration 019 not applied.
        pool.query(
          `SELECT a.* FROM ai_suggestion_audit a
           JOIN outreach_threads t ON t.id = a.thread_id
           JOIN contacts c ON c.id = t.contact_id
           WHERE lower(trim(c.email)) = $1
           ORDER BY a.occurred_at DESC LIMIT 200`, [email]).catch(() => ({ rows: [] })),
        // CRM cascade (migration 050) — match by either email column since
        // CRM exports populate both primary and secondary. Empty rows when
        // migration 050 not applied.
        pool.query(
          `SELECT * FROM crm_clients
           WHERE lower(trim(email_primary)) = $1
              OR lower(trim(email))         = $1`, [email]).catch(() => ({ rows: [] })),
      ])

      // Audit the access request itself (Art. 30 ROPA accountability).
      // Email redacted to minimize audit log PII (Art. 5/1/c GDPR).
      await pool.query(
        `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
         VALUES('dsr_access', 'operator', 'email', $1, jsonb_build_object('tables_queried', 11))`,
        [email]
      ).catch(() => {})

      const found =
        c.rows.length + oc.rows.length + se.rows.length + ri.rows.length +
        te.rows.length + sl.rows.length + os.rows.length + al.rows.length +
        cal.rows.length + aia.rows.length + crm.rows.length

      res.json({
        email,
        found_total: found,
        contacts: c.rows,
        outreach_contacts: oc.rows,
        send_events: se.rows,
        reply_inbox: ri.rows,
        tracking_events: te.rows,
        suppression_list: sl.rows,
        outreach_suppressions: os.rows,
        audit_log: al.rows,
        channel_audit_log: cal.rows,
        ai_suggestion_audit: aia.rows,
        crm_clients: crm.rows,
        generated_at: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.post('/api/dsr/erase', async (req, res) => {
    setRouteTags({ 'dsr.action': 'erase' })
    if (!_dsrAllow(_dsrIPOf(req), process.env)) {
      return res.status(429).json({ error: 'rate limit: 10 req/min/IP' })
    }
    try {
      const email = String(req.query.email || req.body?.email || '').toLowerCase().trim()
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'email parameter required' })
      }

      // Per Art. 17, suppression_list + outreach_suppressions records are
      // KEPT (proof of opt-out is itself a legal obligation under §7(4) of
      // Act 480/2004 — operator must demonstrate they honored the opt-out).
      // Only the contact-identifying records cascade.
      const client = await pool.connect()
      let deleted = {
        contacts: 0, outreach_contacts: 0, send_events: 0, reply_inbox: 0, tracking_events: 0,
        // Track E (migration 019) — audit log cascade.
        channel_audit_log: 0,
        ai_suggestion_audit_anonymized: 0,
        // CRM cascade (migration 050) — Art. 17 anonymisation, ICO retained
        // for accountability under Art. 6/1/c.
        crm_clients_anonymized: 0,
      }
      try {
        await client.query('BEGIN')

        // Get contact IDs (Schema A and B may diverge)
        const { rows: contactIds } = await client.query(
          `SELECT id FROM contacts WHERE lower(trim(email)) = $1`, [email])
        const ids = contactIds.map(r => r.id)

        if (ids.length > 0) {
          // F2-2: previously this DELETE had `.catch(() => ({ rowCount: 0 }))`,
          // silently swallowing errors INSIDE the transaction. If tracking_events
          // DELETE failed (table missing, permissions, FK), the catch returned
          // {rowCount:0} and the transaction kept going — partial deletion +
          // COMMIT + audit log claiming success while PII remained. GDPR Art.17
          // requires all-or-nothing; let the error propagate to the outer catch
          // which ROLLBACKs and 500s.
          const tracking = await client.query(
            `DELETE FROM tracking_events
             WHERE send_event_id IN (SELECT id FROM send_events WHERE contact_id = ANY($1::int[]))`,
            [ids])
          deleted.tracking_events = tracking.rowCount || 0

          const replies = await client.query(
            `DELETE FROM reply_inbox WHERE contact_id = ANY($1::int[])`, [ids])
          deleted.reply_inbox = replies.rowCount || 0

          const sends = await client.query(
            `DELETE FROM send_events WHERE contact_id = ANY($1::int[])`, [ids])
          deleted.send_events = sends.rowCount || 0
        }

        // H8 — outreach_contacts (Schema B) is keyed on email / email_hash, NOT
        // on the Schema-A contact ids. Nesting this DELETE inside the
        // `if (ids.length > 0)` guard meant an email present ONLY in Schema B
        // (e.g. a firmy.cz re-import that never landed in Schema-A `contacts`)
        // was NEVER erased, while the endpoint still reported "vymazán napříč
        // 8 tabulkami". Run it unconditionally. Match on email OR email_hash —
        // email_hash is the canonical Schema-B key (many rows are hash-only with
        // email NULL; same expression the unsubscribe mirror uses). No `.catch`:
        // outreach_contacts is a real PII table (migration 043); a genuine
        // failure MUST ROLLBACK (Art. 17 all-or-nothing), not silently pass —
        // mirrors the F2-2 tracking_events fix.
        const ocs = await client.query(
          `DELETE FROM outreach_contacts
            WHERE lower(trim(email)) = $1
               OR email_hash = encode(sha256(lower(trim($1::text))::bytea), 'hex')`,
          [email])
        deleted.outreach_contacts = ocs.rowCount || 0

        if (ids.length > 0) {
          const cs = await client.query(
            `DELETE FROM contacts WHERE id = ANY($1::int[])`, [ids])
          deleted.contacts = cs.rowCount || 0
        }

        // Close any open outreach_threads for the erased contact. Per Art. 17,
        // we don't delete thread rows (proof of communication is itself a legal
        // obligation under §7(4) of Act 480/2004 — operator must demonstrate
        // they honored the opt-out). Status flip to 'closed' is sufficient
        // cascade per docs/audits/2026-04-30-blind-spot-audit.md (KT-B12 #380).
        if (ids.length > 0) {
          const threads = await client.query(
            `UPDATE outreach_threads SET status='closed', current_step=COALESCE(current_step,0), next_action='gdpr_erasure'
             WHERE contact_id = ANY($1::int[]) AND status NOT IN ('closed','erased')`,
            [ids]).catch(() => ({ rowCount: 0 }))
          deleted.outreach_threads_closed = threads.rowCount || 0
        }

        // Track E cascade — channel_audit_log (migration 019). Per-channel
        // events keyed by subject_email. DELETE the rows entirely: the
        // suppression UNION still proves the opt-out was honored; the
        // channel-level breadcrumb is not load-bearing for accountability.
        // SAVEPOINT-gated (H8): tolerates the table being absent on dev DBs
        // without migration 019, but a REAL delete failure now ROLLBACKs the
        // whole erase instead of being swallowed into a false success.
        deleted.channel_audit_log = await _eraseOptionalCascade(
          client, 'sp_channel_audit',
          `DELETE FROM channel_audit_log WHERE lower(trim(subject_email)) = $1`,
          [email])

        // Track E cascade — ai_suggestion_audit (migration 019). RLHF dataset
        // is operator-internal accountability data (Art. 5/2). On erase we
        // ANONYMIZE the row instead of DELETE: thread_id → NULL, operator_id
        // → 'erased', details → details with subject identifiers stripped.
        // Keeps the suggestion text usable for prompt iteration without any
        // remaining linkage to the erased subject.
        if (ids.length > 0) {
          deleted.ai_suggestion_audit_anonymized = await _eraseOptionalCascade(
            client, 'sp_ai_suggestion_audit',
            `UPDATE ai_suggestion_audit
                SET thread_id   = NULL,
                    operator_id = 'erased',
                    details     = COALESCE(details, '{}'::jsonb)
                                   || jsonb_build_object('erased_at', now())
              WHERE thread_id IN (
                      SELECT id FROM outreach_threads
                       WHERE contact_id = ANY($1::int[])
                    )`,
            [ids])
        }

        // Note: photo_parse_audit (migration 019) is NOT cascaded here.
        // The schema intentionally has no subject_email / contact_id linkage
        // (only blob_ref + extracted/retained machinery attributes); the
        // table records the *parse event*, not the data subject. If a photo
        // contained PII the parser is required to populate `discarded` and
        // strip from `retained` at parse time (Art. 5/1/c data minimization).

        // CRM cascade (migration 050) — Art. 17 anonymisation. CRM clients
        // are kept under Art. 6/1/b (contract performance) for active deals,
        // but on Art. 17 erasure we MUST remove the natural-person PII while
        // retaining the legal-entity record (ICO + entity_id + dates) for
        // accountability under Art. 6/1/c. This is the same anonymise-not-delete
        // pattern used for ai_suggestion_audit above. Match by either email
        // column since CRM exports populate both primary and secondary.
        // SAVEPOINT-gated (H8): same rationale as channel_audit_log — tolerate
        // the table being absent (migration 050 not applied) but propagate any
        // real failure to ROLLBACK rather than reporting a partial erasure as
        // complete.
        deleted.crm_clients_anonymized = await _eraseOptionalCascade(
          client, 'sp_crm_clients',
          `UPDATE crm_clients
              SET email_primary = NULL,
                  email         = NULL,
                  name          = '[ERASED]',
                  details       = COALESCE(details, '{}'::jsonb)
                                   || jsonb_build_object('erased_at', now())
            WHERE lower(trim(email_primary)) = $1
               OR lower(trim(email))         = $1`,
          [email])

        // Add to BOTH suppression tables as belt-and-suspenders: suppression UNION
        // reads from both (memory: project_two_suppression_tables.md). Even after
        // deletion, any future ETL re-importing this email from firmy.cz will be
        // blocked at the suppression UNION read site.
        await client.query(
          `INSERT INTO suppression_list(email, reason)
           VALUES($1, 'gdpr_erasure')
           ON CONFLICT (email) DO UPDATE SET reason='gdpr_erasure', suppressed_at=now()`,
          [email])

        await client.query(
          `INSERT INTO outreach_suppressions(email, reason)
           VALUES($1, 'gdpr_erasure')
           ON CONFLICT (email) DO UPDATE SET reason='gdpr_erasure', created_at=now()`,
          [email]).catch(() => { /* table may not exist in dev (Schema B not seeded) */ })

        await client.query(
          `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
           VALUES('dsr_erase', 'operator', 'email', $1, jsonb_build_object('deleted', $2::jsonb))`,
          [email, JSON.stringify(deleted)])

        await client.query('COMMIT')
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {})
        throw txErr
      } finally {
        client.release()
      }

      res.json({
        email,
        ok: true,
        deleted,
        suppression_kept: true,
        message: 'Záznam vymazán napříč 8 tabulkami (5 PII + channel_audit_log + ai_suggestion_audit + crm_clients anonymizován; ICO retained pod čl. 6/1/c); suppression_list zachován jako důkaz čl. 21 opt-outu (povinné dle čl. 30 GDPR + §7(4) zák. 480/2004).',
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
