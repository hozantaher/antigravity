// Suppression route surface — GDPR/CAN-SPAM boundary CRUD for the
// outbound block list.
// ─────────────────────────────────────────────────────────────────────────────
// F3 (2026-05-03): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after companies.js D2.2 + scoring.js D2.5). Behavior is
// byte-equivalent to the inline declarations: same SQL, same response shape,
// same Sentry capture.
//
// UNION discipline (memory `project_two_suppression_tables` T1):
// reads MUST union both `outreach_suppressions` (Go-side SuppressEmail
// writes) and `suppression_list` (UI/BFF writes). Writes go to
// `suppression_list` only. Email normalization = lowercase + trim at
// every write boundary so case/whitespace variants collapse to one row.
//
// Routes covered (5 total):
//   GET    /api/suppression           — UNION ALL list, ORDER BY suppressed_at DESC, LIMIT 500
//   POST   /api/suppression           — singular upsert (legacy callers)
//   DELETE /api/suppression/:email    — ILIKE match removal
//   POST   /api/suppressions          — plural enum-validated, with audit fields
//   POST   /api/suppressions/domain   — AJ10a: global domain suppress (closes #1397)

const _SUPPRESSION_REASONS = new Set(['unsubscribe_reply', 'bounce_hard', 'manual'])

// ── AJ10a — global domain suppress thresholds (2026-05-15) ────────────────
//
// HARD RULE feedback_no_magic_thresholds (T0): named constants exposed so
// tests + operator docs can reference. Mirrors the SkipByDomainPanel
// constants in src/server-routes/campaigns.js but with the broader
// status_filter (`in_sequence` allowed) needed for the emergency
// global-scope path that motivated #1397 (tiscali.cz systemic bounce).

/** Domain validator — lowercase ASCII alphanumeric + dots + dashes,
 *  minimum 2-char TLD. Mirrors campaigns.js `DOMAIN_VALIDATE_RE`. */
export const GLOBAL_DOMAIN_SUPPRESS_DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/
/** Minimum reason length — audit-log discipline (matches unskip endpoint). */
export const GLOBAL_DOMAIN_SUPPRESS_REASON_MIN_LENGTH = 10
/** Top-N campaigns_affected breakdown in dry-run / commit response. */
export const GLOBAL_DOMAIN_SUPPRESS_TOP_CAMPAIGNS_LIMIT = 10
/** Statuses operator can flip → 'skipped' on the global path. Broader
 *  than per-campaign skip-by-domain because the emergency motivator
 *  (tiscali.cz incident 2026-05-15) needed to halt rows already in
 *  the multi-step sequence. Excludes `sent` / `replied` so send history
 *  is never lost. */
export const GLOBAL_DOMAIN_SUPPRESS_ALLOWED_STATUSES = new Set([
  'pending', 'in_flight', 'in_sequence',
])

/**
 * Mount the Suppression route surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountSuppressionRoutes(app, { pool, capture500, safeError }) {
  app.get('/api/suppression', async (req, res) => {
    try {
      // Union both suppression tables so ops sees the full picture (Go-side
      // SuppressEmail writes outreach_suppressions; UI/BFF writes
      // suppression_list). outreach_suppressions has no `suppressed_at` /
      // `contact_id` columns in this schema — fall back to NULL so the UI
      // renders the entry without those fields.
      const { rows } = await pool.query(
        `SELECT email, reason, suppressed_at, contact_id, 'manual' AS source
           FROM suppression_list
          WHERE email IS NOT NULL
         UNION ALL
         SELECT email, reason, NULL::timestamptz AS suppressed_at, NULL::int AS contact_id, 'auto' AS source
           FROM outreach_suppressions
          WHERE email IS NOT NULL
          ORDER BY suppressed_at DESC NULLS LAST
          LIMIT 500`
      )
      res.json(rows)
    } catch (e) { capture500(res, e, safeError) }
  })

  app.post('/api/suppression', async (req, res) => {
    try {
      const { email, reason } = req.body
      if (!email) return res.status(400).json({ error: 'email required' })
      await pool.query(
        `INSERT INTO suppression_list(email, reason) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET reason=$2, suppressed_at=now()`,
        [email.toLowerCase(), reason || 'manual']
      )
      res.json({ ok: true, email })
    } catch (e) { capture500(res, e, safeError) }
  })

  app.delete('/api/suppression/:email', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Redact email to first 2 chars + domain for audit details (memory feedback_no_pii_in_commands)
      const rawEmail = req.params.email
      const atIdx = rawEmail.indexOf('@')
      const redacted = atIdx > 0
        ? rawEmail.slice(0, Math.min(2, atIdx)) + '…@' + rawEmail.slice(atIdx + 1)
        : rawEmail.slice(0, 2) + '…'

      // H7 — match the literal address only. `req.params.email` is
      // attacker-influenced; a raw ILIKE pattern treats `%` / `_` as
      // wildcards, so `%@firma.cz` (or a stray `_`) would DELETE *other*
      // recipients' opt-out rows → silent un-suppress → GDPR red line
      // (they start receiving mail again). Escape the LIKE metacharacters
      // (`\`, `%`, `_`) and add ESCAPE so ILIKE keeps its case-insensitive
      // contract while losing the wildcard blast radius. RETURNING lets the
      // audit record the rows ACTUALLY removed (not a count of the match
      // pattern).
      const likeParam = rawEmail.replace(/([\\%_])/g, '\\$1')
      const del = await client.query(
        `DELETE FROM suppression_list WHERE email ILIKE $1 ESCAPE '\\' RETURNING email`,
        [likeParam]
      )
      const removed = del.rowCount ?? del.rows.length

      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('suppression_remove', 'dashboard', 'suppression', $1, $2::jsonb)`,
        // entity_id holds the REDACTED address, not the raw param — storing the
        // raw email here defeated the redaction effort applied to `details`.
        [redacted, JSON.stringify({ email_redacted: redacted, removed_count: removed })]
      )

      await client.query('COMMIT')
      res.json({ ok: true })
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* ignored */ }
      capture500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // ── KT-A13 — POST /api/suppressions (plural) ──────────────────────
  // New endpoint introduced for ThreadDetail Unsubscribe action. Differs
  // from /api/suppression (singular):
  //   - reason is enum-validated (unsubscribe_reply / bounce_hard / manual)
  //   - accepts campaign_id + source for audit trail (which UI surface
  //     triggered the suppression — thread_detail / dashboard / cli / etc.)
  //   - INSERT ... ON CONFLICT DO UPDATE keeps it idempotent (operator can
  //     click Unsubscribe twice without an error).
  //
  // We keep /api/suppression in place so existing callers don't break.
  app.post('/api/suppressions', async (req, res) => {
    try {
      const { email, reason, campaign_id, source } = req.body || {}
      if (!email || typeof email !== 'string' || !email.trim()) {
        return res.status(400).json({ error: 'email required' })
      }
      if (!reason || !_SUPPRESSION_REASONS.has(reason)) {
        return res.status(400).json({
          error: 'invalid reason',
          allowed: Array.from(_SUPPRESSION_REASONS),
        })
      }
      const normalized = email.toLowerCase().trim()
      const cid = campaign_id == null ? null : Number(campaign_id)
      const src = (typeof source === 'string' && source) ? source : 'manual'
      await pool.query(
        `INSERT INTO suppression_list(email, reason, campaign_id, source)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(email) DO UPDATE SET
           reason = EXCLUDED.reason,
           campaign_id = COALESCE(EXCLUDED.campaign_id, suppression_list.campaign_id),
           source = EXCLUDED.source,
           suppressed_at = now()`,
        [normalized, reason, cid, src],
      )
      res.json({ ok: true, email: normalized })
    } catch (e) { capture500(res, e, safeError) }
  })

  // ── AJ10a — POST /api/suppressions/domain (closes #1397) ──────────────
  //
  // Global domain suppress. Tonight (2026-05-15) the operator hit a
  // tiscali.cz systemic bounce (40% of 24h bounces, 5275 contacts in DB)
  // and had to drop to psql to:
  //   1. INSERT INTO outreach_suppressions (domain, reason) VALUES (...);
  //   2. UPDATE campaign_contacts SET status='skipped' WHERE contact_id
  //      IN (... LIKE '%@tiscali.cz') AND status IN ('pending',
  //      'in_flight', 'in_sequence') across all campaigns;
  //   3. INSERT INTO operator_audit_log (...).
  //
  // This endpoint closes the psql-fallback gap. The per-campaign skip
  // path (POST /api/campaigns/:id/skip-by-domains) is preserved for the
  // narrower case; this is the cross-campaign emergency action.
  //
  // HARD RULES enforced:
  //   - feedback_audit_log_on_mutations (T0): audit row INSERTed in the
  //     same tx as the suppression + skip cascade.
  //   - feedback_no_magic_thresholds (T0): all thresholds come from
  //     exported named constants above.
  //   - feedback_schema_verify_before_sql (T0): outreach_suppressions
  //     (domain, reason) columns from migration 063; campaign_contacts
  //     (status, details, updated_at) from migrations 034 + 049 + 092;
  //     contacts.email from migration 030; operator_audit_log columns
  //     from migration 044.
  //   - feedback_no_pii_in_commands (T0): response carries counts +
  //     per-campaign breakdown only, never affected email addresses.
  //   - feedback_campaign_send (T0): X-Confirm-Send header + confirm=true
  //     required on the mutation path. (Suppression is destructive — it
  //     halts in-flight sequences across every campaign touching that
  //     domain.)
  //
  // Request body (JSON):
  //   {
  //     "domain": "tiscali.cz",
  //     "reason": "tiscali_systemic_bounce_2026-05-15",
  //     "confirm": true            // required on mutation path
  //   }
  // Header: X-Confirm-Send: yes    // required on mutation path
  //
  // Query param:
  //   ?dry_run=true                // preview impact, no writes
  //
  // Response (200 OK):
  //   { ok, dry_run, domain, reason, suppression_id, contacts_skipped,
  //     campaigns_affected: [{campaign_id, count}], audit_log_id,
  //     already_suppressed, requested_at }
  app.post('/api/suppressions/domain', async (req, res) => {
    try {
      const dryRun = req.query.dry_run === 'true' || req.query.dry_run === '1'
      const body = req.body || {}

      // ── Validate domain ──────────────────────────────────────────────
      const rawDomain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : ''
      if (!rawDomain) {
        return res.status(400).json({ error: 'domain must be a non-empty string' })
      }
      if (!GLOBAL_DOMAIN_SUPPRESS_DOMAIN_RE.test(rawDomain)) {
        return res.status(400).json({
          error: 'invalid_domain',
          message: `invalid domain syntax: ${rawDomain}`,
        })
      }

      // ── Validate reason ──────────────────────────────────────────────
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (!reason) {
        return res.status(400).json({ error: 'reason must be a non-empty string' })
      }
      if (reason.length < GLOBAL_DOMAIN_SUPPRESS_REASON_MIN_LENGTH) {
        return res.status(400).json({
          error: 'reason_too_short',
          message: `reason must be at least ${GLOBAL_DOMAIN_SUPPRESS_REASON_MIN_LENGTH} chars (audit-log discipline), got ${reason.length}`,
        })
      }

      // ── Mutation-path guards (confirm flag + header) ─────────────────
      if (!dryRun) {
        if (body.confirm !== true) {
          return res.status(400).json({ error: 'confirm must be true' })
        }
        if (req.headers['x-confirm-send'] !== 'yes') {
          return res.status(412).json({
            error: 'missing_confirm_header',
            message: 'X-Confirm-Send: yes header required for mutation path',
          })
        }
      }

      const statusFilter = [...GLOBAL_DOMAIN_SUPPRESS_ALLOWED_STATUSES]
      const emailPattern = `%@${rawDomain}`

      // ── Dry-run: count impact without writing ────────────────────────
      if (dryRun) {
        const { rows: breakdown } = await pool.query(
          `SELECT cc.campaign_id AS campaign_id,
                  COUNT(*)::int AS count
             FROM campaign_contacts cc
             JOIN contacts c ON c.id = cc.contact_id
            WHERE cc.status = ANY($1::text[])
              AND c.email ILIKE $2
            GROUP BY cc.campaign_id
            ORDER BY count DESC`,
          [statusFilter, emailPattern],
        )
        const totalSkipped = breakdown.reduce((acc, r) => acc + (r.count ?? 0), 0)
        // Check if domain already suppressed so the UI can label the row.
        const { rows: existing } = await pool.query(
          `SELECT id FROM outreach_suppressions WHERE domain=$1 LIMIT 1`,
          [rawDomain],
        )
        return res.json({
          ok: true,
          dry_run: true,
          domain: rawDomain,
          reason,
          suppression_id: existing[0]?.id ?? null,
          already_suppressed: existing.length > 0,
          contacts_skipped: totalSkipped,
          campaigns_affected: breakdown.slice(0, GLOBAL_DOMAIN_SUPPRESS_TOP_CAMPAIGNS_LIMIT),
          audit_log_id: null,
          requested_at: new Date().toISOString(),
        })
      }

      // ── Commit path: insert suppression + cascade skip + audit, all
      //    in one transaction. ─────────────────────────────────────────
      const operator =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator_global_domain_suppress_ui'

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // 1) Insert (or fetch existing) suppression row by domain.
        //    No unique constraint exists on outreach_suppressions(domain)
        //    in migration 063, so ON CONFLICT (domain) wouldn't compile
        //    cleanly. We instead probe + insert. Worst case (race) is a
        //    duplicate row, which is benign for the read-side UNION.
        let suppressionId = null
        const { rows: existing } = await client.query(
          `SELECT id FROM outreach_suppressions WHERE domain=$1 LIMIT 1`,
          [rawDomain],
        )
        if (existing.length > 0) {
          suppressionId = existing[0].id
        } else {
          const { rows: inserted } = await client.query(
            `INSERT INTO outreach_suppressions (domain, reason)
             VALUES ($1, $2)
             RETURNING id`,
            [rawDomain, reason],
          )
          suppressionId = inserted[0].id
        }

        // 2) Skip cascade across all campaigns. RETURNING gives per-row
        //    campaign_id so we can build the breakdown + audit without
        //    surfacing PII.
        const { rows: affected } = await client.query(
          `UPDATE campaign_contacts cc
             SET status='skipped',
                 next_send_at=NULL,
                 details = COALESCE(cc.details, '{}'::jsonb)
                           || jsonb_build_object(
                                'skip_reason', 'global_domain_suppress',
                                'skip_subreason', $3::text,
                                'skip_domain', $1::text,
                                'skipped_at', to_jsonb(NOW()),
                                'skipped_by', 'operator_global_domain_suppress_ui'
                              ),
                 updated_at = NOW()
            FROM contacts c
            WHERE cc.contact_id = c.id
              AND cc.status = ANY($2::text[])
              AND c.email ILIKE $4
            RETURNING cc.id, cc.campaign_id`,
          [rawDomain, statusFilter, reason, emailPattern],
        )

        // 3) Audit row — single INSERT with details payload covering the
        //    impact summary (counts only, no PII). Returns the audit
        //    log id so the UI / smoke test can confirm emit.
        const counts = new Map()
        for (const r of affected) {
          counts.set(r.campaign_id, (counts.get(r.campaign_id) || 0) + 1)
        }
        const campaignsAffected = [...counts.entries()]
          .map(([campaign_id, count]) => ({ campaign_id, count }))
          .sort((a, b) => b.count - a.count)

        const { rows: auditRows } = await client.query(
          `INSERT INTO operator_audit_log
             (action, actor, entity_type, entity_id, details, created_at)
           VALUES ('domain_suppress_global', $1, 'domain', $2,
                   $3::jsonb, NOW())
           RETURNING id`,
          [
            operator,
            suppressionId,
            JSON.stringify({
              domain: rawDomain,
              reason,
              suppression_id: suppressionId,
              already_suppressed: existing.length > 0,
              contacts_skipped: affected.length,
              campaigns_affected: campaignsAffected,
            }),
          ],
        )

        await client.query('COMMIT')

        return res.json({
          ok: true,
          dry_run: false,
          domain: rawDomain,
          reason,
          suppression_id: suppressionId,
          already_suppressed: existing.length > 0,
          contacts_skipped: affected.length,
          campaigns_affected: campaignsAffected.slice(
            0, GLOBAL_DOMAIN_SUPPRESS_TOP_CAMPAIGNS_LIMIT,
          ),
          audit_log_id: auditRows[0]?.id ?? null,
          requested_at: new Date().toISOString(),
        })
      } catch (e) {
        try { await client.query('ROLLBACK') } catch { /* ignored */ }
        throw e
      } finally {
        client.release()
      }
    } catch (e) { capture500(res, e, safeError) }
  })
}

// Exposed for tests that want to assert the closed enum without reaching
// into module internals. Production code never imports this.
const _SUPPRESSION_REASONS_FOR_TESTS = _SUPPRESSION_REASONS
