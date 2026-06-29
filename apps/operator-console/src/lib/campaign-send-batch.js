// Shared implementation for campaign batch send.
//
// Called by:
//   - BFF endpoint POST /api/campaigns/:id/send-batch
//   - CLI script apps/outreach-dashboard/campaign-send-batch.mjs (retains its own
//     proxy-probe + arg parsing; uses this for core DB + relay logic)
//
// HARD RULES enforced here:
//   - Anti-trace relay path mandatory (HARD RULE feedback_anti_trace_full_stack).
//     Never direct SMTP (HARD RULE feedback_no_direct_smtp).
//   - SMTP credentials read from DB only (HARD RULE feedback_mailbox_passwords_via_db).
//   - H2.1: FOR UPDATE SKIP LOCKED → immediate mark as 'queued' in same txn.
//   - Send-gate parity with the canonical Go runner (campaign/runner.go +
//     gate.go): candidate SELECT applies the contacts.status "do not contact"
//     vocabulary, the suppression UNION filter (outreach_suppressions ∪
//     suppression_list), and COALESCE(co.email_status,'')='valid'.
//   - Exactly-once via send_claims (migration 171) — acquireClaim before submit,
//     confirmClaim on success, releaseClaim on failure. Shared atomic gate with
//     the Go daemon, replacing the prior operator_audit_log idempotency read so
//     the dual send-path race cannot double-send.
//   - send_events INSERT on success (mailbox_used=from_address, ON CONFLICT DO
//     NOTHING) fires the warmup-cap trigger + feeds threading/cap counting,
//     matching the Go orchestrator's post-send INSERT.
//   - PII guard: caller must never include raw email addresses in API response
//     (HARD RULE feedback_no_pii_in_commands). This module does not return emails.
//   - AR8: aggregate volume cap checked before each batch (GLOBAL_AGGREGATE_CAP env,
//     default 50/h). Prevents burst-send reputation hits on CZ recipient SMTP servers.

import { buildUnsubToken } from './unsubToken.js'
import { formatRFC5322Date } from './time-chaos.js'
// Canonical suppression UNION filter (mirrors the Go runner's suppressionFilterFor).
import { notInUnionWhere } from './suppressionUnionSql.js'
// Exactly-once send-claim (migration 171) — shared atomic gate with the Go daemon.
import { acquireClaim, confirmClaim, releaseClaim, CLAIM_PROCEED, CLAIM_ALREADY_SENT } from './sendClaim.js'

// ── S6.1 — Dual mailbox pool: primary/backup/legacy fallback ─────────────────
// Eligibility criteria (all must hold):
//   status='active', environment='production'
//   last_score >= 80 (OR NULL — new mailbox, no score yet)
//   circuit_opened_at IS NULL (no circuit trip)
//   consecutive_bounces < 3
//
// Selection order: primary → backup → legacy mailbox_pool
// Audit log written when backup tier activates.
//
// Exported for unit testing.

/**
 * Fetch eligible mailboxes from the given ID list.
 * Returns rows ordered by last_score DESC (best first), then id.
 * NULL last_score treated as eligible (new mailbox, no history yet).
 *
 * @param {import('pg').Pool} pool
 * @param {number[]} mailboxIds
 * @returns {Promise<Array<{id:number,smtp_username:string,password:string,smtp_host:string,smtp_port:number,from_address:string,last_score:number|null,circuit_opened_at:Date|null,consecutive_bounces:number|null}>>}
 */
export async function fetchEligibleMailboxes(pool, mailboxIds) {
  if (!mailboxIds || mailboxIds.length === 0) return []
  const { rows } = await pool.query(
    `SELECT id, smtp_username, password, smtp_host, smtp_port, from_address,
            imap_host, imap_port,
            last_score, circuit_opened_at, consecutive_bounces
     FROM outreach_mailboxes
     WHERE id = ANY($1::int[])
       AND status='active'
       AND environment='production'
       AND (last_score IS NULL OR last_score >= 80)
       AND circuit_opened_at IS NULL
       AND (consecutive_bounces IS NULL OR consecutive_bounces < 3)
     ORDER BY last_score DESC NULLS LAST, id`,
    [mailboxIds],
  )
  return rows
}

/**
 * Pick the active mailbox pool using primary/backup/legacy tier logic.
 *
 * Returns { tier: 'primary'|'backup'|'legacy', mailboxes: row[] }.
 * Throws if no tier yields eligible mailboxes.
 *
 * Audit log entry written on backup tier activation (campaign_pool_failover).
 *
 * @param {import('pg').Pool} pool
 * @param {object|null} sending_config
 * @param {number} campaignId   — for audit log
 * @returns {Promise<{tier: string, mailboxes: object[]}>}
 */
export async function pickActivePool(pool, sending_config, campaignId) {
  const primaryIds = sending_config?.mailbox_pool_primary
  const backupIds  = sending_config?.mailbox_pool_backup
  const legacyIds  = sending_config?.mailbox_pool

  // Try primary
  if (Array.isArray(primaryIds) && primaryIds.length > 0) {
    const eligible = await fetchEligibleMailboxes(pool, primaryIds)
    if (eligible.length > 0) {
      return { tier: 'primary', mailboxes: eligible }
    }
  }

  // Try backup
  if (Array.isArray(backupIds) && backupIds.length > 0) {
    const eligible = await fetchEligibleMailboxes(pool, backupIds)
    if (eligible.length > 0) {
      // Audit log — backup activation
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_pool_failover', 'campaign-send-batch', 'campaign', $1::text,
                 jsonb_build_object('tier', 'backup', 'reason', 'primary_unavailable'))`,
        [String(campaignId)],
      ).catch(() => { /* audit best-effort */ })
      console.warn(`[S6.1] campaign=${campaignId} USING BACKUP POOL — primary unavailable`)
      return { tier: 'backup', mailboxes: eligible }
    }
  }

  // Try legacy (backward compat — plain mailbox_pool)
  if (Array.isArray(legacyIds) && legacyIds.length > 0) {
    const eligible = await fetchEligibleMailboxes(pool, legacyIds)
    if (eligible.length > 0) {
      return { tier: 'legacy', mailboxes: eligible }
    }
  }

  throw Object.assign(
    new Error('no eligible mailboxes (no primary/backup/legacy pool with healthy active mailboxes)'),
    { code: 'NO_MAILBOXES' },
  )
}

const DEFAULT_UNSUB_SECRET = 'd755731507bb7b68f85b54d4ebcf280ed864e2f6d650270be383331aba342e06'

// ── LIA NACE scope (Sprint AI) ──────────────────────────────────────────────
// Loaded dynamically from operator_settings DB table (key="lia_nace_scope").
// Source of truth: docs/legal/lia-direct-marketing.md (v1.2, 2026-05-06).
// Fallback: legacy hardcoded array if the row is missing or unparseable —
// matches the Go-side fallback in services/campaigns/sender/lia_scope.go so
// both runtimes return the same set when operator_settings is unreachable.
// CHANGES: update docs/legal/lia-direct-marketing.md, then update the
// lia_nace_scope row in operator_settings via SQL or the dashboard UI.
const LIA_SCOPE_LEGACY_FALLBACK = ['01', '41', '42', '43', '45', '46', '49', '77']

/**
 * Reads the lia_nace_scope row from operator_settings and returns it as a
 * 2-digit NACE section array. Returns the legacy fallback if the row is
 * missing, malformed, or the query fails. Callers pass the BFF pool.
 *
 * @param {{ query: (q: string, params?: unknown[]) => Promise<{rows: Array<{value:string}>}> }} pool
 * @returns {Promise<string[]>}
 */
export async function getLIAScopeNACE(pool) {
  try {
    if (!pool || typeof pool.query !== 'function') {
      return [...LIA_SCOPE_LEGACY_FALLBACK]
    }
    const { rows } = await pool.query(
      `SELECT value FROM operator_settings WHERE key = 'lia_nace_scope' LIMIT 1`,
    )
    if (!rows?.length || !rows[0]?.value) {
      return [...LIA_SCOPE_LEGACY_FALLBACK]
    }
    const parsed = JSON.parse(rows[0].value)
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [...LIA_SCOPE_LEGACY_FALLBACK]
    }
    // Coerce to strings + keep only the 2-character prefix so e.g. "41200"
    // and 4120 both normalise to "41" before the membership check.
    return parsed.map(String).map(s => s.substring(0, 2)).filter(Boolean)
  } catch (e) {
    console.warn('[getLIAScopeNACE] load failed, using legacy fallback:', e.message)
    return [...LIA_SCOPE_LEGACY_FALLBACK]
  }
}

/**
 * Returns true when at least one of the company's NACE codes falls within
 * the sections declared in the current LIA document.
 *
 * naceCodes is an array of 5-digit strings (e.g. ["41200","43110"]) as stored
 * in companies.nace_codes. An empty array or null → false (block).
 *
 * Exported for unit testing. Internal callers: sendCampaignBatch.
 *
 * @param {string[]|null} naceCodes
 * @param {string[]} liaScope - LIA NACE scope array (loaded separately via getLIAScopeNACE)
 * @returns {boolean}
 */
export function isInLiaScope(naceCodes, liaScope) {
  if (!Array.isArray(naceCodes) || naceCodes.length === 0) return false
  if (!Array.isArray(liaScope) || liaScope.length === 0) return false
  const scopeSet = new Set(liaScope)
  return naceCodes.some(code => {
    if (!code || code.length < 2) return false
    return scopeSet.has(code.substring(0, 2))
  })
}

/**
 * Substitute {{firma}}/{{.Firma}} style template variables.
 * Mirrors the Go template engine subset used by campaign-send-batch.mjs.
 *
 * @param {string} text
 * @param {Record<string,string>} vars
 * @returns {string}
 */
function substituteVars(text, vars) {
  const m = {
    '{{firma}}': vars.firma || '',    '{{.Firma}}': vars.firma || '',
    '{{jmeno}}': vars.jmeno || '',    '{{.Jmeno}}': vars.jmeno || '',
    '{{prijmeni}}': vars.prijmeni || '', '{{.Prijmeni}}': vars.prijmeni || '',
    '{{region}}': vars.region || '',  '{{.Region}}': vars.region || '',
    '{{ico}}': vars.ico || '',        '{{.ICO}}': vars.ico || '',
    '{{podpis}}': vars.podpis || '',  '{{.Podpis}}': vars.podpis || '',
    '{{unsuburl}}': vars.unsuburl || '', '{{.UnsubURL}}': vars.unsuburl || '',
  }
  let out = text
  for (const [k, v] of Object.entries(m)) out = out.split(k).join(v)
  return out
}

/**
 * Build an unsubscribe URL for a recipient.
 *
 * @param {number} campaignId
 * @param {number} contactId
 * @param {string} email
 * @param {string} secret
 * @param {string} baseUrl
 * @returns {string}
 */
function buildUnsubURL(campaignId, contactId, email, secret, baseUrl) {
  const token = buildUnsubToken(campaignId, contactId, email, secret)
  return `${baseUrl}/unsubscribe?c=${campaignId}&id=${contactId}&t=${token}`
}

/**
 * Execute a campaign batch send.
 *
 * @param {{
 *   pool: import('pg').Pool,
 *   campaignId: number,
 *   count: number,
 *   relayURL: string,
 *   relayToken: string,
 *   unsubSecret?: string,
 *   unsubBase?: string,
 *   senderSignature?: string,
 * }} opts
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   campaign_id: number,
 *   requested: number,
 *   picked: number,
 *   sent: number,
 *   skipped_idempotent: number,
 *   failed: number,
 *   lia_skipped: number,
 *   envelopes: Array<{contact_id: number, cc_id: number, envelope_id: string|null, skipped?: boolean, error?: string}>,
 * }>}
 */
// ── AR17 — Phase-aware send window + hourly sub-cap ────────────────────────────
//
// Warmup mailboxes MUST spread sends across the phase's allowed hours.
// Fresh mailboxes (warmup_d0) are restricted to a narrow 4h window (10–14).
// Production mailboxes get a full 8–20 window.
// Hard-excluded: 00:00–06:00 Europe/Prague regardless of phase.
//
// Per-hour sub-cap (maxPerHour) is derived from daily_cap / window_hours,
// rounded up. This prevents burst-send reputation hits.

/** @type {Record<string, {hours: [number, number], maxPerHour: number}>} */
export const PHASE_SPREAD = {
  warmup_d0:  { hours: [10, 14], maxPerHour: Math.ceil(5  / 4)  },  //  10-14h, 2/h
  warmup_d3:  { hours: [9,  17], maxPerHour: Math.ceil(10 / 8)  },  //   9-17h, 2/h
  warmup_d7:  { hours: [8,  18], maxPerHour: Math.ceil(25 / 10) },  //   8-18h, 3/h
  warmup_d14: { hours: [8,  19], maxPerHour: Math.ceil(50 / 11) },  //   8-19h, 5/h
  production: { hours: [8,  20], maxPerHour: Math.ceil(100 / 12) }, //  8-20h, 9/h
}

/** Hard night-silence block: 00:00–06:00 Prague, regardless of phase. */
const NIGHT_SILENCE_START = 0   // inclusive
const NIGHT_SILENCE_END   = 6   // exclusive (i.e. 06:00 is allowed)

/**
 * Return the hour (0–23) in Europe/Prague for a given Date.
 *
 * @param {Date} now
 * @returns {number}
 */
export function pragueHour(now) {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Prague',
      hour: 'numeric',
      hour12: false,
    }).format(now),
    10,
  )
}

/**
 * AR17 — Returns true when `now` falls within the phase-specific send window
 * for the given mailbox lifecycle_phase.
 *
 * Hard-blocks the 00:00–06:00 night-silence window first.
 * Falls back to `PHASE_SPREAD.production` for unknown phases.
 *
 * @param {Date}   now
 * @param {string} phase — lifecycle_phase value from outreach_mailboxes
 * @returns {boolean}
 */
export function isWithinPhaseWindow(now, phase) {
  const hour = pragueHour(now)
  // Hard night-silence block
  if (hour >= NIGHT_SILENCE_START && hour < NIGHT_SILENCE_END) return false
  const spread = PHASE_SPREAD[phase] ?? PHASE_SPREAD.production
  return hour >= spread.hours[0] && hour < spread.hours[1]
}

/**
 * AR17 — Check whether this mailbox has already hit its per-hour sub-cap.
 *
 * Queries operator_audit_log for 'campaign_contact_send' entries for the
 * given mailbox in the current UTC hour. Returns the block reason when
 * exceeded, or null when the send may proceed.
 *
 * @param {import('pg').Pool} pool
 * @param {number}  mailboxId
 * @param {string}  phase
 * @returns {Promise<{blocked: true, reason: string, used: number, max: number} | null>}
 */
export async function checkHourlySubCap(pool, mailboxId, phase) {
  const spread = PHASE_SPREAD[phase] ?? PHASE_SPREAD.production
  const max = spread.maxPerHour
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM operator_audit_log
     WHERE action = 'campaign_contact_send'
       AND details->>'mailbox_id' = $1::text
       AND created_at >= date_trunc('hour', NOW())`,
    [String(mailboxId)],
  )
  const used = rows[0]?.cnt ?? 0
  if (used >= max) {
    return { blocked: true, reason: 'hourly_sub_cap_exceeded', used, max }
  }
  return null
}

// Default hourly aggregate cap. Operator can raise via GLOBAL_AGGREGATE_CAP env var.
// Conservative: 50/h at start; raise gradually as reputation builds.
export const DEFAULT_AGGREGATE_CAP = 50

/**
 * AR8 — Check aggregate volume cap.
 * Returns { skipped, reason, sends_in_window } when the cap is exceeded.
 * Returns null when the batch may proceed.
 *
 * @param {import('pg').Pool} pool
 * @param {object} [Sentry] — optional Sentry instance for alerting
 * @returns {Promise<{skipped:true,reason:string,sends_in_window:number}|null>}
 */
export async function checkAggregateCap(pool, Sentry) {
  const cap = parseInt(process.env.GLOBAL_AGGREGATE_CAP, 10) || DEFAULT_AGGREGATE_CAP
  const { rows } = await pool.query(
    'SELECT * FROM check_aggregate_volume_cap($1, $2)',
    [3600, cap],
  )
  const row = rows[0]
  if (!row) return null
  if (row.exceeded) {
    const msg = `aggregate_volume_cap_exceeded sends_in_window=${row.sends_in_window} cap=${row.cap}`
    console.warn(`[AR8] ${msg}`)
    try {
      Sentry?.captureMessage(msg, 'warning')
    } catch (_) { /* Sentry best-effort */ }
    return { skipped: true, reason: 'aggregate_volume_cap_exceeded', sends_in_window: Number(row.sends_in_window) }
  }
  return null
}

export async function sendCampaignBatch(opts) {
  const {
    pool,
    campaignId,
    count,
    relayURL,
    relayToken,
    unsubSecret = process.env.UNSUBSCRIBE_SECRET || process.env.OUTREACH_API_KEY || DEFAULT_UNSUB_SECRET,
    unsubBase = process.env.UNSUB_BASE_URL || 'https://outreach-dashboard-production-e4ce.up.railway.app',
    senderSignature = process.env.SENDER_SIGNATURE || 'Goran Nowak',
    Sentry,
  } = opts

  // ── AR8. Aggregate volume cap pre-flight ────────────────────────────────────
  const capBlock = await checkAggregateCap(pool, Sentry)
  if (capBlock) {
    return {
      ok: false,
      campaign_id: campaignId,
      requested: count,
      picked: 0,
      sent: 0,
      skipped_idempotent: 0,
      failed: 0,
      lia_skipped: 0,
      envelopes: [],
      ...capBlock,
    }
  }

  // ── 0. Load LIA NACE scope from operator_settings ──────────────────────────
  // Sprint AI: Unified source of truth (no longer duplicated in Go + JS).
  const liaScope = await getLIAScopeNACE(pool)

  // ── 1. Load campaign + template ──────────────────────────────────────────
  const { rows: campRows } = await pool.query(
    `SELECT id, name, sequence_config, sending_config FROM campaigns WHERE id=$1`,
    [campaignId],
  )
  if (!campRows.length) {
    throw Object.assign(new Error(`Campaign ${campaignId} not found`), { code: 'NOT_FOUND' })
  }
  const camp = campRows[0]

  const step0 = (camp.sequence_config || [])[0]
  if (!step0 || !step0.template) {
    throw Object.assign(new Error('Campaign has empty or invalid sequence_config'), { code: 'CONFIG_ERROR' })
  }

  const { rows: tplRows } = await pool.query(
    `SELECT id, name, subject, body, COALESCE(body_html, '') AS body_html FROM email_templates WHERE name=$1`,
    [step0.template],
  )
  if (!tplRows.length) {
    throw Object.assign(new Error(`Template "${step0.template}" not found`), { code: 'TEMPLATE_NOT_FOUND' })
  }
  const tpl = tplRows[0]

  // ── 2. Load mailbox pool — S6.1 primary/backup/legacy tier logic ─────────
  // pickActivePool tries primary → backup (+ audit log) → legacy (backward compat).
  // Legacy fallback: if none of the new fields exist, falls back to mailbox_pool.
  // Default legacy list [1,3,631] kept only when sending_config.mailbox_pool is absent.
  const sendingCfgWithDefault = camp.sending_config?.mailbox_pool
    ? camp.sending_config
    : { ...camp.sending_config, mailbox_pool: [1, 3, 631] }
  const { tier: _poolTier, mailboxes: pickedMailboxes } = await pickActivePool(pool, sendingCfgWithDefault, campaignId)

  // Validate mailboxes have passwords (HARD RULE: passwords via DB)
  const validMailboxes = pickedMailboxes.filter(m => m.password && m.password.length >= 8)
  if (!validMailboxes.length) {
    throw Object.assign(new Error('No mailboxes with valid password (HARD RULE: set passwords via UI/DB)'), { code: 'NO_PASSWORDS' })
  }

  // ── 3. H2.1 — Select + lock pending contacts atomically ──────────────────
  // FOR UPDATE OF cc SKIP LOCKED: concurrent runs skip already-locked rows.
  // Immediate UPDATE to 'queued' inside the same transaction ensures the
  // selection survives even if this process holds the txn open briefly.
  //
  // Lead-score ordering (migration 111, Sprint reply-pipeline-recovery):
  //   1) priority DESC NULLS LAST  — highest machinery-fit score first
  //   2) next_send_at ASC NULLS FIRST — oldest queued (FIFO within tier)
  //   3) contact_id ASC            — deterministic tiebreaker
  // Index idx_campaign_contacts_priority (campaign_id, status,
  // priority DESC NULLS LAST, next_send_at) supports this ORDER BY without
  // a full table sort. Campaign 457 cohort: A-tier (>=0.90) ships first,
  // E-tier (<0.50, e.g. úřady / architekti) ships last.
  let contacts
  {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Send-gate parity with the canonical Go runner (services/campaigns/campaign/
      // runner.go ~220-237 + gate.go EmailStatusAllowed). Enrollment-time filters
      // do NOT re-check per send, so these are the last-line compliance gate:
      //   - c.status NOT IN (...) — full "do not contact" vocabulary (migration
      //     033) so a contact that flipped to unsubscribed/bounced/suppressed
      //     after enrollment is excluded here, not just at enroll time.
      //   - COALESCE(co.email_status,'')='valid' — only verified-deliverable
      //     (EmailStatusAllowed). LEFT JOIN → no company row = '' = blocked.
      //   - suppression UNION filter — outreach_suppressions ∪ suppression_list.
      const result = await client.query(
        `SELECT cc.id AS cc_id, cc.contact_id, cc.status, cc.priority,
                c.email, c.first_name, c.last_name, c.company_name, c.region, c.ico,
                co.nace_codes
         FROM campaign_contacts cc
         JOIN contacts c ON c.id=cc.contact_id
         LEFT JOIN companies co ON co.ico = c.ico
         WHERE cc.campaign_id=$1 AND cc.status='pending'
           AND c.status NOT IN (
               'bounced', 'blacklisted', 'invalid',
               'unsubscribed', 'opted_out',
               'human_handoff', 'paused_human',
               'completed_no_reply', 'retention_expired',
               'suppressed'
           )
           AND COALESCE(co.email_status, '') = 'valid'
           AND ${notInUnionWhere('c.email')}
         ORDER BY cc.priority DESC NULLS LAST,
                  cc.next_send_at ASC NULLS FIRST,
                  cc.contact_id ASC
         LIMIT $2
         FOR UPDATE OF cc SKIP LOCKED`,
        [campaignId, count],
      )
      if (result.rows.length > 0) {
        await client.query(
          `UPDATE campaign_contacts SET status='queued', updated_at=NOW()
           WHERE id = ANY($1::int[])`,
          [result.rows.map(r => r.cc_id)],
        )
      }
      await client.query('COMMIT')
      contacts = result.rows
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  if (!contacts.length) {
    return {
      ok: true,
      campaign_id: campaignId,
      requested: count,
      picked: 0,
      sent: 0,
      skipped_idempotent: 0,
      failed: 0,
      lia_skipped: 0,
      envelopes: [],
    }
  }

  // ── 3b. H5.3 — LIA NACE scope pre-flight filter ──────────────────────────
  // Block contacts whose company is outside the NACE sections declared in the
  // current LIA (docs/legal/lia-direct-marketing.md v1.2).
  // Out-of-scope contacts are reverted to 'pending' and logged as
  // 'campaign_lia_scope_skip' in operator_audit_log.
  const liaApproved = []
  const liaSkipped = []

  for (const c of contacts) {
    if (isInLiaScope(c.nace_codes, liaScope)) {
      liaApproved.push(c)
    } else {
      liaSkipped.push(c)
    }
  }

  if (liaSkipped.length > 0) {
    // Revert status to 'pending' so operators can investigate / re-segment.
    const skippedIds = liaSkipped.map(c => c.cc_id)
    await pool.query(
      `UPDATE campaign_contacts SET status='pending', updated_at=NOW()
       WHERE id = ANY($1::int[]) AND status='queued'`,
      [skippedIds],
    ).catch(() => { /* best-effort; main loop will not process these */ })

    // Audit log one row per skipped contact.
    for (const c of liaSkipped) {
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('campaign_lia_scope_skip', 'bff-send-batch', 'campaign_contact', $1::text,
                 jsonb_build_object('campaign_id', $2::int, 'contact_id', $3::bigint,
                                    'ico', $4::text, 'nace_codes', $5::text))`,
        [String(c.cc_id), campaignId, c.contact_id, c.ico || '', JSON.stringify(c.nace_codes || [])],
      ).catch(() => { /* audit best-effort */ })
    }

    console.warn(
      `[LIA H5.3] campaign=${campaignId} lia_skipped=${liaSkipped.length}/${contacts.length} contacts blocked — outside NACE scope`,
    )
  }

  contacts = liaApproved

  // ── 4. Send each contact ──────────────────────────────────────────────────
  const envelopes = []
  let sent = 0
  let skipped_idempotent = 0
  let failed = 0
  const lia_skipped = liaSkipped.length

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i]
    const mb = validMailboxes[i % validMailboxes.length]

    const vars = {
      firma:    c.company_name || '',
      jmeno:    c.first_name || '',
      prijmeni: c.last_name || '',
      region:   c.region || '',
      ico:      c.ico || '',
      podpis:   senderSignature,
      unsuburl: buildUnsubURL(campaignId, c.contact_id, c.email, unsubSecret, unsubBase),
    }
    const subject  = substituteVars(tpl.subject, vars)
    const body     = substituteVars(tpl.body, vars)
    const bodyHtml = tpl.body_html ? substituteVars(tpl.body_html, vars) : ''

    // Exactly-once send-claim (migration 171 send_claims) — the shared atomic
    // gate the Go daemon also acquires. Supersedes the prior 24h
    // operator_audit_log idempotency read: durable, atomic (UNIQUE constraint),
    // and visible to BOTH send paths so the dual-path race can no longer
    // double-send. step=0 — the batch sends only the first sequence step.
    const claim = await acquireClaim(pool, campaignId, c.contact_id, 0)
    if (claim !== CLAIM_PROCEED) {
      if (claim === CLAIM_ALREADY_SENT) {
        // Already sent (by us or the Go daemon) — catch up UI status, count handled.
        await pool.query(
          `UPDATE campaign_contacts SET status='in_sequence', current_step=0, next_send_at=NOW(), updated_at=NOW()
           WHERE id=$1 AND status != 'in_sequence'`,
          [c.cc_id],
        ).catch(() => { /* best-effort */ })
        envelopes.push({ contact_id: c.contact_id, cc_id: c.cc_id, envelope_id: null, skipped: true })
        skipped_idempotent++
        sent++ // idempotent = still counts as handled
      } else {
        // In-flight elsewhere (Go daemon / parallel run holds the claim). Release
        // our 'queued' reservation back to 'pending' so the holder owns it.
        await pool.query(
          `UPDATE campaign_contacts SET status='pending', updated_at=NOW()
           WHERE id=$1 AND status='queued'`,
          [c.cc_id],
        ).catch(() => { /* best-effort */ })
        envelopes.push({ contact_id: c.contact_id, cc_id: c.cc_id, envelope_id: null, skipped: true, error: 'in_flight_elsewhere' })
      }
      continue
    }

    // Submit via anti-trace relay
    try {
      const relayBase = relayURL.replace(/\/+$/, '')
      const r = await fetch(`${relayBase}/v1/submit`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${relayToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: c.email,
          subject,
          body,
          // Memory feedback_relay_submit_full_payload: relay ships
          // multipart/alternative when body_html is non-empty so the recipient
          // sees the HTML rendering authored in email_templates.body_html.
          body_html: bodyHtml,
          from_address: mb.from_address,
          smtp_host: mb.smtp_host,
          smtp_port: mb.smtp_port,
          smtp_username: mb.smtp_username || mb.from_address,
          smtp_password: mb.password,
          // Memory feedback_relay_submit_full_payload: IMAP coords are the
          // gate for the relay's post-send Sent APPEND. Without these the
          // Sent folder stays empty (silent skip in relay main.go).
          imap_host: mb.imap_host || '',
          imap_port: mb.imap_port || 0,
          // Mailbox-locale Date header so the recipient's mail client doesn't
          // render the timestamp shifted by the recipient's TZ offset. Without
          // this the relay/SMTP path leaves Date unset; the upstream MTA fills
          // in UTC and CEST recipients see the message as "2 hours ago".
          headers: {
            Date: formatRFC5322Date(new Date(), 'Europe/Prague'),
          },
        }),
      })
      const respText = await r.text()
      let data
      try { data = respText ? JSON.parse(respText) : {} } catch { data = {} }

      if (data.envelope_id) {
        // Promote the send-claim claiming→sent so any future attempt for this
        // (campaign,contact,step) short-circuits. Idempotent (CAS on 'claiming').
        await confirmClaim(pool, campaignId, c.contact_id, 0, data.envelope_id)
          .catch(() => { /* best-effort */ })

        // send_events row — parity with the Go orchestrator's post-send INSERT
        // (services/orchestrator/cmd/outreach/main.go). Fires the BEFORE-INSERT
        // warmup-cap trigger (trg_enforce_warmup_cap keys on mailbox_used =
        // outreach_mailboxes.from_address) and feeds per-mailbox daily-cap
        // counting + reply threading (runner reads message_id from send_events).
        // Best-effort like the Go path: a warmup_cap_exceeded rejection is
        // logged, not fatal — the message already left via the relay.
        await pool.query(
          `INSERT INTO send_events (campaign_id, contact_id, step, mailbox_used, message_id, subject, status, sent_at)
           VALUES ($1, $2, 0, $3, $4, $5, 'sent', NOW())
           ON CONFLICT (campaign_id, contact_id, step) WHERE status = 'sent' DO NOTHING`,
          [campaignId, c.contact_id, mb.from_address, data.envelope_id, subject],
        ).catch(() => { /* best-effort: cap rejection logged, not fatal (Go parity) */ })

        // Audit log FIRST — so idempotency check catches crash-after-submit
        await pool.query(
          `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
           VALUES ('campaign_contact_send', 'bff-send-batch', 'campaign_contact', $1::text,
                   jsonb_build_object('campaign_id', $2::int, 'contact_id', $3::bigint,
                                      'mailbox_id', $4::int, 'envelope_id', $5::text,
                                      'subject', $6::text))`,
          [String(c.cc_id), campaignId, c.contact_id, mb.id, data.envelope_id, subject],
        ).catch(() => { /* audit best-effort, do not fail the send */ })

        // Mark in_sequence + step 0
        await pool.query(
          `UPDATE campaign_contacts SET status='in_sequence', current_step=0, next_send_at=NOW(), updated_at=NOW()
           WHERE id=$1`,
          [c.cc_id],
        )
        envelopes.push({ contact_id: c.contact_id, cc_id: c.cc_id, envelope_id: data.envelope_id })
        sent++
      } else {
        // Release the send-claim (claiming→failed) so the next run can re-claim.
        await releaseClaim(pool, campaignId, c.contact_id, 0).catch(() => { /* best-effort */ })
        // Revert to pending so next run can retry
        await pool.query(
          `UPDATE campaign_contacts SET status='pending', updated_at=NOW()
           WHERE id=$1 AND status='queued'`,
          [c.cc_id],
        ).catch(() => { /* best-effort */ })
        envelopes.push({ contact_id: c.contact_id, cc_id: c.cc_id, envelope_id: null, error: data.error || 'relay rejected without envelope_id' })
        failed++
      }
    } catch (e) {
      // Release the send-claim (claiming→failed) so the next run can re-claim.
      await releaseClaim(pool, campaignId, c.contact_id, 0).catch(() => { /* best-effort */ })
      await pool.query(
        `UPDATE campaign_contacts SET status='pending', updated_at=NOW()
         WHERE id=$1 AND status='queued'`,
        [c.cc_id],
      ).catch(() => { /* best-effort */ })
      envelopes.push({ contact_id: c.contact_id, cc_id: c.cc_id, envelope_id: null, error: e.message || String(e) })
      failed++
    }
  }

  // ── 4b. Tier breakdown (lead-score ordering visibility) ──────────────────
  // Aggregates the LIA-approved cohort (post-ORDER BY) by tier so the
  // operator UI can show "A=6, B=3, C=1" instead of a flat sent count.
  // Tier thresholds mirror compute_machinery_score() ranges in migration 111
  // and the priority-distribution endpoint below in campaigns.js.
  const tier_breakdown = computeTierBreakdown(contacts)

  // ── 5. Batch-level audit log ──────────────────────────────────────────────
  await pool.query(
    `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
     VALUES ('campaign_send_batch', 'bff-send-batch', 'campaign', $1::text,
             jsonb_build_object('requested', $2::int, 'picked', $3::int,
                                'sent', $4::int, 'skipped_idempotent', $5::int,
                                'failed', $6::int, 'lia_skipped', $7::int,
                                'tier_breakdown', $8::jsonb))`,
    [String(campaignId), count, contacts.length, sent, skipped_idempotent, failed, lia_skipped,
     JSON.stringify(tier_breakdown)],
  ).catch(() => { /* best-effort */ })

  return {
    ok: true,
    campaign_id: campaignId,
    requested: count,
    picked: contacts.length + lia_skipped,
    sent,
    skipped_idempotent,
    failed,
    lia_skipped,
    tier_breakdown,
    envelopes,
  }
}

/**
 * Classify a campaign_contacts.priority value into a coarse tier label.
 * Mirrors the priority-distribution endpoint in server-routes/campaigns.js.
 *
 * @param {number|null|undefined} priority
 * @returns {'A'|'B'|'C'|'D'|'E'}
 */
export function tierFromPriority(priority) {
  const p = Number(priority)
  if (!Number.isFinite(p)) return 'E'
  if (p >= 0.90) return 'A'
  if (p >= 0.78) return 'B'
  if (p >= 0.65) return 'C'
  if (p >= 0.50) return 'D'
  return 'E'
}

/**
 * Group an array of contact rows (each carrying .priority) by tier and
 * return a `{ A: n, B: n, C: n, D: n, E: n }` count map. Empty tiers
 * are still represented as 0 so the consumer can render a stable shape.
 *
 * @param {Array<{ priority?: number|null }>} rows
 * @returns {{ A: number, B: number, C: number, D: number, E: number }}
 */
export function computeTierBreakdown(rows) {
  const out = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  if (!Array.isArray(rows)) return out
  for (const r of rows) {
    out[tierFromPriority(r?.priority)]++
  }
  return out
}
