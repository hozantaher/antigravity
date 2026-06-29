// BFF operator approval queue + company timeline.
// ─────────────────────────────────────────────────────────────────────────────
// Backs the React surfaces in src/components/{ApprovalQueue,
// SuggestionReview,CompanyTimeline}.jsx. Reads/writes ai_suggestion_audit
// (migration 019) — pending rows are AI drafts awaiting operator decision;
// terminal rows record the operator's approve/edit/reject action and the
// final_output text actually sent.
//
// Pipeline ingest path: see runImapPollCron() in server.js — when a new
// reply lands, the BFF best-effort calls services/llm-runner /v1/generate
// and inserts a 'pending' row. The endpoints below are the read + write
// surface for the operator UI sitting on top of those rows.
//
// T3.6 (2026-05-01): extracted verbatim from server.js per ADR-008 D2 module
// sequence (after #459 mountHealthRoutes). Behavior is byte-equivalent to
// the inline declarations: same SQL, same response shape, same Czech error
// messages, same operator_audit_log writes, same Sentry capture path via
// the shared `setRouteTags` + `capture500` deps.
//
// G7 (2026-05-12): legacy src/routes/replies.js merged in (Sprint G7/#1241).
// Routes previously registered via createRepliesRouter() are now mounted
// directly on the app here. Eliminates the two-mounter drift risk.
//
// Route inventory (this file):
//   GET  /api/replies
//   GET  /api/replies/stream   (SSE — real-time reply_inserted events, F1)
//   GET  /api/replies/:id
//   PATCH /api/replies/:id/handled
//   PATCH /api/replies/:id
//   POST /api/replies/:id/forward-to-crm
//   POST /api/replies/:id/forward-to-garaaage   (legacy alias)
//   GET  /api/threads/:id/context
//   GET  /api/replies/:id/context               (KT-A13 alias)
//   PATCH /api/replies/:id/classify
//   GET  /api/classifier/overrides
//   GET  /api/threads/:id/messages
//   GET  /api/operator/queue
//
// NOTE: /api/replies/stats lives in repliesStats.js and /api/leads +
// /api/leads/:id live in leads.js (both mounted before this module in
// server.js). The duplicate fallback declarations that used to live here were
// removed to eliminate the dead route registrations (api-route-inventory
// snapshot contract).
//   GET  /api/operator/queue/:suggestionId
//   POST /api/operator/approve
//   GET  /api/companies/:id/timeline
//
// Memory rules:
//   feedback_no_speculation — fields derived from migration 019 schema +
//     the props consumed by the existing UI components.
//   feedback_extreme_testing — see tests/contract/bff-operator-approval.

import { capture500 } from '../lib/sentryCapture.js'
import { clampInt } from '../lib/clampInt.js'
import { rewriteCidUris } from '../lib/cidRewrite.js'
import { decodeMimeWords } from '../lib/mimeDecode.js'
import { mineReplySignals } from '../lib/mineReplySignals.js'
import { parseSignature } from '../lib/parseSignature.js'
import { htmlToText } from '../lib/htmlToText.js'
import { notUndeliverableSql } from '../lib/undeliverableFilter.js'
import {
  classifyReplyId,
  findById as findReplyById,
  setHandled as setReplyHandled,
  setClassification as setReplyClassification,
} from '../lib/repliesRepository.js'

// AR-Wave3 (2026-05-18, ticket #4) — whitelisted sort key → SQL column
// mapping for GET /api/replies. Anything off this list falls back to
// the default `received_at` order, matching pre-Wave3 behaviour.
// Schema verified 2026-05-18 via `\d reply_inbox` + `\d unmatched_inbound`:
//   reply_inbox: received_at, from_email, classification (+ c.name via JOIN)
//   unmatched_inbound: received_at, from_address, classification
// Per feedback_schema_verify_before_sql T0.
const SORT_KEY_TO_REPLY_COLUMN = {
  received: 'r.received_at',
  sender: 'LOWER(r.from_email)',
  campaign: 'LOWER(COALESCE(c.name, \'\'))',
  classification: 'r.classification',
}
const SORT_KEY_TO_UNMATCHED_COLUMN = {
  received: 'received_at',
  sender: 'LOWER(from_address)',
  // Unmatched rows have no campaign join — every row gets the literal
  // "(neznámá kampaň)" label. Using a CONSTANT in ORDER BY is a Postgres
  // syntax error ("non-integer constant in ORDER BY"), so we fall back
  // to the natural id ordering inside this branch. The outer JS merge
  // then re-sorts the union by campaign_name so unmatched rows cluster
  // alongside named-campaign rows correctly.
  campaign: 'id',
  classification: 'classification',
}
const SORT_DIR_ALLOWED = new Set(['asc', 'desc'])
const DEFAULT_SORT_KEY = 'received'
const DEFAULT_SORT_DIR = 'desc'

// G3.7.5a — hover-preview payload constants.
// BODY_PREVIEW_CHARS caps the body_text slice in the list response so
// the reply list stays lightweight (no full 50 KB HTML blobs per row).
// HOVER_DELAY_MS is exported for the UI component to import so there is
// a single source of truth — no magic numbers on either side.
// Per feedback_no_magic_thresholds T0.
export const BODY_PREVIEW_CHARS = 500
export const HOVER_DELAY_MS = 300

// decodeMimeWords now lives in ../lib/mimeDecode.js (shared with the Home
// dashboard summary so subjects decode identically everywhere).

const OPERATOR_ACTIONS_TERMINAL = new Set(['approved', 'edited', 'rejected'])

/**
 * Mount the BFF replies, leads, operator approval + company timeline surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   setRouteTags: (tags: Record<string, string>) => void,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountRepliesRoutes(app, deps) {
  const { pool, setRouteTags, capture500: capture500dep, safeError } = deps
  // capture500dep may be passed in; fall back to the module-level import if absent
  // (some tests pass a minimal deps object without capture500).
  const cap500 = capture500dep || capture500

  // ── Replies list ─────────────────────────────────────────────────────────
  //
  // AS-F1 (2026-05-19, fix/replies-as-f1-union-pagination) — single
  // server-side UNION ALL over reply_inbox + unmatched_inbound applied
  // with one ORDER BY + LIMIT/OFFSET. Total is COUNT(*) over the same
  // union (window function on the outer SELECT, returned once per row).
  //
  // Previous (pre-AS-F1) implementation did two separate SELECTs and
  // merged client-side; orphans were only included when offset===0 and
  // total reported reply_inbox-only counts. That produced empty page
  // 2+ and a mismatch with /api/replies/stats.nezpracovane.
  //
  // Schema verified 2026-05-19 via `\d reply_inbox` + `\d unmatched_inbound`:
  //   reply_inbox: id (bigint), send_event_id, campaign_id, contact_id,
  //                mailbox_id, from_email, subject, classification,
  //                received_at, handled (boolean), handled_at
  //   unmatched_inbound: id (bigint), from_address, subject,
  //                      body_preview (text NOT NULL), received_at,
  //                      reviewed (boolean NOT NULL), reviewed_at,
  //                      classification
  // Per feedback_schema_verify_before_sql T0.
  app.get('/api/replies', async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit || 30), 100)
      const offset = Math.max(0, Number(req.query.offset || 0))

      // --- Per-branch param builders ----------------------------------------
      // The two CTE arms are textually distinct and must each carry their own
      // `$N` placeholders. We keep a single growing params array; each helper
      // appends to it and returns the placeholder index it took.
      const params = []
      const pushParam = (v) => { params.push(v); return params.length }

      const showUnmatched = req.query.show_unmatched !== '0'
      const includeBounces =
        req.query.include_bounces === 'true' ||
        req.query.include_bounces === '1'
      // campaign_id / company_icos filters semantically require a matched
      // contact — orphan rows in unmatched_inbound never qualify, so we
      // skip the second arm entirely when those filters are active.
      const matchedOnly = Boolean(req.query.campaign_id || req.query.company_icos || req.query.contact_id)
      const includeUnmatched = showUnmatched && !matchedOnly

      // ── Build reply_inbox arm ─────────────────────────────────────────────
      const replyConds = []
      if (req.query.handled === 'false') replyConds.push(`r.handled = FALSE`)
      else if (req.query.handled === 'true') replyConds.push(`r.handled = TRUE`)
      if (req.query.flagged === 'true') replyConds.push(`r.flagged = TRUE`)
      // Mined-signal filters (#1578 M1 persistence) — operate on the persisted
      // reply_inbox.mined jsonb. has_phone is the highest-value výkup queue:
      // "show me sellers who left a phone number to call". callback/urgent are
      // the intent flags. unmatched_inbound has no mined column → its arm pushes
      // FALSE for these so the filter narrows to matched replies only.
      if (req.query.has_phone === 'true') replyConds.push(`r.mined IS NOT NULL AND jsonb_array_length(r.mined->'phones') > 0`)
      if (req.query.callback === 'true') replyConds.push(`(r.mined->>'callback')::bool IS TRUE`)
      if (req.query.urgent === 'true') replyConds.push(`(r.mined->>'urgent')::bool IS TRUE`)
      if (req.query.classification) {
        replyConds.push(`r.classification = $${pushParam(req.query.classification)}`)
      } else if (!includeBounces) {
        // Default view hides bounce + corrupted_charset from reply_inbox too
        // so the count matches what the operator actually sees. The list
        // page filters the SAME way on classification-less default view.
        replyConds.push(`(r.classification IS NULL OR r.classification NOT IN ('bounce','corrupted_charset'))`)
        // …PLUS undeliverable/NDR notifications the upstream classifier left as
        // classification=NULL (seznam postmaster NDRs etc.) — recognise them by
        // sender/subject signature so they never surface as fake replies. Gated
        // by the same include_bounces escape hatch. (undeliverableFilter.js)
        replyConds.push(notUndeliverableSql('r.from_email', 'r.subject'))
      }
      if (req.query.campaign_id) {
        replyConds.push(`r.campaign_id = $${pushParam(Number(req.query.campaign_id))}`)
      }
      // contact_id — used by the Kontakty detail to list a contact's replies
      // (the kontakt→odpověď edge). Matched-only (unmatched have no contact).
      if (req.query.contact_id) {
        replyConds.push(`r.contact_id = $${pushParam(Number(req.query.contact_id))}`)
      }
      // F-S1 — company_icos CSV → filter via contacts.ico = ANY(...).
      const icoCsv = req.query.company_icos
      if (icoCsv && typeof icoCsv === 'string') {
        const icos = icoCsv.split(',').map(s => s.trim()).filter(Boolean)
        if (icos.length > 0) {
          replyConds.push(`ct.ico = ANY($${pushParam(icos)})`)
        }
      }
      // Sprint 3.3 — text search across subject + from_email.
      const q = (req.query.q || '').toString().trim()
      if (q.length >= 3) {
        const idx = pushParam(`%${q}%`)
        replyConds.push(`(r.subject ILIKE $${idx} OR r.from_email ILIKE $${idx})`)
      }
      // Sprint 3.3 — date range filter (24h | 7d | 30d | ISO).
      const since = (req.query.since || '').toString().trim()
      const SHORT_INTERVALS = { '24h': '1 day', '7d': '7 days', '30d': '30 days' }
      if (since) {
        const interval = SHORT_INTERVALS[since]
        if (interval) {
          replyConds.push(`r.received_at >= now() - INTERVAL '${interval}'`)
        } else if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
          replyConds.push(`r.received_at >= $${pushParam(since)}::timestamptz`)
        }
      }
      const replyWhere = replyConds.length ? `WHERE ${replyConds.join(' AND ')}` : ''
      // G3.7.5a — LEFT JOIN outreach_messages to get body_text + attachments_meta
      // for the hover-preview payload. The join is on direction='inbound' + contact_id
      // proximity (same approach as the thread-context enrichment in GET /api/replies/:id/context).
      // When G3.7.1 lands reply_inbox.body_text directly, this join becomes a thin fallback
      // but the SELECT shape stays identical so no UI change is required.
      // BODY_PREVIEW_CHARS truncation keeps list payload lean (~500 chars vs full body).
      // attachments_meta is a small JSON array (filename + size_bytes) — no BYTEA, safe to
      // inline. NULL when no outreach_messages match (legacy rows / pre-backfill).
      // Per feedback_schema_verify_before_sql T0: outreach_messages verified in migration 012.
      const replyBranchSql = `
        SELECT
          r.id::bigint                       AS id,
          r.send_event_id,
          r.campaign_id,
          r.contact_id,
          r.mailbox_id,
          r.from_email,
          r.subject,
          r.classification,
          NULL::text                         AS body_preview,
          r.received_at,
          r.handled,
          r.handled_at,
          c.name                             AS campaign_name,
          TRIM(COALESCE(ct.first_name,'') || ' ' || COALESCE(ct.last_name,'')) AS contact_name,
          ct.crm_client_id,
          'reply_inbox'::text                AS source,
          -- Prefer reply_inbox.body_text (Schema-A, where the decoded body
          -- actually lives) and fall back to the legacy outreach_messages
          -- join. Previously this read only om.body_text — empty in the
          -- Schema-A-only deployment — so every list row showed "(bez
          -- náhledu)" even though the body was right there in reply_inbox.
          LEFT(COALESCE(NULLIF(r.body_text, ''), om.body_text), ${BODY_PREVIEW_CHARS}) AS body_text_preview,
          om.attachments_meta,
          -- #7 prior-send: subject of the most recent outbound to this
          -- contact+campaign (NULL when none). Sourced via the ps LATERAL below.
          ps.prior_send_subject,
          -- #16 suppression: sender is on a suppression list. UNION both tables
          -- (outreach_suppressions + suppression_list) per the canonical pattern.
          EXISTS (
            SELECT 1 FROM (
              SELECT lower(trim(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
              UNION
              SELECT lower(trim(email)) AS email FROM suppression_list WHERE email IS NOT NULL
            ) sup WHERE sup.email = lower(trim(r.from_email))
          ) AS suppressed,
          -- Odpovědi: does this reply already have a captured vehicle? The
          -- auto-capture cron deliberately leaves the reply unhandled (the
          -- regex guess awaits operator confirmation), so the list flags these
          -- rows so the operator can tell "confirm draft vehicle" apart from
          -- "fresh triage" among the unhandled backlog.
          EXISTS (SELECT 1 FROM vehicles vh WHERE vh.source_reply_id = r.id) AS has_vehicle,
          r.flagged,
          -- Mined signals (#1578 M1 persistence) — small jsonb bundle so the
          -- inbox row can show a 📞 chip and the operator can call straight
          -- from the list without opening the reply.
          r.mined
        FROM reply_inbox r
        LEFT JOIN campaigns c ON c.id = r.campaign_id
        LEFT JOIN contacts  ct ON ct.id = r.contact_id
        LEFT JOIN LATERAL (
          SELECT om2.body_text,
                 (
                   SELECT COALESCE(json_agg(json_build_object(
                     'filename',   ma.filename,
                     'size_bytes', ma.size_bytes,
                     'content_type', ma.content_type
                   ) ORDER BY ma.id), '[]'::json)
                   FROM message_attachments ma
                   WHERE ma.message_id = om2.id AND ma.is_inline = FALSE
                 ) AS attachments_meta
          FROM outreach_messages om2
          JOIN outreach_threads ot2 ON ot2.id = om2.thread_id
          WHERE om2.direction = 'inbound'
            AND ot2.contact_id = r.contact_id
            AND om2.replied_at BETWEEN r.received_at - INTERVAL '60 seconds'
                                   AND r.received_at + INTERVAL '60 seconds'
          ORDER BY ABS(EXTRACT(EPOCH FROM (om2.replied_at - r.received_at)))
          LIMIT 1
        ) om ON r.contact_id IS NOT NULL
        LEFT JOIN LATERAL (
          SELECT se.subject AS prior_send_subject
          FROM send_events se
          WHERE se.contact_id = r.contact_id
            AND se.campaign_id = r.campaign_id
            AND se.subject IS NOT NULL
          ORDER BY se.sent_at DESC NULLS LAST
          LIMIT 1
        ) ps ON r.contact_id IS NOT NULL AND r.campaign_id IS NOT NULL
        ${replyWhere}
      `

      // ── Build unmatched_inbound arm ───────────────────────────────────────
      let unmatchedBranchSql = ''
      if (includeUnmatched) {
        const umConds = []
        if (req.query.handled === 'false') umConds.push(`u.reviewed = FALSE`)
        else if (req.query.handled === 'true') umConds.push(`u.reviewed = TRUE`)
        // Flagged is reply_inbox-only; a flagged filter excludes all unmatched.
        if (req.query.flagged === 'true') umConds.push(`FALSE`)
        // Mined signals are reply_inbox-only too (#1578) — these filters exclude
        // all unmatched rows, same as flagged.
        if (req.query.has_phone === 'true') umConds.push(`FALSE`)
        if (req.query.callback === 'true') umConds.push(`FALSE`)
        if (req.query.urgent === 'true') umConds.push(`FALSE`)
        if (req.query.classification) {
          umConds.push(`u.classification = $${pushParam(req.query.classification)}`)
        } else if (!includeBounces) {
          umConds.push(`(u.classification IS NULL OR u.classification NOT IN ('bounce','corrupted_charset'))`)
          // Same undeliverable-signature guard on the unmatched arm (sender col
          // is from_address here). Currently a no-op against PROD data (all
          // unmatched bounces are already classified) but keeps the two arms
          // symmetric and future-proof.
          umConds.push(notUndeliverableSql('u.from_address', 'u.subject'))
        }
        // Text search mirrors reply_inbox semantics on the unmatched arm's
        // own columns (subject + from_address).
        if (q.length >= 3) {
          const idx = pushParam(`%${q}%`)
          umConds.push(`(u.subject ILIKE $${idx} OR u.from_address ILIKE $${idx})`)
        }
        if (since) {
          const interval = SHORT_INTERVALS[since]
          if (interval) {
            umConds.push(`u.received_at >= now() - INTERVAL '${interval}'`)
          } else if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
            umConds.push(`u.received_at >= $${pushParam(since)}::timestamptz`)
          }
        }
        const umWhere = umConds.length ? `WHERE ${umConds.join(' AND ')}` : ''
        // G3.7.5a — unmatched arm: body_text_preview from body_preview (truncated),
        // attachments_meta from unmatched_inbound_attachments (migration 103).
        unmatchedBranchSql = `
          SELECT
            (-u.id)::bigint                  AS id,
            NULL::bigint                     AS send_event_id,
            NULL::bigint                     AS campaign_id,
            NULL::bigint                     AS contact_id,
            NULL::bigint                     AS mailbox_id,
            u.from_address                   AS from_email,
            u.subject,
            COALESCE(u.classification, 'unmatched')::text AS classification,
            LEFT(COALESCE(u.body_preview, ''), 140)       AS body_preview,
            u.received_at,
            u.reviewed                       AS handled,
            u.reviewed_at                    AS handled_at,
            '(neznámá kampaň)'::text         AS campaign_name,
            ''::text                         AS contact_name,
            NULL::bigint                     AS crm_client_id,
            'unmatched_inbound'::text        AS source,
            LEFT(u.body_preview, ${BODY_PREVIEW_CHARS})  AS body_text_preview,
            (
              SELECT COALESCE(json_agg(json_build_object(
                'filename',   uia.filename,
                'size_bytes', uia.size_bytes,
                'content_type', uia.content_type
              ) ORDER BY uia.idx), '[]'::json)
              FROM unmatched_inbound_attachments uia
              WHERE uia.unmatched_id = u.id
                AND uia.is_inline = FALSE
            ) AS attachments_meta,
            -- #7: unmatched replies have no campaign/contact → no prior send.
            NULL::text                       AS prior_send_subject,
            -- #16 suppression: same UNION check against the unmatched sender.
            EXISTS (
              SELECT 1 FROM (
                SELECT lower(trim(email)) AS email FROM outreach_suppressions WHERE email IS NOT NULL
                UNION
                SELECT lower(trim(email)) AS email FROM suppression_list WHERE email IS NOT NULL
              ) sup WHERE sup.email = lower(trim(u.from_address))
            ) AS suppressed,
            FALSE AS has_vehicle,  -- unmatched replies never have a captured vehicle
            FALSE AS flagged,      -- flag is a matched-lead action (reply_inbox only)
            NULL::jsonb AS mined   -- mined signals live on reply_inbox only (#1578)
          FROM unmatched_inbound u
          ${umWhere}
        `
      }

      // ── ORDER BY / LIMIT / OFFSET ─────────────────────────────────────────
      const sortKeyRaw = (req.query.sort || '').toString().toLowerCase()
      const sortKey = SORT_KEY_TO_REPLY_COLUMN[sortKeyRaw] ? sortKeyRaw : DEFAULT_SORT_KEY
      const sortDirRaw = (req.query.dir || '').toString().toLowerCase()
      const sortDir = SORT_DIR_ALLOWED.has(sortDirRaw) ? sortDirRaw : DEFAULT_SORT_DIR
      const orderDirSql = sortDir === 'asc' ? 'ASC' : 'DESC'
      // Map the public sort key to a column reference valid in the outer
      // SELECT (CTE column names — no table-prefix). Each branch above
      // already aliases its native columns into this unified set.
      const OUTER_SORT_COLUMN = {
        received:       'received_at',
        sender:         'LOWER(from_email)',
        campaign:       'LOWER(COALESCE(campaign_name, \'\'))',
        classification: 'classification',
      }
      const orderCol = OUTER_SORT_COLUMN[sortKey] || 'received_at'

      const innerSql = includeUnmatched
        ? `${replyBranchSql} UNION ALL ${unmatchedBranchSql}`
        : replyBranchSql

      const limitIdx = pushParam(limit)
      const offsetIdx = pushParam(offset)
      const sql = `
        WITH all_replies AS (${innerSql})
        SELECT *, (SELECT count(*) FROM all_replies)::bigint AS total_count
        FROM all_replies
        ORDER BY ${orderCol} ${orderDirSql} NULLS LAST, id ${orderDirSql}
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
      `
      const { rows } = await pool.query(sql, params)
      const total = rows.length > 0 ? Number(rows[0].total_count || 0) : await (async () => {
        // Empty page (offset > total) — re-issue a count-only query so we
        // still return the canonical total. Reuses the same params (minus
        // limit + offset) by re-running the CTE in COUNT form.
        const countParams = params.slice(0, params.length - 2)
        const { rows: cr } = await pool.query(
          `WITH all_replies AS (${innerSql}) SELECT count(*)::bigint AS total FROM all_replies`,
          countParams,
        )
        return Number(cr?.[0]?.total || 0)
      })()
      // Strip the total_count column from each row before returning so the
      // wire shape stays { rows: [{...}], total: N }.
      for (const row of rows) { delete row.total_count }

      // Decode MIME-encoded subject + from_email (RFC 2047).
      for (const row of rows) {
        if (row.subject)    row.subject    = decodeMimeWords(row.subject)
        if (row.from_email) row.from_email = decodeMimeWords(row.from_email)
      }
      // CRM enrichment: batch-fetch all referenced crm_clients in ONE query.
      // Was an N+1 loop (one SELECT per row → 30-100 blocking round-trips per
      // request on the core triage list). Now a single ANY() lookup + map.
      const crmIds = [...new Set(rows.map(r => r.crm_client_id).filter(Boolean))]
      if (crmIds.length > 0) {
        const { rows: crmRows } = await pool.query(
          `SELECT id, crm_status, crm_relationship, owner_email, last_activity,
                  imported_from
           FROM crm_clients WHERE id = ANY($1::bigint[])`, [crmIds]
        ).catch(() => ({ rows: [] }))
        const crmById = new Map(crmRows.map(c => [String(c.id), c]))
        for (const row of rows) {
          if (!row.crm_client_id) continue
          const crm = crmById.get(String(row.crm_client_id))
          if (crm) {
            const { id: _crmId, ...crmFields } = crm
            row.crm = crmFields
          }
        }
      }
      res.json({ rows, total })
    } catch (e) { cap500(res, e, safeError) }
  })

  // ── Replies stats — moved to repliesStats.js ─────────────────────────────
  // The canonical GET /api/replies/stats lives in src/server-routes/repliesStats.js
  // (mounted before this module in server.js — AM-F3). The duplicate fallback
  // declaration that used to live here was removed: it shadowed nothing in
  // production (repliesStats.js always wins on first-match) and only registered
  // a dead route that tripped the api-route-inventory duplicate-route contract.

  // ── Real-time SSE stream (F1 / #1265) ────────────────────────────────────
  // Clients open EventSource('/api/replies/stream') and receive
  // `reply_inserted` events whenever reply_inbox or unmatched_inbound gets a
  // new row (migration 105 installs the PG NOTIFY triggers).
  //
  // MUST be registered BEFORE /:id so Express does not consume 'stream' as
  // a dynamic segment.
  //
  // PII rule (feedback_no_pii_in_commands): `from` is never forwarded;
  // the payload carries only structural metadata (source, id, received_at).
  const replyStreamClients = new Set()

  function publishReplyEvent(payload) {
    if (replyStreamClients.size === 0) return
    // Strip `from` and any other PII before fan-out.
    const safe = {
      source:      payload.source      || null,
      id:          payload.id          || null,
      received_at: payload.received_at || null,
    }
    let line
    try { line = `event: reply_inserted\ndata: ${JSON.stringify(safe)}\n\n` } catch { return }
    for (const sseRes of replyStreamClients) {
      try { sseRes.write(line) } catch { /* swept by disconnect */ }
    }
  }

  let replyListenClient = null
  async function ensureReplyListenClient() {
    if (replyListenClient) return
    try {
      const c = await pool.connect()
      c.on('notification', (msg) => {
        if (msg.channel !== 'reply_inserted' && msg.channel !== 'thread_inbound') return
        let raw
        try { raw = JSON.parse(msg.payload || '{}') } catch { raw = {} }
        // Normalise thread_inbound shape (orchestrator RecordInbound path)
        // so the UI can handle both channels uniformly.
        const payload = msg.channel === 'thread_inbound'
          ? { source: 'outreach_messages', id: raw.id || raw.thread_id || null, received_at: raw.received_at || new Date().toISOString() }
          : raw
        publishReplyEvent(payload)
      })
      c.on('error', (err) => {
        console.warn('[replies/stream] LISTEN error:', err?.message)
        replyListenClient = null
      })
      await c.query('LISTEN reply_inserted')
      await c.query('LISTEN thread_inbound')
      replyListenClient = c
    } catch (err) {
      console.warn('[replies/stream] LISTEN setup failed:', err?.message)
      replyListenClient = null
    }
  }

  app.get('/api/replies/stream', async (req, res) => {
    res.set({
      'Content-Type':    'text/event-stream',
      'Cache-Control':   'no-cache, no-transform',
      'Connection':      'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
    replyStreamClients.add(res)
    await ensureReplyListenClient()

    const hb = setInterval(() => {
      try { res.write(`: hb ${Date.now()}\n\n`) } catch {}
    }, 30_000)
    req.on('close', () => {
      clearInterval(hb)
      replyStreamClients.delete(res)
    })
  })

  // ── Single reply by ID ────────────────────────────────────────────────────
  app.get('/api/replies/:id', async (req, res) => {
    try {
      const rawId = Number(req.params.id)
      if (!Number.isFinite(rawId)) {
        return res.status(400).json({ error: 'invalid id' })
      }
      // Negative IDs (-N) map to unmatched_inbound row N — same
      // convention as the list endpoint uses to differentiate
      // orphan replies from reply_inbox rows.
      if (rawId < 0) {
        const unmatchedId = -rawId
        const { rows: ur } = await pool.query(
          `SELECT id, message_id, in_reply_to, from_address, subject,
                  body_preview, received_at, reviewed, reviewed_at, created_at
             FROM unmatched_inbound
            WHERE id = $1`,
          [unmatchedId]
        )
        if (!ur.length) return res.status(404).json({ error: 'not found' })
        const u = ur[0]
        const reply = {
          id:             rawId,
          send_event_id:  null,
          campaign_id:    null,
          contact_id:     null,
          mailbox_id:     null,
          from_email:     decodeMimeWords(u.from_address) || '',
          subject:        decodeMimeWords(u.subject) || '',
          classification: 'unmatched',
          received_at:    u.received_at,
          handled:        u.reviewed,
          handled_at:     u.reviewed_at,
          campaign_name:  '(neznámá kampaň)',
          contact_name:   '',
          crm_client_id:  null,
          source:         'unmatched_inbound',
          message_id:     u.message_id,
          in_reply_to:    u.in_reply_to,
          body_preview:   u.body_preview,
        }
        reply.mined = mineReplySignals(u.body_preview)
        reply.signature = parseSignature(u.body_preview) // #1581 M2.1 (best-effort on the 500-char preview)
        return res.json({ reply })
      }
      // G3.7.5a — detail endpoint returns FULL body_text + body_html (not truncated)
      // plus attachments_meta via LEFT JOIN on outreach_messages. Same proximity
      // matching as the thread-context enrichment. body_html is NOT served here
      // (iframe-based rendering is in ThreadDetail); body_text is the full plain text.
      const { rows } = await pool.query(
        `SELECT r.id, r.send_event_id, r.campaign_id, r.contact_id, r.mailbox_id,
                r.from_email, r.subject, r.classification, r.pre_classification,
                r.received_at, r.handled, r.handled_at, r.flagged, r.flagged_at,
                c.name AS campaign_name,
                TRIM(COALESCE(ct.first_name,'') || ' ' || COALESCE(ct.last_name,'')) AS contact_name,
                ct.crm_client_id,
                -- G3.7.1: reply_inbox.body_text/body_html is canonical (the IMAP
                -- poller stores it directly). The outreach_messages LATERAL is a
                -- thin fallback for legacy/pre-backfill rows. Schema-A-only
                -- deployments have empty outreach_threads → om.* is always NULL,
                -- which is why the detail endpoint returned an empty body.
                COALESCE(NULLIF(r.body_text, ''), om.body_text) AS body_text,
                COALESCE(NULLIF(r.body_html, ''), om.body_html) AS body_html,
                om.attachments_meta
         FROM reply_inbox r
         LEFT JOIN campaigns c ON c.id = r.campaign_id
         LEFT JOIN contacts ct ON ct.id = r.contact_id
         LEFT JOIN LATERAL (
           SELECT om2.body_text,
                  om2.body_html,
                  (
                    SELECT COALESCE(json_agg(json_build_object(
                      'filename',   ma.filename,
                      'size_bytes', ma.size_bytes,
                      'content_type', ma.content_type
                    ) ORDER BY ma.id), '[]'::json)
                    FROM message_attachments ma
                    WHERE ma.message_id = om2.id AND ma.is_inline = FALSE
                  ) AS attachments_meta
           FROM outreach_messages om2
           JOIN outreach_threads ot2 ON ot2.id = om2.thread_id
           WHERE om2.direction = 'inbound'
             AND ot2.contact_id = r.contact_id
             AND om2.replied_at BETWEEN r.received_at - INTERVAL '60 seconds'
                                    AND r.received_at + INTERVAL '60 seconds'
           ORDER BY ABS(EXTRACT(EPOCH FROM (om2.replied_at - r.received_at)))
           LIMIT 1
         ) om ON r.contact_id IS NOT NULL
         WHERE r.id = $1`,
        [rawId]
      )
      if (!rows.length) return res.status(404).json({ error: 'not found' })
      rows[0].subject    = decodeMimeWords(rows[0].subject)
      rows[0].from_email = decodeMimeWords(rows[0].from_email)
      const reply = rows[0]
      // CRM enrichment for single reply
      if (reply.crm_client_id) {
        const { rows: [crm] } = await pool.query(
          `SELECT crm_status, crm_relationship, owner_email, last_activity,
                  imported_from
           FROM crm_clients WHERE id = $1`, [reply.crm_client_id]
        ).catch(() => ({ rows: [] }))
        if (crm) reply.crm = crm
      }
      // #1578 M1.1: mine high-value signals (phones, prices) from the body so
      // the operator sees a call-ready number without scanning the email.
      // #1579 H1.1: HTML-only replies have empty body_text — fall back to text
      // extracted from body_html so mining + signature parsing still work.
      const bodyForMining = (reply.body_text && reply.body_text.trim())
        ? reply.body_text
        : htmlToText(reply.body_html)
      reply.mined = mineReplySignals(bodyForMining)
      // #1581 M2.1: parse the signature block (company / IČO / email / phones) so
      // the operator sees WHO to call. When the signature carries an IČO, link it
      // back to a known crm_clients row (the reply↔CRM entity edge).
      reply.signature = parseSignature(bodyForMining)
      if (reply.signature?.ico) {
        const { rows: [crmMatch] } = await pool.query(
          `SELECT id, name, crm_status FROM crm_clients WHERE ico = $1 LIMIT 1`,
          [reply.signature.ico],
        ).catch(() => ({ rows: [] }))
        if (crmMatch) reply.signature.crmMatch = crmMatch
      }
      // #1578 M1 persistence: keep reply_inbox.mined fresh so the LIST filters
      // (has_phone / callback / urgent) see new inbound. Fire-and-forget,
      // write-once (WHERE mined IS NULL → no-op after first read). No audit row —
      // this is derived data, not operator-visible state.
      pool.query(
        `UPDATE reply_inbox SET mined = $1 WHERE id = $2 AND mined IS NULL`,
        [JSON.stringify(reply.mined), reply.id],
      ).catch(() => {})
      res.json({ reply })
    } catch (e) { cap500(res, e, safeError) }
  })

  // ────────────────────────────────────────────────────────────────────────
  // Bulk revert
  // ────────────────────────────────────────────────────────────────────────
  // Undo a prior bulk mutation by restoring prior handled/classification
  // values. Accepts { reverts: [{ reply_id, source, prior_handled, prior_classification }] }
  // and rolls them back in a single transaction. Redacts PII in audit details.
  //
  // feedback_audit_log_on_mutations T0: all UPDATEs + single audit INSERT
  // in one transaction.
  app.post('/api/replies/bulk-revert', async (req, res) => {
    const client = await pool.connect()
    try {
      const { reverts } = req.body || {}
      if (!Array.isArray(reverts) || reverts.length === 0) {
        return res.status(400).json({ error: 'reverts must be a non-empty array' })
      }
      // Validate request shape before touching DB
      for (const item of reverts) {
        if (typeof item.reply_id !== 'number' || typeof item.source !== 'string') {
          return res.status(400).json({ error: 'each revert item must have reply_id (number) and source (string)' })
        }
        const validSources = ['reply_inbox', 'unmatched_inbound']
        if (!validSources.includes(item.source)) {
          return res.status(400).json({ error: `source must be one of: ${validSources.join(', ')}` })
        }
      }

      await client.query('BEGIN')
      const actor =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator'

      // Apply reverts by source table
      const replyInboxReverts = reverts.filter(v => v.source === 'reply_inbox')
      const unmatchedReverts = reverts.filter(v => v.source === 'unmatched_inbound')

      // reply_inbox reverts
      for (const revert of replyInboxReverts) {
        await client.query(
          `UPDATE reply_inbox
           SET handled = $1, classification = $2
           WHERE id = $3`,
          [revert.prior_handled, revert.prior_classification, revert.reply_id]
        )
      }

      // unmatched_inbound reverts (uses 'reviewed' for handled column)
      for (const revert of unmatchedReverts) {
        await client.query(
          `UPDATE unmatched_inbound
           SET reviewed = $1, classification = $2
           WHERE id = $3`,
          [revert.prior_handled, revert.prior_classification, revert.reply_id]
        )
      }

      // Single audit log entry with redacted snapshot
      const redactEmail = (email) => {
        if (!email) return '(unknown)'
        const m = email.match(/<([^>]+)>/) // Strip display name if present
        const bare = m ? m[1] : email
        if (!bare || bare.length < 3) return '(redacted)'
        const [local, domain] = bare.split('@')
        if (!domain) return '(redacted)'
        return `${local.slice(0, 2)}***@${domain}`
      }

      // Build snapshot for audit log (redacted, no full emails)
      const snapshot = {
        revert_count: reverts.length,
        reply_inbox_count: replyInboxReverts.length,
        unmatched_count: unmatchedReverts.length,
        reverted_at: new Date().toISOString(),
      }

      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'reply_bulk_reverted',
          actor,
          'reply_batch',
          null,  // entity_id is bigint; batch id lives in details.reverted_at
          JSON.stringify(snapshot),
        ]
      )

      await client.query('COMMIT')
      res.json({ ok: true, reverted: reverts.length })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      cap500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // PATCH /api/replies/:id/handled — Sprint B1 (#1247): handler now
  // routes via setReplyHandled() in repliesRepository.js which picks the
  // right table (reply_inbox vs unmatched_inbound) by ID sign.
  //
  // feedback_audit_log_on_mutations T0: UPDATE + audit INSERT in one tx.
  app.patch('/api/replies/:id/handled', async (req, res) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await setReplyHandled(client, req.params.id, true)
      if (!result.ok) {
        await client.query('ROLLBACK')
        const status = result.error === 'not_found' ? 404 : 400
        return res.status(status).json({ error: result.error })
      }
      const actor =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator'
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'reply_marked_handled',
          actor,
          'reply',
          String(result.physicalId),
          JSON.stringify({ reply_id: result.physicalId, handled: true, source: result.source }),
        ],
      )
      await client.query('COMMIT')
      res.json({ ok: true })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      cap500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // PATCH /api/replies/:id — operator can toggle handled flag both ways.
  // Returns the canonical reply row so the UI can refresh without an
  // extra GET.
  //
  // feedback_audit_log_on_mutations T0: UPDATE + audit INSERT in one tx.
  app.patch('/api/replies/:id', async (req, res) => {
    const client = await pool.connect()
    try {
      const { handled } = req.body
      await client.query('BEGIN')
      const result = await setReplyHandled(client, req.params.id, !!handled)
      if (!result.ok) {
        await client.query('ROLLBACK')
        const status = result.error === 'not_found' ? 404 : 400
        return res.status(status).json({ error: result.error })
      }
      const actor =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator'
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'reply_marked_handled',
          actor,
          'reply',
          String(result.physicalId),
          JSON.stringify({ reply_id: result.physicalId, handled: !!handled, source: result.source }),
        ],
      )
      await client.query('COMMIT')
      // Re-fetch through the repository so the response is the unified shape.
      const fresh = await findReplyById(pool, req.params.id)
      if (!fresh) return res.status(404).json({ error: 'not found' })
      res.json(fresh)
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      cap500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // ── PATCH /api/replies/:id/flag ────────────────────────────────────────────
  // Star/flag a reply ("return to this"). reply_inbox only (matched leads);
  // a negative/unmatched id is rejected. UPDATE + audit in one tx
  // (feedback_audit_log_on_mutations T0). Body: { flagged: bool } (default true).
  app.patch('/api/replies/:id/flag', async (req, res) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'flag is reply_inbox only (positive id)' })
    }
    const flagged = req.body?.flagged === undefined ? true : !!req.body.flagged
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rowCount } = await client.query(
        `UPDATE reply_inbox
            SET flagged = $1,
                flagged_at = CASE WHEN $1 THEN now() ELSE NULL END
          WHERE id = $2`,
        [flagged, id],
      )
      if (rowCount === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'not found' })
      }
      const actor =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) || 'operator'
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('reply_flagged', $1, 'reply', $2, $3::jsonb)`,
        [actor, String(id), JSON.stringify({ reply_id: id, flagged })],
      )
      await client.query('COMMIT')
      res.json({ ok: true, flagged })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      cap500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // ── POST /api/replies/bulk-handled ─────────────────────────────────────────
  // Bulk triage (#1021 [S5.3]): mark many replies handled in one tx so the
  // operator can clear a batch of noise without one PATCH per row. Accepts
  // signed ids (positive → reply_inbox, negative → unmatched_inbound) and
  // routes each via setReplyHandled, exactly like PATCH /:id/handled. One
  // batch audit row (feedback_audit_log_on_mutations T0). Internal state flip
  // only — does NOT send mail, so no X-Confirm-Send gate.
  const BULK_HANDLED_MAX = 200  // guard against a runaway UPDATE from a bad client
  app.post('/api/replies/bulk-handled', async (req, res) => {
    const { ids, handled } = req.body || {}
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' })
    }
    if (ids.length > BULK_HANDLED_MAX) {
      return res.status(400).json({ error: `at most ${BULK_HANDLED_MAX} ids per request` })
    }
    if (!ids.every((id) => Number.isInteger(id))) {
      return res.status(400).json({ error: 'every id must be an integer' })
    }
    const target = handled === undefined ? true : !!handled
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const updated = []
      const failed = []
      for (const id of ids) {
        const result = await setReplyHandled(client, id, target)
        if (result.ok) updated.push({ id, source: result.source })
        else failed.push({ id, error: result.error })
      }
      const actor =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator'
      await client.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'reply_bulk_handled',
          actor,
          'reply_batch',
          null,
          JSON.stringify({
            requested: ids.length,
            updated: updated.length,
            failed: failed.length,
            handled: target,
            at: new Date().toISOString(),
          }),
        ],
      )
      await client.query('COMMIT')
      res.json({ ok: true, updated: updated.length, failed })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      cap500(res, e, safeError)
    } finally {
      client.release()
    }
  })

  // ── POST /api/replies/bulk-suppress-check ──────────────────────────────────────────────────────────────────────
  // Check which reply IDs (from reply_inbox + unmatched_inbound) have suppressed senders.
  // Returns { suppressed: [{ id, reason }] } — read-only endpoint, no audit needed.
  // PII guard: response carries only IDs + reason, never email addresses.
  app.post('/api/replies/bulk-suppress-check', async (req, res) => {
    try {
      const { ids } = req.body || {}
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'ids must be a non-empty array' })
      }

      // Normalize signed IDs: positive = reply_inbox, negative = unmatched_inbound (abs)
      const replyInboxIds = ids.filter(id => id > 0)
      const unmatchedIds = ids.filter(id => id < 0).map(id => Math.abs(id))

      // Fetch from_email from both tables, prefixed with table source for later join.
      // Combine results + check against UNION suppression tables.
      const results = []

      if (replyInboxIds.length > 0) {
        const { rows: replyRows } = await pool.query(
          `SELECT id, from_email FROM reply_inbox WHERE id = ANY($1::bigint[])`,
          [replyInboxIds]
        )
        results.push(...replyRows.map(r => ({ id: r.id, email: r.from_email })))
      }

      if (unmatchedIds.length > 0) {
        const { rows: unmatchedRows } = await pool.query(
          `SELECT id, from_address AS from_email FROM unmatched_inbound WHERE id = ANY($1::bigint[])`,
          [unmatchedIds]
        )
        results.push(...unmatchedRows.map(r => ({ id: -r.id, email: r.from_email })))
      }

      // Check each email against UNION suppression tables.
      const suppressedMap = new Map()
      if (results.length > 0) {
        // Build normalized email list for batch lookup.
        const normalizedEmails = results.map(r => (r.email || '').trim().toLowerCase())
        const { rows: suppressedRows } = await pool.query(
          `SELECT lower(trim(email)) AS email, reason
             FROM (
               SELECT email, reason FROM outreach_suppressions WHERE email IS NOT NULL
               UNION
               SELECT email, reason FROM suppression_list WHERE email IS NOT NULL
             ) sup
            WHERE lower(trim(email)) = ANY($1::text[])`,
          [normalizedEmails]
        )
        for (const row of suppressedRows) {
          suppressedMap.set(row.email, row.reason)
        }
      }

      // Build response: only include suppressed IDs.
      const suppressed = []
      for (const result of results) {
        const normalizedEmail = (result.email || '').trim().toLowerCase()
        const reason = suppressedMap.get(normalizedEmail)
        if (reason) {
          suppressed.push({ id: result.id, reason })
        }
      }

      res.json({ suppressed })
    } catch (e) { cap500(res, e, safeError) }
  })

  // S1: forward-to-CRM handoff stub. Until the CRM portal exposes
  // an ingestion API for "new auction listing" intake, this endpoint marks
  // the reply as handled + writes a healing_log row so ops has a trail.
  // The actual upload (photos + TP → portal) is manual until S6 portal
  // integration lands. Body shape: { notes?: string, crm_url?: string }
  //
  // Sprint AL: Brand-agnostic rename from forward-to-garaaage → forward-to-crm.
  // The old /forward-to-garaaage endpoint is kept as an alias for backward compat.
  async function forwardToCrmHandler(req, res) {
    try {
      const { notes, crm_url, garaaage_url } = req.body || {}
      const url = crm_url || garaaage_url  // Support both new + legacy field names

      // Fetch brand_label from operator_settings; fall back to 'Garaaage'
      let brandLabel = 'Garaaage'
      try {
        const { rows: [setting] } = await pool.query(
          `SELECT value FROM operator_settings WHERE key='brand_label' LIMIT 1`
        )
        if (setting) brandLabel = setting.value
      } catch {
        // Silently fall back on DB error
      }

      const { rows: [reply] } = await pool.query(
        `SELECT id, contact_id, campaign_id, from_email FROM reply_inbox WHERE id=$1`,
        [req.params.id]
      )
      if (!reply) return res.status(404).json({ error: 'not found' })

      await pool.query(
        `UPDATE reply_inbox SET handled=TRUE, handled_at=now() WHERE id=$1`,
        [req.params.id]
      )
      // Audit trail. healing_log is the canonical "who did what to which
      // entity" stream; ops dashboard reads this for activity feed.
      await pool.query(
        `INSERT INTO healing_log(entity_type, entity_id, entity_label, action, reason)
         VALUES('reply', $1, $2, 'forward_to_crm', $3)`,
        [String(reply.id), reply.from_email, notes || url || `manual handoff to ${brandLabel}`]
      ).catch(() => {})
      // feedback_audit_log_on_mutations T0 — forward-to-crm mutates reply_inbox.
      // Use reply.id (not from_email) to avoid PII in log per no_pii_in_logs.
      const crmActor =
        (req.headers && req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator'
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'reply_forwarded_to_crm',
          crmActor,
          'reply',
          String(reply.id),
          JSON.stringify({ reply_id: reply.id, has_crm_url: !!url, has_notes: !!notes }),
        ],
      ).catch(() => {})
      res.json({ ok: true, reply_id: reply.id, crm_url: url || null })
    } catch (e) { cap500(res, e, safeError) }
  }

  app.post('/api/replies/:id/forward-to-crm', forwardToCrmHandler)
  // Sprint AL backward-compat: forward-to-garaaage endpoint kept as alias.
  // Generic /forward-to-crm is the new primary; -garaaage works until 2026-08.
  app.post('/api/replies/:id/forward-to-garaaage', forwardToCrmHandler)

  // Shared context handler — used by both /api/threads/:id/context (legacy)
  // and /api/replies/:id/context (KT-A13 alias). Issue #307 requested the
  // replies-prefixed path because the operator URL space already uses
  // /replies/:id (the URL params == reply.id, not thread.id). Both paths
  // share this implementation so callers can migrate without behavior risk.
  const contextHandler = async (req, res) => {
    try {
      // AS-FIX (2026-05-19) — handle orphan replies (negative IDs from
      // unmatched_inbound). The legacy SELECT only joined reply_inbox →
      // contacts → companies; for orphans the orchestrator failed to
      // attach contact_id / campaign_id at ingest time, so the operator
      // saw "Firma: —" / "Z kampaně: —" with no chance of resolution.
      // Post-hoc match by from_address against contacts.email recovers
      // the company link; a recent send_events lookup recovers the
      // most likely campaign.
      const rawId = String(req.params.id || '')
      const numId = Number.parseInt(rawId, 10)
      const isOrphan = Number.isFinite(numId) && numId < 0

      // contacts joins to companies via IČO (no company_id FK; the contacts
      // table predates the companies linkage). Empty IČO falls through, so
      // the company section just stays null in the UI.
      let reply
      if (isOrphan) {
        const absId = Math.abs(numId)
        const { rows: [orphan] } = await pool.query(
          `SELECT u.from_address, u.subject, u.received_at, u.classification
             FROM unmatched_inbound u
            WHERE u.id = $1`,
          [absId]
        )
        if (!orphan) return res.status(404).json({ error: 'not found' })

        // Extract bare email from "Display Name <addr@example.com>" form.
        // AT-F3+ (2026-05-19) — extraction stays in JS (not SQL) so the
        // resulting LOWER(email) compare uses the literal value and the
        // planner can pick idx_contacts_lower_email instead of a seq scan.
        // CTE-based extraction defeated the index because the planner
        // didn't know the value at plan time.
        const bareEmail = (() => {
          const m = String(orphan.from_address || '').match(/<([^>]+)>/)
          if (m) return m[1].trim().toLowerCase()
          return String(orphan.from_address || '').trim().toLowerCase()
        })()

        // AT-F3+ — parallel-fetch contact + recent send by email. Even if
        // contact resolves later, we still want both round-trips overlapped.
        // The recent-send branch uses an EXISTS pattern against contacts
        // by email so it doesn't need the contact_id from the first query.
        let contact = null
        let company = null
        let campaign = null
        let originalMessage = null
        if (bareEmail) {
          // AT-F3+ — query shape MUST match the partial-index predicate
          // for `idx_contacts_lower_email` (WHERE email IS NOT NULL AND
          // email <> '') and `idx_companies_ico` (WHERE ico IS NOT NULL
          // AND ico <> ''). Without these explicit filters Postgres's
          // planner falls back to seq scan even though the functional
          // index matches LOWER(email). Verified via EXPLAIN ANALYZE.
          //
          // The contact + company join is split from the recent-send
          // lookup so both round-trips overlap via Promise.all.
          const [contactRes, recentRes] = await Promise.all([
            pool.query(
              `SELECT ct.id, ct.ico,
                      TRIM(COALESCE(ct.first_name,'') || ' ' || COALESCE(ct.last_name,'')) AS contact_name,
                      co.id AS company_id, co.name AS company_name, co.ico AS company_ico,
                      co.category_path AS sector, co.address_locality AS region, co.icp_tier
                 FROM contacts ct
                 LEFT JOIN companies co
                   ON co.ico = ct.ico
                  AND co.ico IS NOT NULL AND co.ico <> ''
                WHERE LOWER(ct.email) = $1
                  AND ct.email IS NOT NULL
                  AND ct.email <> ''
                LIMIT 1`,
              [bareEmail],
            ),
            pool.query(
              `SELECT se.campaign_id, se.sent_at, COALESCE(se.subject, '') AS subject,
                      cmp.name AS campaign_name, cmp.status AS campaign_status
                 FROM send_events se
                 JOIN contacts ct
                   ON ct.id = se.contact_id
                  AND ct.email IS NOT NULL
                  AND ct.email <> ''
                 LEFT JOIN campaigns cmp ON cmp.id = se.campaign_id
                WHERE LOWER(ct.email) = $1
                ORDER BY se.sent_at DESC NULLS LAST
                LIMIT 1`,
              [bareEmail],
            ),
          ])
          const c = contactRes.rows[0]
          if (c) {
            contact = { id: c.id, name: c.contact_name }
            if (c.company_id || c.company_name || c.company_ico) {
              company = {
                id: c.company_id,
                name: c.company_name,
                ico: c.company_ico,
                sector: c.sector,
                region: c.region,
                icp_tier: c.icp_tier || null,
              }
            }
          }
          const se = recentRes.rows[0]
          if (se && se.campaign_id) {
            campaign = {
              id: se.campaign_id,
              name: se.campaign_name,
              status: se.campaign_status,
              sent: 0,
              replied: 0,
              inferred: true, // operator-visible signal that this is a post-hoc guess
            }
            originalMessage = se.sent_at
              ? { sent_at: se.sent_at, subject: se.subject || '', body_preview: '' }
              : null
          }
        }

        return res.json({
          company: company || { id: null, name: null, ico: null, sector: null, region: null, icp_tier: null },
          contact: contact
            ? { id: contact.id, name: contact.name, email: bareEmail }
            : { id: null, name: null, email: bareEmail },
          campaign: campaign || { id: null, name: null, status: null, sent: 0, replied: 0, inferred: false },
          classification: orphan.classification || 'unmatched',
          original_message: originalMessage,
        })
      }

      const { rows: [reply_] } = await pool.query(
        `SELECT r.contact_id, r.campaign_id, r.classification, r.from_email, r.received_at,
                TRIM(COALESCE(ct.first_name,'') || ' ' || COALESCE(ct.last_name,'')) AS contact_name,
                co.id AS company_id, co.name AS company_name, co.ico, co.category_path AS sector, co.address_locality AS region, co.icp_tier,
                c.name AS campaign_name, c.status AS campaign_status
         FROM reply_inbox r
         LEFT JOIN contacts ct ON ct.id = r.contact_id
         LEFT JOIN companies co ON co.ico = NULLIF(ct.ico, '')
         LEFT JOIN campaigns c ON c.id = r.campaign_id
         WHERE r.id=$1`,
        [req.params.id]
      )
      reply = reply_
      if (!reply) return res.status(404).json({ error: 'not found' })
      const { rows: [stats] } = await pool.query(
        // send_events has no 'type' column + no per-send reply marker; replies
        // live in reply_inbox. Count sent from send_events, replied from
        // reply_inbox for the campaign (the old type='reply' silently 0'd it).
        `SELECT
           (SELECT COUNT(*)::int FROM send_events WHERE campaign_id=$1) AS sent,
           (SELECT COUNT(*)::int FROM reply_inbox  WHERE campaign_id=$1) AS replied`,
        [reply.campaign_id]
      ).catch(() => ({ rows: [{ sent: 0, replied: 0 }] }))

      // KT-A13 — original_message: the first outbound send_event for this
      // (contact, campaign) pair. Lets ThreadDetail show "Co jsme jim
      // poslali" without scrolling the timeline. Best-effort: a missing
      // template join or empty result yields null and the UI hides the
      // section. This must NOT block the primary context response.
      let originalMessage = null
      if (reply.contact_id && reply.campaign_id) {
        try {
          const { rows: msgs } = await pool.query(
            `SELECT se.sent_at,
                    COALESCE(se.subject, '') AS subject,
                    '' AS body_preview
               FROM send_events se
              WHERE se.contact_id = $1 AND se.campaign_id = $2
              ORDER BY se.sent_at ASC
              LIMIT 1`,
            [reply.contact_id, reply.campaign_id],
          )
          if (msgs.length > 0) {
            originalMessage = {
              sent_at: msgs[0].sent_at,
              subject: msgs[0].subject || '',
              body_preview: msgs[0].body_preview || '',
            }
          }
        } catch (_e) {
          // Schema variance (templates.body absent in older snapshots) — UI
          // tolerates null original_message.
          originalMessage = null
        }
      }

      const company = {
        id: reply.company_id,
        name: reply.company_name,
        ico: reply.ico,
        sector: reply.sector,
        region: reply.region,
        icp_tier: reply.icp_tier || null,
      }
      res.json({
        company,
        // KT-A13 — issue #307 expects `contact` key. We keep both `contact`
        // and `company` for one-sprint cohabitation; the next refactor can
        // drop `company` once all callers migrate.
        contact: { id: reply.contact_id, name: reply.contact_name, email: reply.from_email },
        // S1 — campaign.id surfaced so ThreadDetail can deep-link to /campaigns/:id.
        campaign: {
          id: reply.campaign_id,
          name: reply.campaign_name,
          status: reply.campaign_status,
          sent: stats?.sent || 0,
          replied: stats?.replied || 0,
        },
        classification: reply.classification,
        original_message: originalMessage,
      })
    } catch (e) { cap500(res, e, safeError) }
  }

  app.get('/api/threads/:id/context', contextHandler)
  // KT-A13 — replies-prefixed alias. Frontend should migrate to this path.
  app.get('/api/replies/:id/context', contextHandler)

  // S1 — single endpoint that combines classification + handled in one round-trip.
  // Special-case "unsubscribe" inserts the sender on outreach_suppressions so
  // future campaigns honour it. The legacy /:id/handled and /:id endpoints stay.
  //
  // KT-B4 — when the operator's classification differs from the existing
  // (LLM/cron-assigned) classification on the reply, write an audit row to
  // `classifier_overrides`. That table feeds:
  //   - prompt iteration (KT-B2) on real operator disagreements
  //   - confusion-matrix endpoint GET /api/classifier/overrides?days=N
  // We capture BEFORE updating so we have the original label in hand.
  app.patch('/api/replies/:id/classify', async (req, res) => {
    try {
      const { classification } = req.body || {}
      const ALLOWED = ['positive', 'negative', 'question', 'unsubscribe', 'auto_reply', null]
      if (classification !== undefined && !ALLOWED.includes(classification)) {
        return res.status(400).json({ error: 'invalid classification', allowed: ALLOWED.filter(Boolean) })
      }

      // Sprint B1 (#1247): the table-routing branch + UPDATE now lives in
      // repliesRepository.setClassification. Route concerns kept here:
      //   - KT-B4 override audit (only meaningful for reply_inbox source)
      //   - outreach_suppressions propagation for unsubscribe/negative
      const result = await setReplyClassification(pool, req.params.id, classification)
      if (!result.ok) {
        const status = result.error === 'not_found' ? 404 : 400
        return res.status(status).json({ error: result.error })
      }

      // KT-B4 — operator override capture (reply_inbox only — unmatched
      // has no prior LLM classification to compare against). Captures
      // first-time classification too (was_previous=null is significant
      // signal: "operator gave it a label LLM never did").
      if (
        result.source === 'reply_inbox' &&
        classification !== undefined &&
        classification !== null &&
        result.was_previous !== classification
      ) {
        const operator =
          (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
          (req.user && req.user.email) ||
          'unknown'
        await pool.query(
          `INSERT INTO classifier_overrides
             (reply_id, original_classification, override_classification, operator)
           VALUES ($1, $2, $3, $4)`,
          [result.reply.id, result.was_previous, classification, operator],
        ).catch(e => console.warn(
          // Czech log per project convention.
          `[replies/classify] op=reply.classifier.override záznam selhal:`, e.message,
        ))
      }

      // AV-F2 (2026-05-19) — when the operator manually classifies a reply
      // that the regex/LLM classifier had logged a verdict for, update the
      // most recent reply_classifications_log row with operator_override +
      // operator_override_at. The signed-id convention matches the column
      // semantics (positive=reply_inbox, negative=unmatched_inbound) so a
      // single UPDATE covers both sources. Audit row already emitted via
      // classifier_overrides above for reply_inbox source; this UPDATE is
      // additive and best-effort (no rollback on failure).
      if (classification !== undefined && classification !== null) {
        const signedReplyId = result.source === 'reply_inbox'
          ? Number(req.params.id)
          : -Math.abs(Number(req.params.id))
        await pool.query(
          `UPDATE reply_classifications_log
              SET operator_override = $1,
                  operator_override_at = now()
            WHERE id = (
              SELECT id FROM reply_classifications_log
                WHERE reply_id = $2
                ORDER BY created_at DESC
                LIMIT 1
            )`,
          [classification, signedReplyId],
        ).catch(e => console.warn(
          `[replies/classify] op=reply.classifier.av_f2.override záznam selhal:`, e.message,
        ))
      }

      // Unsubscribe / negative → propagate to suppression list. For
      // unmatched_inbound the from_address may include a display-name
      // wrapper; strip to bare email before INSERT.
      const propagateSuppression =
        classification === 'unsubscribe' ||
        (result.source === 'unmatched_inbound' && classification === 'negative')
      if (propagateSuppression && result.from_email) {
        const m = String(result.from_email).match(/<([^>]+)>/)
        const email = (m ? m[1] : result.from_email).trim().toLowerCase()
        const reason = classification === 'unsubscribe' ? 'unsubscribe-reply' : 'negative-reply'
        await pool.query(
          `INSERT INTO outreach_suppressions(email, domain, reason)
           VALUES ($1, split_part($1,'@',2), $2)
           ON CONFLICT (email) DO NOTHING`,
          [email, reason],
        ).catch(e => console.warn('[replies/classify] suppression insert:', e.message))
      }

      // feedback_audit_log_on_mutations T0 — classify is a state-mutating
      // action; write to operator_audit_log so the activity feed stays unified.
      // Best-effort (no rollback on audit failure) — classifier_overrides
      // already captures the primary audit signal for classify actions.
      const auditActor =
        (req.headers['x-operator'] && String(req.headers['x-operator'])) ||
        (req.user && req.user.email) ||
        'operator'
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          'reply_classified',
          auditActor,
          'reply',
          String(result.source === 'reply_inbox' ? result.reply?.id ?? req.params.id : Math.abs(Number(req.params.id))),
          JSON.stringify({ classification, source: result.source }),
        ],
      ).catch(e => console.warn('[replies/classify] op=audit_log.insert failed:', e.message))

      // Shape the response the same way the legacy handler did so the UI
      // doesn't need a separate branch.
      const replyResponse = result.source === 'reply_inbox'
        ? result.reply
        : {
            id: -Number(req.params.id) > 0 ? Number(req.params.id) : Number(req.params.id),
            from_email: result.from_email,
            handled: true,
            handled_at: new Date().toISOString(),
            classification: classification ?? null,
          }
      res.json({ ok: true, reply: replyResponse })
    } catch (e) { cap500(res, e, safeError) }
  })

  // KT-B4 — GET /api/classifier/overrides?days=N
  // Returns recent overrides + a confusion matrix shape so the operator
  // dashboard can render `(LLM-said × operator-said)` cells. `days` clamped
  // to [1, 90] to keep the query bounded; default = 7.
  app.get('/api/classifier/overrides', async (req, res) => {
    try {
      const rawDays = Number.parseInt(String(req.query.days ?? '7'), 10)
      const days =
        Number.isFinite(rawDays) && rawDays > 0
          ? Math.min(rawDays, 90)
          : 7

      const { rows: overrides } = await pool.query(
        `SELECT id, reply_id, original_classification, override_classification, operator, ts
           FROM classifier_overrides
          WHERE ts > now() - ($1::int || ' days')::interval
          ORDER BY ts DESC
          LIMIT 1000`,
        [days],
      )

      // Aggregate into a confusion-matrix shape:
      //   { rows: [{ original, override, count }], total }
      // The UI pivots client-side; keeping the shape flat keeps the BFF
      // payload small even when there are many label combinations.
      const counts = new Map()
      for (const row of overrides) {
        const key = `${row.original_classification ?? 'null'}::${row.override_classification}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      const matrix = Array.from(counts.entries()).map(([key, count]) => {
        const [original, override] = key.split('::')
        return {
          original: original === 'null' ? null : original,
          override,
          count,
        }
      })

      res.json({
        days,
        total: overrides.length,
        overrides,
        confusion_matrix: matrix,
      })
    } catch (e) { cap500(res, e, safeError) }
  })

  // ── Thread messages ───────────────────────────────────────────────────────
  app.get('/api/threads/:id/messages', async (req, res) => {
    try {
      const replyId = req.params.id
      // Negative id = an unmatched (orphan) inbound reply. It has no thread, so
      // return its single incoming message from unmatched_inbound (body from
      // body_html/body_preview). Without this the chat 404'd for orphan replies
      // — exactly the ones that carry the seller photos (RCA 2026-06-01).
      if (Number(replyId) < 0) {
        const { rows: [u] } = await pool.query(
          `SELECT id, from_address, subject, received_at, body_html, body_preview
             FROM unmatched_inbound WHERE id = $1`,
          [-Number(replyId)]
        )
        if (!u) return res.status(404).json({ error: 'not found' })
        return res.json({ messages: [{
          id: `unmatched-${u.id}`,
          type: 'incoming',
          sender: u.from_address,
          subject: u.subject,
          body: u.body_html || u.body_preview || u.subject,
          body_html: u.body_html || null,
          body_text: u.body_preview || null,
          attachments: [],
          sent_at: u.received_at,
        }] })
      }
      const { rows: [reply] } = await pool.query(
        `SELECT r.id, r.send_event_id, r.campaign_id, r.contact_id,
                r.from_email, r.received_at, r.subject,
                r.body_text, r.body_html
         FROM reply_inbox r WHERE r.id=$1`,
        [replyId]
      )
      if (!reply) return res.status(404).json({ error: 'not found' })

      const messages = []

      if (reply.send_event_id) {
        const { rows: sends } = await pool.query(
          // iter62 fix: drop dead joins. `mailboxes` table + se.mailbox_id +
          // se.template_id + se.subject_override + `templates` table do not
          // exist (relation "mailboxes" does not exist → 500 that blanked the
          // whole thread). send_events.mailbox_used IS the sender email and
          // se.subject IS the subject — no joins needed.
          `SELECT se.id, se.step, se.sent_at, se.mailbox_used AS sender_email,
                  COALESCE(se.subject, '') AS subject
           FROM send_events se
           WHERE se.contact_id=$1 AND se.campaign_id=$2
           ORDER BY se.sent_at ASC`,
          [reply.contact_id, reply.campaign_id]
        )

        // send_events does NOT persist the rendered body — only the subject.
        // The body lives in email_templates, keyed by the campaign's
        // sequence_config (step → template name). Resolve it so the outbound
        // bubble shows the message we actually sent. Previously body=subject,
        // so the thread showed only the subject ("Poptávka") with no message.
        // (This is the template body; per-recipient humanized bytes are not
        // stored, so minor variance vs. the exact sent mail is expected.)
        const stepToTemplate = {}
        try {
          const { rows: [camp] } = await pool.query(
            `SELECT sequence_config FROM campaigns WHERE id=$1`, [reply.campaign_id])
          let seq = camp?.sequence_config
          if (typeof seq === 'string') { try { seq = JSON.parse(seq) } catch { seq = null } }
          if (Array.isArray(seq)) {
            for (const st of seq) {
              if (st && Number.isInteger(st.step) && st.template) stepToTemplate[st.step] = st.template
            }
          }
        } catch (e) {
          if (process.env.DEBUG_S21) console.warn('[sequence_config] lookup failed:', e.message)
        }
        const bodyByName = {}
        const tplNames = [...new Set(Object.values(stepToTemplate))]
        if (tplNames.length) {
          try {
            const { rows: tpls } = await pool.query(
              `SELECT name, COALESCE(body, '') AS body
                 FROM email_templates WHERE name = ANY($1::text[])`,
              [tplNames])
            for (const t of tpls) bodyByName[t.name] = t.body
          } catch (e) {
            if (process.env.DEBUG_S21) console.warn('[email_templates body] lookup failed:', e.message)
          }
        }

        for (const s of sends) {
          const tplBody = bodyByName[stepToTemplate[s.step]] || ''
          messages.push({
            id: `send-${s.id}`,
            type: 'auto_send',
            sender: s.sender_email,
            subject: s.subject,
            // Real sent body when resolvable; subject as last-resort fallback so
            // the bubble is never blank (matches the pre-fix behaviour).
            body: tplBody || s.subject,
            body_text: tplBody || null,
            sent_at: s.sent_at,
          })
        }
      }

      // Operator's own manual replies (composed in the dashboard). These sit
      // in manual_reply_outbox until runOutboundReplyCron (Go runner) dispatches
      // them via the relay. Surfacing them here means the operator sees their
      // reply in the thread IMMEDIATELY as an outgoing bubble — pending while
      // the worker hasn't sent it, sent once dispatched, error on failure —
      // instead of staring at a thread that looks unchanged for ~2 min until
      // the IMAP round-trip re-ingests it. Schema-verified columns
      // (manual_reply_outbox): body, reply_inbox_id, sent_at, error, created_at.
      try {
        const { rows: manual } = await pool.query(
          `SELECT id, body, sent_at, error, created_at
             FROM manual_reply_outbox
            WHERE reply_inbox_id = $1
            ORDER BY created_at ASC`,
          [reply.id]
        )
        for (const m of manual) {
          messages.push({
            id: `manual-${m.id}`,
            type: 'manual_reply',
            sender: 'Vy',
            body: m.body,
            sent_at: m.sent_at || m.created_at,
            status: m.sent_at ? 'sent' : (m.error ? 'error' : 'pending'),
            error: m.error || null,
          })
        }
      } catch (e) {
        if (process.env.DEBUG_S21) console.warn('[manual_reply_outbox] join failed:', e.message)
      }

      // S2.1: enrich the inbound entry with full body + attachments from
      // outreach_messages (post-S1.4 schema). Falls back to subject if the
      // mail-client S1 stack hasn't landed yet (legacy reply_inbox-only
      // behavior). The outreach_messages row, if present, was created by
      // the orchestrator's RecordInbound at the time the IMAP poller saw
      // this reply.
      let inbound = {
        id: `reply-${reply.id}`,
        type: 'incoming',
        sender: reply.from_email,
        subject: reply.subject,
        // Canonical body lives in reply_inbox.body_text/body_html (Schema-A).
        // Seed from there so the chat bubble shows real text; the
        // outreach_messages enrichment below only overrides when it has more
        // (it's empty in the Schema-A-only deployment, so this is the source).
        body: reply.subject,
        body_text: reply.body_text || null,
        body_html: reply.body_html || null,
        attachments: [],
        sent_at: reply.received_at,
      }

      // Match outreach_messages by (contact + recently inbound). The
      // received_at <-> replied_at proximity isn't perfect — production
      // schema may eventually add reply_inbox_id FK to outreach_messages.
      // For now this gives correct results when there's at most one
      // inbound from the contact within the same minute (overwhelmingly
      // the case for B2B reply pacing).
      try {
        const { rows: mrows } = await pool.query(
          `SELECT om.id,
                  om.body_preview,
                  COALESCE(om.body_text, NULL) AS body_text,
                  COALESCE(om.body_html, NULL) AS body_html
             FROM outreach_messages om
             JOIN outreach_threads ot ON ot.id = om.thread_id
            WHERE om.direction = 'inbound'
              AND ot.contact_id = $1
              AND om.replied_at BETWEEN $2::timestamptz - INTERVAL '60 seconds'
                                    AND $2::timestamptz + INTERVAL '60 seconds'
            ORDER BY ABS(EXTRACT(EPOCH FROM (om.replied_at - $2::timestamptz)))
            LIMIT 1`,
          [reply.contact_id, reply.received_at]
        )
        if (mrows.length > 0) {
          const om = mrows[0]
          // Pull attachments metadata (no bytea — UI streams via ML S2.2).
          const { rows: arows } = await pool.query(
            `SELECT id, content_id, filename, content_type, size_bytes, is_inline
               FROM message_attachments WHERE message_id = $1
              ORDER BY id`,
            [om.id]
          )
          inbound = {
            ...inbound,
            id: `msg-${om.id}`,
            // Keep the reply_inbox body (seeded above) when outreach_messages
            // has none — never clobber the canonical Schema-A body with null.
            body_text: om.body_text || inbound.body_text,
            body_html: om.body_html ? rewriteCidUris(om.body_html, om.id) : inbound.body_html,
            // body falls back: html → text → preview → reply_inbox body → subject
            body: om.body_html
              ? rewriteCidUris(om.body_html, om.id)
              : (om.body_text || om.body_preview || inbound.body_text || reply.subject),
            attachments: arows.map(a => ({
              id: a.id,
              cid: a.content_id || null,
              filename: a.filename,
              content_type: a.content_type,
              size_bytes: a.size_bytes,
              is_inline: a.is_inline,
            })),
          }
        }
      } catch (e) {
        // Schema migration 012/013 not applied yet → query fails on
        // unknown columns. Swallow and continue with legacy subject body
        // so the dashboard keeps working pre-migration.
        if (process.env.DEBUG_S21) {
          console.warn('[s2.1 enrich] outreach_messages join failed:', e.message)
        }
      }

      messages.push(inbound)
      messages.sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at))
      res.json({ messages })
    } catch (e) { cap500(res, e, safeError) }
  })

  // ── Leads — moved to leads.js ─────────────────────────────────────────────
  // GET /api/leads and PATCH /api/leads/:id now live in
  // src/server-routes/leads.js (mounted before this module in server.js).
  // leads.js is a strict superset (adds POST /api/leads, sentiment/limit
  // filters, assigned_to updates, status validation, richer SELECT columns),
  // so it fully covers the routes that used to be declared here. The duplicate
  // fallback declarations were removed: they shadowed nothing in production and
  // only registered dead routes that tripped the api-route-inventory
  // duplicate-route contract.

  // ── Operator approval queue ───────────────────────────────────────────────
  app.get('/api/operator/queue', async (req, res) => {
    setRouteTags({ 'operator.action': 'queue.list' })
    try {
      const limit = Math.min(Number(req.query.limit || 50), 200)
      const offset = Number(req.query.offset || 0)
      // Pending = no operator decision yet. Sort low-confidence first so
      // the operator's first action lands on the riskiest draft. Confidence
      // can be NULL (LLM didn't return it) — those bubble to the top via
      // NULLS FIRST so they get human review before the higher-trust ones.
      const { rows } = await pool.query(
        `SELECT a.id                AS suggestion_id,
                a.thread_id,
                a.ai_suggestion,
                a.confidence_score,
                a.occurred_at,
                a.details,
                t.contact_id,
                t.campaign_id,
                c.email             AS contact_email,
                TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name,
                co.id               AS company_id,
                co.name             AS company_name,
                co.ico              AS company_ico
           FROM ai_suggestion_audit a
           LEFT JOIN outreach_threads t ON t.id = a.thread_id
           LEFT JOIN contacts        c ON c.id = t.contact_id
           LEFT JOIN companies      co ON co.ico = NULLIF(c.ico, '')
          WHERE a.operator_action = 'pending'
          ORDER BY a.confidence_score ASC NULLS FIRST, a.occurred_at ASC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      )
      const { rows: [{ total }] } = await pool.query(
        `SELECT COUNT(*)::int AS total
           FROM ai_suggestion_audit
          WHERE operator_action = 'pending'`
      )
      res.json({
        suggestions: rows.map(r => ({
          suggestion_id: r.suggestion_id,
          thread_id: r.thread_id,
          company_id: r.company_id,
          company_name: r.company_name,
          company_ico: r.company_ico,
          contact_id: r.contact_id,
          contact_email: r.contact_email,
          contact_name: r.contact_name || null,
          ai_suggestion: r.ai_suggestion,
          confidence_score: r.confidence_score == null ? null : Number(r.confidence_score),
          occurred_at: r.occurred_at,
          details: r.details || {},
        })),
        total,
        limit,
        offset,
      })
    } catch (e) { cap500(res, e, safeError) }
  })

  app.get('/api/operator/queue/:suggestionId', async (req, res) => {
    setRouteTags({ 'operator.action': 'queue.detail' })
    try {
      const id = Number(req.params.suggestionId)
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Neplatné ID návrhu.' })
      }
      const { rows: [s] } = await pool.query(
        `SELECT a.id              AS suggestion_id,
                a.thread_id,
                a.ai_suggestion,
                a.operator_action,
                a.final_output,
                a.confidence_score,
                a.occurred_at,
                a.details,
                t.contact_id,
                t.campaign_id,
                t.status          AS thread_status,
                c.email           AS contact_email,
                TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS contact_name,
                co.id             AS company_id,
                co.name           AS company_name,
                co.ico            AS company_ico,
                cmp.name          AS campaign_name
           FROM ai_suggestion_audit a
           LEFT JOIN outreach_threads t  ON t.id = a.thread_id
           LEFT JOIN contacts         c  ON c.id = t.contact_id
           LEFT JOIN companies       co  ON co.ico = NULLIF(c.ico, '')
           LEFT JOIN campaigns      cmp  ON cmp.id = t.campaign_id
          WHERE a.id = $1`,
        [id]
      )
      if (!s) return res.status(404).json({ error: 'Návrh nenalezen.' })

      // Pull the most recent inbound message on this thread so the operator
      // can read the reply they're answering. Best-effort: schemas vary
      // (post-S1.4 outreach_messages columns may not exist on a fresh dev DB).
      let lastInbound = null
      if (s.thread_id) {
        try {
          const { rows: msgs } = await pool.query(
            `SELECT id, body_text, body_html, body_preview, replied_at
               FROM outreach_messages
              WHERE thread_id = $1 AND direction = 'inbound'
              ORDER BY replied_at DESC NULLS LAST, id DESC
              LIMIT 1`,
            [s.thread_id]
          )
          if (msgs.length) {
            const m = msgs[0]
            lastInbound = {
              id: m.id,
              body_text: m.body_text || null,
              body_html: m.body_html || null,
              body_preview: m.body_preview || null,
              replied_at: m.replied_at || null,
            }
          }
        } catch (_e) { /* schema variance — leave null */ }
      }

      res.json({
        suggestion: {
          suggestion_id: s.suggestion_id,
          thread_id: s.thread_id,
          contact_id: s.contact_id,
          campaign_id: s.campaign_id,
          company_id: s.company_id,
          company_name: s.company_name,
          company_ico: s.company_ico,
          contact_email: s.contact_email,
          contact_name: s.contact_name || null,
          campaign_name: s.campaign_name || null,
          thread_status: s.thread_status || null,
          ai_suggestion: s.ai_suggestion,
          // Operator UI uses preview/body fallback; surface ai_suggestion as both.
          body: s.ai_suggestion,
          preview: s.ai_suggestion,
          operator_action: s.operator_action,
          final_output: s.final_output,
          confidence_score: s.confidence_score == null ? null : Number(s.confidence_score),
          occurred_at: s.occurred_at,
          drafted_at: s.occurred_at,
          details: s.details || {},
        },
        last_inbound: lastInbound,
      })
    } catch (e) { cap500(res, e, safeError) }
  })

  app.post('/api/operator/approve', async (req, res) => {
    setRouteTags({ 'operator.action': 'approve' })
    try {
      const body = req.body || {}
      const id = Number(body.suggestion_id)
      const action = String(body.action || '').toLowerCase()
      const finalOutput = body.final_output == null ? null : String(body.final_output)
      const operatorId = (req.headers['x-operator'] && String(req.headers['x-operator']))
        || (req.user && req.user.email)
        || 'operator'

      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'Pole suggestion_id je povinné.' })
      }
      if (!OPERATOR_ACTIONS_TERMINAL.has(action)) {
        return res.status(400).json({
          error: 'Neplatná akce. Povolené: approved | edited | rejected.',
        })
      }
      // edit must carry the final_output (operator-rewritten text); approve
      // requires final_output too because the queue UI ships the (possibly
      // unchanged) draft body as final_output. reject must NOT carry one.
      if (action === 'edited' && (!finalOutput || !finalOutput.trim())) {
        return res.status(400).json({ error: 'Pole final_output je povinné při akci edited.' })
      }
      if (action === 'approved' && (!finalOutput || !finalOutput.trim())) {
        return res.status(400).json({ error: 'Pole final_output je povinné při akci approved.' })
      }
      if (action === 'rejected' && finalOutput) {
        return res.status(400).json({ error: 'Pole final_output není povoleno při akci rejected.' })
      }

      const { rows: [pre] } = await pool.query(
        `SELECT id, operator_action FROM ai_suggestion_audit WHERE id = $1`,
        [id]
      )
      if (!pre) return res.status(404).json({ error: 'Návrh nenalezen.' })
      if (pre.operator_action !== 'pending') {
        return res.status(409).json({
          error: 'Návrh už byl rozhodnut.',
          operator_action: pre.operator_action,
        })
      }

      const { rows: [updated] } = await pool.query(
        `UPDATE ai_suggestion_audit
            SET operator_action = $1,
                final_output    = $2,
                operator_id     = $3,
                details         = COALESCE(details, '{}'::jsonb)
                                   || jsonb_build_object('decided_at', now())
          WHERE id = $4
          RETURNING id, thread_id, operator_action, final_output, operator_id, occurred_at`,
        [action, action === 'rejected' ? null : finalOutput, operatorId, id]
      )

      // Audit trail — operator_audit_log mirrors the decision so the per-
      // operator activity feed stays unified across reply-classify + approve.
      await pool.query(
        `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
         VALUES ('ai_suggestion_decided', $1, 'ai_suggestion', $2, $3::jsonb)`,
        [
          operatorId,
          String(id),
          JSON.stringify({
            operator_action: action,
            thread_id: updated.thread_id,
            had_final_output: !!finalOutput,
          }),
        ]
      ).catch(() => {})

      res.json({
        ok: true,
        suggestion: {
          suggestion_id: updated.id,
          thread_id: updated.thread_id,
          operator_action: updated.operator_action,
          final_output: updated.final_output,
          operator_id: updated.operator_id,
          occurred_at: updated.occurred_at,
        },
      })
    } catch (e) { cap500(res, e, safeError) }
  })

  // ── Company timeline ──────────────────────────────────────────────────────
  app.get('/api/companies/:id/timeline', async (req, res) => {
    setRouteTags({ 'companies.action': 'timeline' })
    try {
      const idRaw = String(req.params.id || '').trim()
      if (!idRaw) return res.status(400).json({ error: 'ID firmy je povinné.' })

      // ── Pagination params ────────────────────────────────────────────────
      // limit: default 50, max 200 (clamped server-side).
      // before: ISO timestamp cursor — return events strictly before this time.
      //         Tie-breaker appended as "<ISO>_<event_id>"; UI must pass the
      //         next_cursor value verbatim.
      // event_types: comma-separated subset of send,reply,bounce,open,click,
      //              inbound,ai_draft.  Default = all.
      const VALID_TYPES = new Set(['send', 'reply', 'bounce', 'open', 'click', 'inbound', 'ai_draft', 'outbound'])
      const DEFAULT_LIMIT = 50
      const MAX_LIMIT = 200

      const rawLimit = Number(req.query.limit ?? DEFAULT_LIMIT)
      if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
        return res.status(400).json({ error: 'Parametr limit musí být kladné číslo.' })
      }
      const limit = clampInt(Math.floor(rawLimit), 1, MAX_LIMIT)

      // Decode before cursor: "<ISO timestamp>_<event_id>"
      let beforeTs = null
      let beforeId = null
      const rawBefore = req.query.before ? String(req.query.before) : null
      if (rawBefore) {
        const sepIdx = rawBefore.lastIndexOf('_')
        const tsPart = sepIdx > 0 ? rawBefore.slice(0, sepIdx) : rawBefore
        const idPart = sepIdx > 0 ? rawBefore.slice(sepIdx + 1) : null
        beforeTs = new Date(tsPart)
        if (isNaN(beforeTs.getTime())) {
          return res.status(400).json({ error: 'Neplatný kurzor before.' })
        }
        beforeId = idPart ? String(idPart) : null
      }

      // event_types filter — normalise aliases
      const TYPE_ALIAS = { send: 'outbound', reply: 'inbound', bounce: 'outbound', open: 'outbound', click: 'outbound' }
      let allowedKinds = null  // null = all
      if (req.query.event_types) {
        const requested = String(req.query.event_types).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        const resolved = new Set(requested.map(t => TYPE_ALIAS[t] || t).filter(k => VALID_TYPES.has(k)))
        if (resolved.size === 0) {
          return res.status(400).json({ error: 'Neplatné hodnoty event_types.' })
        }
        allowedKinds = resolved
      }

      // ── Company lookup ───────────────────────────────────────────────────
      // Accept either numeric companies.id or the IČO string. companies.ico is
      // the public/business identifier and is what UI links use today; the
      // numeric id is the FK target. Resolve to the company row first so a
      // missing company yields 404 cleanly.
      const isNumeric = /^\d+$/.test(idRaw)
      const { rows: [company] } = await pool.query(
        isNumeric
          ? `SELECT id, name, ico FROM companies WHERE id = $1 OR ico = $1::text LIMIT 1`
          : `SELECT id, name, ico FROM companies WHERE ico = $1 LIMIT 1`,
        [idRaw]
      )
      if (!company) return res.status(404).json({ error: 'Firma nenalezena.' })

      // Map company → contacts (no company_id FK; contacts.ico links via IČO).
      const { rows: contactRows } = await pool.query(
        `SELECT id FROM contacts WHERE NULLIF(ico,'') = $1`,
        [company.ico || '']
      )
      const contactIds = contactRows.map(r => r.id)

      if (contactIds.length === 0) {
        return res.json({
          company: { id: company.id, name: company.name, ico: company.ico },
          messages: [],
          total: 0,
          next_cursor: null,
        })
      }

      // ── Data fetch — three parallel queries, each bounded by limit+1 ────
      // Fetching limit+1 from each source and then trimming after merge lets
      // us detect whether a next page exists without a separate COUNT query.
      // Single SELECT per source — no per-event sub-queries.
      const fetchLimit = limit + 1

      // Build cursor filter snippet (same logic for all three tables).
      // We use (ts, id) < (before_ts, before_id) for a stable tie-breaker.
      // When beforeTs is null (first page) we skip the filter entirely.
      function buildCursorWhere(tsCol, idColExpr, existingParams) {
        if (!beforeTs) return { clause: '', params: existingParams }
        const p = [...existingParams]
        const pTs = p.length + 1
        p.push(beforeTs.toISOString())
        if (beforeId) {
          const pId = p.length + 1
          p.push(beforeId)
          // Events at exactly beforeTs with an id < beforeId are excluded to
          // avoid page overlap on ties.
          const clause = `AND (${tsCol} < $${pTs} OR (${tsCol} = $${pTs} AND ${idColExpr} < $${pId}))`
          return { clause, params: p }
        }
        return { clause: `AND ${tsCol} < $${pTs}`, params: p }
      }

      // Determine which sub-queries to run based on event_types filter.
      const wantOutbound = !allowedKinds || allowedKinds.has('outbound')
      const wantInbound  = !allowedKinds || allowedKinds.has('inbound')
      const wantAiDraft  = !allowedKinds || allowedKinds.has('ai_draft')

      const outCursor = wantOutbound
        ? buildCursorWhere('se.sent_at', "('send-' || se.id::text)", [contactIds, fetchLimit])
        : null
      const inCursor = wantInbound
        ? buildCursorWhere('om.replied_at', "('inbound-' || om.id::text)", [contactIds, fetchLimit])
        : null
      const aiCursor = wantAiDraft
        ? buildCursorWhere('a.occurred_at', "('ai-' || a.id::text)", [contactIds, fetchLimit])
        : null

      const [outRes, inRes, aiRes] = await Promise.all([
        wantOutbound ? pool.query(
          // iter62 fix: drop dead `templates`/`mailboxes` joins + nonexistent
          // se.template_id/se.subject_override columns. se.subject + se.mailbox_used
          // carry the data directly; outbound body isn't stored per-send so
          // body_preview is empty (the subject is the operator-visible line).
          `SELECT se.id,
                  se.sent_at,
                  COALESCE(se.subject, '') AS subject,
                  ''::text                 AS body_preview,
                  cmp.name AS campaign_name,
                  se.mailbox_used AS sender_email
             FROM send_events se
             LEFT JOIN campaigns cmp ON cmp.id = se.campaign_id
            WHERE se.contact_id = ANY($1::int[])
              AND se.status IN ('sent','opened','replied','bounced')
              ${outCursor.clause}
            ORDER BY se.sent_at DESC
            LIMIT $2`,
          outCursor.params
        ).catch(() => ({ rows: [] })) : { rows: [] },

        wantInbound ? pool.query(
          `SELECT om.id,
                  om.replied_at,
                  om.body_text,
                  om.body_html,
                  om.body_preview,
                  ot.id AS thread_id
             FROM outreach_messages om
             JOIN outreach_threads ot ON ot.id = om.thread_id
            WHERE ot.contact_id = ANY($1::int[])
              AND om.direction  = 'inbound'
              ${inCursor.clause}
            ORDER BY om.replied_at DESC
            LIMIT $2`,
          inCursor.params
        ).catch(() => ({ rows: [] })) : { rows: [] },

        wantAiDraft ? pool.query(
          `SELECT a.id,
                  a.thread_id,
                  a.ai_suggestion,
                  a.operator_action,
                  a.final_output,
                  a.occurred_at,
                  a.confidence_score
             FROM ai_suggestion_audit a
             JOIN outreach_threads ot ON ot.id = a.thread_id
            WHERE ot.contact_id = ANY($1::int[])
              ${aiCursor.clause}
            ORDER BY a.occurred_at DESC
            LIMIT $2`,
          aiCursor.params
        ).catch(() => ({ rows: [] })) : { rows: [] },
      ])

      // ── Build unified message list ───────────────────────────────────────
      const messages = []
      for (const r of outRes.rows) {
        messages.push({
          id: `send-${r.id}`,
          kind: 'outbound',
          sender: r.sender_email || null,
          subject: r.subject || null,
          body: r.body_preview || null,
          sent_at: r.sent_at,
          campaign_name: r.campaign_name || null,
        })
      }
      for (const r of inRes.rows) {
        messages.push({
          id: `inbound-${r.id}`,
          kind: 'inbound',
          sender: null,
          subject: null,
          body: r.body_text || r.body_preview || null,
          body_html: r.body_html || null,
          sent_at: r.replied_at,
          thread_id: r.thread_id,
        })
      }
      for (const r of aiRes.rows) {
        messages.push({
          id: `ai-${r.id}`,
          kind: 'ai_draft',
          sender: 'ai',
          body: r.final_output || r.ai_suggestion,
          sent_at: r.occurred_at,
          thread_id: r.thread_id,
          suggestion_id: r.id,
          operator_action: r.operator_action,
          confidence_score: r.confidence_score == null ? null : Number(r.confidence_score),
        })
      }

      // Sort DESC (newest first) to match cursor direction, then take limit.
      messages.sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))

      const hasMore = messages.length > limit
      const page = messages.slice(0, limit)

      // Reverse to present chronological ASC to the UI client.
      page.reverse()

      // next_cursor: timestamp of the OLDEST message on this page (i.e. the
      // first element after reversal) + tie-breaker id.  UI passes this as
      // ?before= to load the previous (older) page.
      let next_cursor = null
      if (hasMore && page.length > 0) {
        const oldest = page[0]
        next_cursor = `${oldest.sent_at}_${oldest.id}`
      }

      res.json({
        company: { id: company.id, name: company.name, ico: company.ico },
        messages: page,
        total: page.length,
        next_cursor,
      })
    } catch (e) { cap500(res, e, safeError) }
  })
}
// test comment
