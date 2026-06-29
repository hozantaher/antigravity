import { processImapReplies, shouldSuppress } from '../lib/automation.js'
import { relayImapFetch } from '../lib/relayClient.js'
import { checkAndRecord as checkOpRateLimit } from '../lib/mailboxOpRateLimit.js'
import { recordAuthFail } from '../lib/mailboxAuthFailGuard.js'
import { semanticClassifyReply } from '../lib/llmReplyClassifier.js'

/**
 * runImapPollCron — poll IMAP via relay, ingest replies, classify, AI-draft.
 *
 * Scope deps passed as args:
 *   @param {pg.Pool} pool
 *   @param {object} deps
 *   @param {object} deps.Sentry                    — Sentry instance from server.js
 *   @param {Function} deps.generateAiSuggestionForReply — server.js-local async helper
 */
export async function runImapPollCron(pool, { Sentry, generateAiSuggestionForReply }) {
  // Sprint AO4 (post nowak.gorak fraud-lock 2026-05-08): localhost dev mode
  // adds CZ residential IP to mailbox login surface, contributing to
  // multi-country same-account login pattern that triggered Seznam fraud
  // detection. Refuse to run from local development environment unless
  // operator explicitly opts in via DISABLE_IMAP_CRON=0 (production
  // overrides default-skip via NODE_ENV=production).
  if (process.env.NODE_ENV !== 'production' && process.env.DISABLE_IMAP_CRON !== '0') {
    console.log('[cron] runImapPollCron SKIPPED (NODE_ENV != production; set DISABLE_IMAP_CRON=0 to override in dev)')
    return
  }
  console.log('[cron] runImapPollCron start')
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.from_address, m.imap_host, m.imap_port, m.imap_username, m.smtp_username, m.password,
              m.preferred_country,
              COALESCE(s.unseen, 0) AS prev_unseen,
              s.last_processed_uid AS prev_uid,
              s.uid_validity AS prev_uid_validity
       FROM outreach_mailboxes m
       LEFT JOIN mailbox_imap_state s ON s.mailbox_id=m.id
       WHERE m.status NOT IN ('retired', 'auth_locked')
         AND m.environment = 'production'
         AND m.imap_host IS NOT NULL`
    )
    for (const row of rows) {
      try {
        // IMAP circuit breaker — skip if circuit is open
        const { rows: circuit } = await pool.query(
          `SELECT fail_count, open_until FROM mailbox_imap_circuit WHERE mailbox_id=$1`,
          [row.id]
        )
        const circuitRow = circuit[0]
        if (circuitRow?.open_until && new Date(circuitRow.open_until) > new Date()) {
          console.log(`[imap] circuit open for mailbox ${row.id}, skipping until ${circuitRow.open_until}`)
          continue
        }

        // AP3 rate limit: max 4 imap_poll per mailbox per hour
        const imapRl = await checkOpRateLimit(pool, row.id, 'imap_poll')
        if (!imapRl.allowed) {
          console.log(`[imap] rate_limit mailbox ${row.id}: imap_poll ${imapRl.used}/${imapRl.max} — skip, retryAfterSec=${imapRl.retryAfterSec}`)
          continue
        }

        const username = row.imap_username || row.smtp_username
        const port = Number(row.imap_port) || 993

        // 2026-05-12: switched from BFF-side dialIMAPViaSOCKS5 to
        // relay POST /v1/imap-fetch. The relay container owns the only
        // working wgsocks transport (loopback-bound); BFF can't reach it
        // cross-service. Relay receives creds + UID watermark, runs
        // LOGIN/SELECT/UID SEARCH/UID FETCH internally, returns parsed
        // headers. Memory project_bff_imap_cross_service_broken + commit
        // 65ea5f3c (services/relay/internal/delivery/imap_fetch.go).
        const watermarkForRelay = (row.prev_uid_validity != null && row.prev_uid != null)
          ? Number(row.prev_uid)
          : 0
        const fetchRes = await relayImapFetch(pool, {
          mailboxAddress:   row.from_address,
          imapHost:         row.imap_host,
          imapPort:         port,
          username,
          password:         row.password,
          folder:           'INBOX',
          sinceUid:         watermarkForRelay,
          // include_body=true is heavy (raw RFC 5322 per msg) but
          // required so orchestrator's MIME parser + attachment
          // extractor can run. Sprint 1.3: BFF forwards raw bytes to
          // orchestrator /api/inbound for canonical thread persistence.
          // Relay caps limit at 30 when body is requested.
          includeBody:      true,
          limit:            30,
          preferredCountry: row.preferred_country || 'CZ',
        })

        if (!fetchRes.ok) {
          // Relay-side failure (network, TLS, IMAP NO/BAD). Caller-loop
          // shouldn't open the circuit on transient relay errors — the
          // BFF circuit was for direct-dial failures, and relay has its
          // own retries. Log + move on.
          console.log(`[imap] mailbox ${row.id} relay fetch failed: ${fetchRes.error}`)
          continue
        }

        const messages = fetchRes.messages || []
        const uidValidity = fetchRes.uid_validity || null
        const unseen = fetchRes.unseen_total || 0

        // UIDVALIDITY change detection: relay returns the current value;
        // if it differs from our last stored value, reset the watermark
        // semantics for healing audit (relay already returned only the
        // post-change UIDs because we passed since_uid=0 when validity
        // wasn't known, but we still want to log the change).
        //
        // P0 incident 2026-05-14: pg driver returns `bigint` columns as
        // strings (e.g. "1") while relay returns JSON number (1). Strict
        // !== fired on every poll, producing a false healing_log row +
        // log line that drowned out real signal. Normalise to BigInt so
        // the equality check is value-correct across types.
        const normalizeUidValidity = (v) => {
          if (v == null) return null
          try { return BigInt(v) } catch { return null }
        }
        const prevValidityNorm = normalizeUidValidity(row.prev_uid_validity)
        const currValidityNorm = normalizeUidValidity(uidValidity)
        const validityChanged = prevValidityNorm != null && currValidityNorm != null
          && prevValidityNorm !== currValidityNorm

        // Highest UID seen in this batch — the candidate new watermark.
        const highestUid = messages.length > 0
          ? Math.max(...messages.map(m => Number(m.uid) || 0))
          : (row.prev_uid || null)

        // Watermark-advance gate. mailbox_imap_state is persisted at the END of
        // this iteration (after ingestion), and last_processed_uid is held at
        // the previous value if any reply_inbox INSERT below fails — so a
        // failure can't advance the watermark past an un-persisted reply and
        // lose it. prevUidNum is that fallback (the current watermark).
        const prevUidNum = row.prev_uid != null ? Number(row.prev_uid) : 0
        let replyPersistFailed = false

        if (validityChanged) {
          console.log(`[imap] mailbox ${row.id} UIDVALIDITY changed (${row.prev_uid_validity} → ${uidValidity}), reprocessing all unseen`)
          await pool.query(
            `INSERT INTO healing_log(entity_type, entity_id, entity_label, action, reason)
             VALUES('mailbox', $1, $2, 'uid_validity_change', $3)`,
            [String(row.id), row.from_address, `${row.prev_uid_validity} → ${uidValidity}`]
          ).catch(() => {})
        }

        if (messages.length > 0) {
          // Sprint 1.3 — forward each raw message to orchestrator
          // /api/inbound so it lands in outreach_messages + attachments
          // via the canonical thread.InboundProcessor pipeline. Failures
          // here don't block the legacy reply_inbox INSERT below (kept
          // as fallback during rollout).
          const goUrl = process.env.GO_SERVER_URL || 'http://localhost:8080'
          const goKey = process.env.OUTREACH_API_KEY || ''
          if (goUrl && goKey) {
            for (const m of messages) {
              if (!m.raw_body) continue
              try {
                const r = await fetch(`${goUrl.replace(/\/$/, '')}/api/inbound`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-API-Key': goKey },
                  body: JSON.stringify({
                    mailbox_address: row.from_address,
                    raw_body:        m.raw_body,           // base64 over JSON
                    received_at:     m.date || null,
                    message_id:      m.message_id || '',
                    in_reply_to:     m.in_reply_to || '',
                    from:            m.from || '',
                    subject:         m.subject || '',
                  }),
                  signal: AbortSignal.timeout(35_000),
                })
                if (!r.ok) {
                  const t = await r.text().catch(() => '')
                  console.warn(`[inbound] mailbox ${row.id} msg ${m.uid} orchestrator ${r.status}: ${t.slice(0, 200)}`)
                  // P0 incident 2026-05-14: silent inbound POST failures
                  // (cross-service DNS or 5xx) left operators chasing a
                  // ghost — the console.warn was the only signal. Surface
                  // non-2xx to Sentry so degraded ingestion is visible
                  // alongside other operator alerts.
                  Sentry.captureMessage(`inbound POST non-2xx: orchestrator ${r.status}`, {
                    level: 'warning',
                    tags: { component: 'imap-poll', mailbox_id: String(row.id), status: String(r.status) },
                    extra: { uid: m.uid, body_preview: t.slice(0, 200) },
                  })
                }
              } catch (e) {
                console.warn(`[inbound] mailbox ${row.id} msg ${m.uid} orchestrator POST failed: ${e?.message}`)
                // P0 incident 2026-05-14: transport-level failures (ENOTFOUND,
                // ECONNREFUSED, AbortSignal timeout) need to escalate to Sentry
                // — they're indistinguishable from "no replies yet" otherwise.
                Sentry.captureException(e, {
                  tags: { component: 'imap-poll', mailbox_id: String(row.id), phase: 'inbound_post' },
                  extra: { uid: m.uid },
                })
              }
            }
          }

          if (messages.length) {
            const { rows: seRows } = await pool.query(
              `SELECT se.id, se.contact_id AS "contactId", c.email AS "contactEmail"
               FROM send_events se
               JOIN contacts c ON c.id=se.contact_id
               WHERE se.mailbox_used=$1
               ORDER BY se.sent_at DESC LIMIT 200`,
              [row.from_address]
            )
            const decisions = processImapReplies(messages, seRows)
            for (const d of decisions) {
              await pool.query(
                `UPDATE send_events SET reply_classification=$1 WHERE id=$2`,
                [d.classification, d.sendEventId]
              ).catch(() => {})
              try {
                await pool.query(
                  `INSERT INTO reply_inbox(send_event_id, campaign_id, contact_id, mailbox_id, from_email, subject, classification)
                   SELECT $1, se.campaign_id, $2, $3, $4, $5, $6
                   FROM send_events se WHERE se.id=$1
                   ON CONFLICT (send_event_id) DO NOTHING`,
                  [d.sendEventId, d.contactId, row.id, d.fromAddr || '', d.subject || '', d.classification]
                )
              } catch (replyErr) {
                // Do NOT swallow: a failed reply_inbox INSERT means this reply
                // is not persisted yet. Flag it so the watermark is held below
                // this batch and the next poll re-fetches + re-ingests (the
                // INSERT is idempotent via ON CONFLICT(send_event_id) DO NOTHING).
                replyPersistFailed = true
                console.error(`[cron] imap-reply reply_inbox INSERT failed mailbox=${row.id} send_event=${d.sendEventId}:`, replyErr.message)
                Sentry.captureException(replyErr, {
                  tags: { component: 'imap-poll', mailbox_id: String(row.id), phase: 'reply_inbox_insert' },
                  extra: { send_event_id: d.sendEventId, contact_id: d.contactId },
                })
              }

              // Track B (M+3) — reply→AI suggestion pipeline. Resolve the
              // campaign_id for this contact's send_event so the LLM gets
              // accurate context. Skip auto_reply / ooo: an out-of-office
              // bounce doesn't deserve a draft. Failures are swallowed —
              // pipeline must never block IMAP ingestion (fail-open).
              if (d.classification !== 'ooo' && d.classification !== 'auto_reply') {
                const { rows: seRowForCampaign } = await pool.query(
                  `SELECT campaign_id FROM send_events WHERE id = $1`,
                  [d.sendEventId]
                ).catch(() => ({ rows: [] }))
                const campaignIdForLlm = seRowForCampaign[0]?.campaign_id || null
                if (campaignIdForLlm) {
                  await generateAiSuggestionForReply({
                    contactId: d.contactId,
                    campaignId: campaignIdForLlm,
                    fromAddr: d.fromAddr || '',
                    subject: d.subject || '',
                  }).catch(e => console.warn('[ai-suggestion] pipeline error:', e?.message))
                }
              }

              // S1.1: operator notification on actionable replies. OOO is
              // noise (auto-vacation responders); skip those. Everything
              // else (positive/negative/question/unknown) gets a Sentry
              // breadcrumb so ops sees new replies in the issue stream
              // without having to poll the dashboard.
              if (d.classification !== 'ooo') {
                Sentry.captureMessage(
                  `New reply: ${d.classification} from ${d.fromAddr || '?'}`,
                  {
                    level: d.classification === 'positive' || d.classification === 'interested' ? 'info' : 'warning',
                    tags: {
                      component: 'reply-classifier',
                      classification: d.classification,
                      mailbox_id: String(row.id),
                    },
                    extra: {
                      send_event_id: d.sendEventId,
                      contact_id: d.contactId,
                      subject: d.subject,
                      from_email: d.fromAddr,
                    },
                  }
                )
              }
              if (d.classification === 'negative') {
                await pool.query(`UPDATE contacts SET status='replied_negative' WHERE id=$1`, [d.contactId]).catch(() => {})
              } else if (d.classification === 'positive') {
                await pool.query(`UPDATE contacts SET status='replied_positive' WHERE id=$1`, [d.contactId]).catch(() => {})
              } else if (d.classification === 'auto_reply') {
                await pool.query(`UPDATE contacts SET status='auto_reply' WHERE id=$1`, [d.contactId]).catch(() => {})
              }
              if (shouldSuppress(d.classification)) {
                const { rows: contactRows } = await pool.query(
                  'SELECT email FROM contacts WHERE id=$1', [d.contactId]
                ).catch(() => ({ rows: [] }))
                if (contactRows[0]?.email) {
                  await pool.query(
                    `INSERT INTO suppression_list(email, reason, mailbox_id, contact_id)
                     VALUES($1,'negative_reply',$2,$3) ON CONFLICT(email) DO NOTHING`,
                    [contactRows[0].email, row.id, d.contactId]
                  ).catch(() => {})
                  console.log(`[automation] suppressed contact_id=${d.contactId} (negative reply)`)  // email redacted per PII policy
                }
              }

              // S19 + BF-D3 — semantic reply classification.
              // Primary: LLM (Ollama) with confidence + alternatives.
              // Fallback: regex when LLM disabled / unreachable / low confidence.
              // Vocabulary mapping: LLM uses {positive, negative, auto_reply,
              // question, unknown}; regex fallback uses {negative, ooo,
              // interested, question, unknown}. Side-effect branches below
              // accept both vocabularies (positive ≈ interested, auto_reply ≈ ooo).
              const bodyText = d.subject || ''
              const semantic = await semanticClassifyReply(bodyText, d.subject)
              const bodyClass = semantic.label
              // Audit the classifier decision so ops can debug LLM accuracy
              // over time without scraping logs.
              if (semantic.source === 'llm' && (bodyClass === 'positive' || bodyClass === 'negative')) {
                await pool.query(
                  `INSERT INTO operator_audit_log(action, actor, entity_type, entity_id, details)
                   VALUES('reply_classified', $1, 'reply', $2, $3::jsonb)`,
                  [
                    `llm:${semantic.provider || 'ollama'}`,
                    String(d.sendEventId),
                    JSON.stringify({
                      label: bodyClass,
                      confidence: semantic.confidence,
                      alternatives: semantic.alternatives,
                      model: semantic.model,
                      latencyMs: semantic.latencyMs,
                    }),
                  ]
                ).catch(() => {})
              }
              if (bodyClass === 'negative') {
                // Blacklist contact immediately
                await pool.query(
                  `UPDATE contacts SET status='blacklisted', updated_at=now() WHERE id=$1`,
                  [d.contactId]
                ).catch(() => {})
                console.log(`[imap-classify] contact ${d.contactId} → blacklisted (negative reply)`)
              } else if (bodyClass === 'ooo' || bodyClass === 'auto_reply') {
                // Out of office — record in healing_log for visibility; sequence resume handled by scheduler
                await pool.query(
                  `INSERT INTO healing_log(entity_type, entity_id, entity_label, action, reason)
                   VALUES('contact', $1, $2, 'ooo_detected', 'IMAP auto-classify: out-of-office reply')`,
                  [d.contactId, d.fromAddr || '']
                ).catch(() => {})
                console.log(`[imap-classify] contact ${d.contactId} → OOO detected, healing_log entry created`)
              } else if (bodyClass === 'interested' || bodyClass === 'positive') {
                // Insert alert for operator
                await pool.query(
                  `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message)
                   VALUES($1, 'interested_reply', 'info', $2)`,
                  [row.id, `Interested reply from contact ${d.contactId} (${d.fromAddr || ''})`]
                ).catch(() => {})
                console.log(`[imap-classify] contact ${d.contactId} → interested, alert created`)
              }

              console.log(`[cron] imap-reply mailbox=${row.id} contact=${d.contactId} → ${d.classification}`)
            }
          }
        }

        // Persist IMAP state AFTER ingestion. Advance last_processed_uid to the
        // highest fetched UID only if every reply persisted this cycle;
        // otherwise hold it at the previous watermark so un-persisted replies
        // are re-fetched next poll. prev_unseen kept for backward-compat
        // visibility (operator dashboards may still display it).
        const persistUid = replyPersistFailed ? prevUidNum : highestUid
        await pool.query(
          `INSERT INTO mailbox_imap_state(mailbox_id, unseen, prev_unseen, last_processed_uid, uid_validity, polled_at)
           VALUES($1, $2, $3, $4, $5, now())
           ON CONFLICT(mailbox_id) DO UPDATE
             SET prev_unseen=mailbox_imap_state.unseen,
                 unseen=$2,
                 last_processed_uid=GREATEST(COALESCE(mailbox_imap_state.last_processed_uid, 0), COALESCE($4, 0)),
                 uid_validity=$5,
                 polled_at=now()`,
          [row.id, unseen, row.prev_unseen, persistUid, uidValidity]
        )

        // Reset IMAP circuit on success
        await pool.query(
          `INSERT INTO mailbox_imap_circuit(mailbox_id, fail_count, open_until, updated_at) VALUES($1, 0, NULL, now())
           ON CONFLICT(mailbox_id) DO UPDATE SET fail_count=0, open_until=NULL, updated_at=now()`,
          [row.id]
        )
      } catch (e) {
        console.error(`[cron] imap-poll ${row.id}:`, e.message)
        // AP6: IMAP auth fail detection → auto-quarantine
        const isImapAuthFail = /auth fail|login fail|authentication fail|A1 NO|invalid credential/i.test(e.message)
        if (isImapAuthFail) {
          recordAuthFail(pool, row.id, 'imap_poll', e.message, 'imap_cron').then(r => {
            if (r.quarantined) {
              pool.query(
                `INSERT INTO mailbox_alerts(mailbox_id, type, severity, message) VALUES($1,'auth_locked','critical','Mailbox auto-locked: ${r.fails_in_window} IMAP auth-fails in 1h — 24h cooldown before operator can unlock')`,
                [row.id]
              ).catch(() => {})
              console.log(`[imap] mailbox ${row.id} AUTH_LOCKED: ${r.fails_in_window} IMAP auth-fails in 1h`)
            }
          }).catch(e2 => console.error(`[auth-guard] imap recordAuthFail(${row.id}):`, e2.message))
        }
        // Increment IMAP circuit breaker on failure
        const { rows: circuitUpd } = await pool.query(
          `INSERT INTO mailbox_imap_circuit(mailbox_id, fail_count, updated_at)
           VALUES($1, 1, now())
           ON CONFLICT(mailbox_id) DO UPDATE SET fail_count=mailbox_imap_circuit.fail_count+1, updated_at=now()
           RETURNING fail_count`,
          [row.id]
        )
        const failCount = circuitUpd[0]?.fail_count || 1
        if (failCount >= 5) {
          const openMinutes = failCount >= 10 ? 240 : 120 // escalate to 4h after 10 fails
          await pool.query(
            `UPDATE mailbox_imap_circuit SET open_until=now() + interval '${openMinutes} minutes' WHERE mailbox_id=$1`,
            [row.id]
          )
          console.log(`[imap] circuit opened for mailbox ${row.id} (${failCount} consecutive failures, open ${openMinutes}min)`)
        }
      }
    }
    console.log(`[cron] runImapPollCron done — polled ${rows.length} mailboxes`)
  } catch (e) {
    console.error('[cron] runImapPollCron error:', e.message)
  }
}
