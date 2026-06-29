/**
 * runImapInboxAuditCron — detect IMAP INBOX vs ingested-row gap (2026-05-18).
 *
 * Background
 * ──────────
 * 2026-05-18 incident: IMAP poll's `parkUnattributed` path was silently
 * swallowing INSERTs into `unmatched_inbound` because the `notify_reply`
 * trigger had a JSONB-cast bug. Operator had no automated signal until
 * manual investigation revealed 217 unseen INBOX messages vs 3 ingested
 * rows. This cron closes that observability gap.
 *
 * What it does
 * ────────────
 * Every interval (default 1h), for every active production mailbox:
 *   1. Calls relay `POST /v1/imap-fetch` with `limit=1` (cheap probe —
 *      relay returns `unseen_total` from IMAP SELECT).
 *   2. Counts rows in `reply_inbox` for this mailbox received in the last
 *      24h. (unmatched_inbound has no mailbox_id FK so per-mailbox split
 *      is not possible; the per-mailbox reply_inbox count is the signal.)
 *   3. If `unseen_total > ingested_count + threshold` → INSERT
 *      `mailbox_alerts` row (operator-visible notification surface),
 *      plus an `operator_audit_log` row in the same call sequence.
 *
 * HARD rule compliance
 * ────────────────────
 * - `feedback_schema_verify_before_sql` (T0): all columns verified —
 *   outreach_mailboxes(id, from_address, status, environment, imap_host,
 *   imap_port, imap_username, smtp_username, password, preferred_country),
 *   reply_inbox(mailbox_id, received_at),
 *   mailbox_alerts(mailbox_id, type, severity, message),
 *   operator_audit_log(action, actor, entity_type, entity_id, details).
 * - `feedback_audit_log_on_mutations` (T0): every `mailbox_alerts` INSERT
 *   emits an `operator_audit_log` row in the same iteration.
 * - `feedback_no_magic_thresholds` (T0): gap threshold + enabled flag read
 *   from `operator_settings` (keys `imap_inbox_audit_gap_threshold` +
 *   `imap_inbox_audit_enabled`). Defaults live in `thresholdDefaults.js`.
 * - `feedback_external_io_backoff` (T0): relay fetch already wraps a
 *   120s timeout via `relayImapFetch`. We bound concurrency per-call by
 *   running mailboxes sequentially (one fetch at a time) so a slow IMAP
 *   server can't DoS its peers; on transient errors we skip the mailbox
 *   and move on (no naked retry storm).
 * - `feedback_no_pii_in_commands` (T0): credentials read from DB rows,
 *   never inline strings; mailbox_address redacted in console logs.
 *
 * Module exports a deps-injected entry point so tests can mock the relay
 * fetch + pool without touching real IMAP.
 *
 * @param {pg.Pool} pool
 * @param {object} deps
 * @param {Function} deps.relayImapFetch — async (pool, params) → fetch result
 * @param {object}   [deps.Sentry]       — optional Sentry instance
 */

// Default fallbacks (kept identical to thresholdDefaults.js — see those
// keys for the canonical specs). DB row wins; these only apply when the
// row is missing or unparseable.
export const DEFAULT_GAP_THRESHOLD = 10
export const DEFAULT_ENABLED = true

/**
 * Decide whether a (unseen, ingested) pair crosses the gap threshold.
 *
 * Pure function so the unit test can pin the inequality semantics — the
 * gap is `unseen - ingested`; an alert fires only when `gap > threshold`
 * (strict, so threshold=10 means 11+ message gap fires).
 *
 * @param {object} input
 * @param {number} input.unseenTotal     — Server-side IMAP UNSEEN count
 * @param {number} input.ingestedCount   — rows we have in reply_inbox(24h)
 * @param {number} input.threshold       — operator-tunable threshold
 * @returns {{ hasGap: boolean, gap: number }}
 */
export function computeGap({ unseenTotal, ingestedCount, threshold }) {
  const u = Number.isFinite(unseenTotal) ? Number(unseenTotal) : 0
  const i = Number.isFinite(ingestedCount) ? Number(ingestedCount) : 0
  const t = Number.isFinite(threshold) ? Number(threshold) : DEFAULT_GAP_THRESHOLD
  const gap = u - i
  return { hasGap: gap > t, gap }
}

/**
 * Read a key from operator_settings, coercing the raw string into the
 * requested type. Returns the fallback on missing row / parse error.
 *
 * Inline (rather than reused) because the cron must be importable in
 * tests without pulling the full settings UI dependency tree. The DB
 * shape is stable enough that the duplication is acceptable.
 *
 * @param {pg.Pool} pool
 * @param {string} key
 * @param {('int'|'boolean')} type
 * @param {number|boolean} fallback
 */
async function readOperatorSetting(pool, key, type, fallback) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM operator_settings WHERE key = $1 LIMIT 1`,
      [key],
    )
    const raw = rows?.[0]?.value
    if (raw == null || raw === '') return fallback
    if (type === 'int') {
      const n = Number.parseInt(String(raw), 10)
      return Number.isFinite(n) ? n : fallback
    }
    if (type === 'boolean') {
      const s = String(raw).toLowerCase().trim()
      if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
      if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
      return fallback
    }
    return fallback
  } catch {
    // operator_settings may be missing in dev — fall back silently.
    return fallback
  }
}

/**
 * Emit a single operator notification + audit log entry. Both writes go
 * into best-effort .catch() blocks so a failing audit doesn't suppress
 * the user-visible alert (and vice versa).
 *
 * Notification surface = `mailbox_alerts` (the existing operator-visible
 * row stream, already wired into the dashboard's alerts feed). Type =
 * `imap_inbox_gap` so the UI can filter / group.
 *
 * @param {pg.Pool} pool
 * @param {object} params
 * @param {number} params.mailboxId
 * @param {string} params.mailboxAddress  — redacted-prefix only, used in message text
 * @param {number} params.unseen
 * @param {number} params.ingested
 * @param {number} params.gap
 * @param {number} params.threshold
 */
export async function emitGapNotification(pool, { mailboxId, mailboxAddress, unseen, ingested, gap, threshold }) {
  // Redact the mailbox local-part for the human-readable message — PII
  // policy bans inline mailbox addresses in logs/notifications. Keep
  // only the domain so operators can still identify the provider.
  const at = String(mailboxAddress || '').indexOf('@')
  const redactedAddr = at > 0
    ? `***@${String(mailboxAddress).slice(at + 1)}`
    : '<mailbox>'
  const message =
    `IMAP inbox gap detected for ${redactedAddr} (mailbox #${mailboxId}): ` +
    `unseen=${unseen}, ingested(24h)=${ingested}, gap=${gap} > threshold=${threshold}. ` +
    `Likely cause: ingestion trigger / parser silently dropping rows.`

  await pool.query(
    `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message, created_at)
     VALUES ($1, 'imap_inbox_gap', 'warn', $2, now())`,
    [mailboxId, message],
  ).catch((e) => {
    console.warn(`[imap-inbox-audit] mailbox_alerts INSERT failed mailbox=${mailboxId}:`, e?.message)
  })

  // HARD rule feedback_audit_log_on_mutations — every operator-visible
  // mutation emits an operator_audit_log row in the same call. Details
  // JSONB carries the structured payload for forensic replay.
  await pool.query(
    `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details, created_at)
     VALUES ('imap_inbox_gap_detected', 'cron:runImapInboxAuditCron', 'mailbox', $1, $2::jsonb, now())`,
    [
      String(mailboxId),
      JSON.stringify({
        unseen,
        ingested,
        gap,
        threshold,
        mailbox_address_domain: at > 0 ? String(mailboxAddress).slice(at + 1) : null,
      }),
    ],
  ).catch((e) => {
    console.warn(`[imap-inbox-audit] operator_audit_log INSERT failed mailbox=${mailboxId}:`, e?.message)
  })
}

/**
 * Main cron entry. Returns a summary object so callers (tests, optional
 * /api admin endpoints) can inspect what happened.
 *
 * @param {pg.Pool} pool
 * @param {object} deps
 * @param {Function} deps.relayImapFetch
 * @param {object} [deps.Sentry]
 * @returns {Promise<{scanned: number, gapped: number, skipped: number, enabled: boolean}>}
 */
export async function runImapInboxAuditCron(pool, { relayImapFetch, Sentry } = {}) {
  console.log('[cron] runImapInboxAuditCron start')

  const enabled = await readOperatorSetting(pool, 'imap_inbox_audit_enabled', 'boolean', DEFAULT_ENABLED)
  if (!enabled) {
    console.log('[cron] runImapInboxAuditCron disabled via operator_settings.imap_inbox_audit_enabled')
    return { scanned: 0, gapped: 0, skipped: 0, enabled: false }
  }

  const threshold = await readOperatorSetting(
    pool,
    'imap_inbox_audit_gap_threshold',
    'int',
    DEFAULT_GAP_THRESHOLD,
  )

  if (typeof relayImapFetch !== 'function') {
    console.warn('[cron] runImapInboxAuditCron skipped — relayImapFetch dep missing')
    return { scanned: 0, gapped: 0, skipped: 0, enabled: true }
  }

  let scanned = 0
  let gapped = 0
  let skipped = 0

  try {
    const { rows: mailboxes } = await pool.query(
      `SELECT id, from_address, imap_host, imap_port, imap_username, smtp_username,
              password, preferred_country
       FROM outreach_mailboxes
       WHERE status = 'active'
         AND environment = 'production'
         AND imap_host IS NOT NULL`,
    )

    for (const mb of mailboxes) {
      try {
        const username = mb.imap_username || mb.smtp_username
        const port = Number(mb.imap_port) || 993

        // limit=1 minimises payload (we only need unseen_total, not bodies).
        // include_body=false (default) → relay returns headers-only envelope.
        const fetchRes = await relayImapFetch(pool, {
          mailboxAddress:   mb.from_address,
          imapHost:         mb.imap_host,
          imapPort:         port,
          username,
          password:         mb.password,
          folder:           'INBOX',
          sinceUid:         0,
          limit:            1,
          preferredCountry: mb.preferred_country || 'CZ',
        })

        if (!fetchRes || fetchRes.ok === false) {
          // Transient relay/IMAP error — skip this mailbox this tick. The
          // runImapPollCron has its own circuit breaker; we don't double
          // up on retries here per feedback_external_io_backoff.
          skipped++
          console.log(`[imap-inbox-audit] mailbox ${mb.id} relay fetch skipped: ${fetchRes?.error || 'unknown'}`)
          continue
        }

        const unseen = Number(fetchRes.unseen_total) || 0

        // Per-mailbox ingestion count over last 24h. reply_inbox.mailbox_id
        // is the canonical attribution — unmatched_inbound has no
        // mailbox_id FK so we cannot split it per-mailbox; the reply_inbox
        // count is the signal we care about (replies that did make it
        // through the canonical pipeline).
        const { rows: cntRows } = await pool.query(
          `SELECT COUNT(*)::int AS c
           FROM reply_inbox
           WHERE mailbox_id = $1
             AND received_at > now() - interval '24 hours'`,
          [mb.id],
        )
        const ingested = Number(cntRows?.[0]?.c) || 0

        scanned++

        const { hasGap, gap } = computeGap({ unseenTotal: unseen, ingestedCount: ingested, threshold })
        if (hasGap) {
          gapped++
          await emitGapNotification(pool, {
            mailboxId:      mb.id,
            mailboxAddress: mb.from_address,
            unseen,
            ingested,
            gap,
            threshold,
          })
          // Sentry breadcrumb so the alert appears in the operator's
          // existing issue stream without depending on the dashboard
          // alerts panel being open.
          if (Sentry?.captureMessage) {
            try {
              Sentry.captureMessage(
                `IMAP inbox gap: mailbox #${mb.id} gap=${gap} > ${threshold}`,
                {
                  level: 'warning',
                  tags: { component: 'imap-inbox-audit', mailbox_id: String(mb.id) },
                  extra: { unseen, ingested, gap, threshold },
                },
              )
            } catch { /* Sentry init errors are non-fatal */ }
          }
          console.log(`[imap-inbox-audit] GAP mailbox=${mb.id} unseen=${unseen} ingested=${ingested} gap=${gap} threshold=${threshold}`)
        }
      } catch (e) {
        skipped++
        console.warn(`[imap-inbox-audit] mailbox ${mb.id} error:`, e?.message)
      }
    }
    console.log(`[cron] runImapInboxAuditCron done — scanned=${scanned} gapped=${gapped} skipped=${skipped}`)
  } catch (e) {
    console.error('[cron] runImapInboxAuditCron error:', e?.message)
  }

  return { scanned, gapped, skipped, enabled: true }
}
