// replyClassifyEndpoint.js — AV-F2 (2026-05-19) + AV-F4 (2026-05-19)
// ─────────────────────────────────────────────────────────────────────────
// POST /api/replies/:id/auto-classify
//
// Idempotent endpoint that runs the regex (AV-F2) + optional LLM second
// stage (AV-F4 via llm-runner / Ollama) classifier against a single reply
// and writes the verdict to reply_classifications_log under the
// classifier_version that decided (`regex_v1` or `ollama_v1`).
// If the confidence crosses AUTO_APPLY_THRESHOLD (0.75) AND the reply is not
// yet handled, the verdict is also written back to
// reply_inbox.classification / unmatched_inbound.classification AND
// reply_inbox.handled flips TRUE.
//
// Idempotency is enforced by the (reply_id, classifier_version) unique index
// on reply_classifications_log (migration 123). A repeat call for the same
// (reply_id, version) returns the existing row instead of re-classifying;
// this lets the cron poll loop be safely re-run without duplicates.
//
// Body loading:
//   - positive id → reply_inbox.id; body via outreach_messages join on
//     send_event_id (the matched inbound copy). Falls back to body_preview
//     when no outbound message can be joined.
//   - negative id → unmatched_inbound; body_html or body_preview.
//
// Schema verified 2026-05-19 (psql \d):
//   reply_inbox: id, send_event_id, subject, from_email, classification, handled
//   unmatched_inbound: id, from_address, subject, body_preview, body_html, classification
//   outreach_messages: id, body_text, body_html, subject
//   reply_classifications_log: id, reply_id (signed), classifier_version,
//     classification, confidence, reasoning, applied, operator_override, ...
//
// Memory rules:
//   feedback_schema_verify_before_sql T0 — schema cited above.
//   feedback_audit_log_on_mutations  T0 — auto-apply writes operator_audit_log.
//   feedback_no_magic_thresholds     T0 — AUTO_APPLY_THRESHOLD imported.
//   feedback_no_pii_in_commands       — body content not echoed in logs.

import {
  classifyReply,
  classifyReplyWithLLM,
  CLASSIFIER_VERSION,
  LLM_CLASSIFIER_VERSION,
  AUTO_APPLY_THRESHOLD,
} from '../lib/replyClassifier.js'

const ACTOR_REGEX = 'classifier_regex_v1'
const ACTOR_LLM = 'classifier_ollama_v1'

/**
 * Pick the right actor + classifier_version label for the persisted row,
 * given the verdict's `reasoning.classifier_version` (set by
 * `classifyReplyWithLLM`).
 */
function resolveStageLabels(verdict) {
  const v = verdict?.reasoning?.classifier_version || CLASSIFIER_VERSION
  if (v === LLM_CLASSIFIER_VERSION) {
    return { actor: ACTOR_LLM, classifierVersion: LLM_CLASSIFIER_VERSION }
  }
  return { actor: ACTOR_REGEX, classifierVersion: CLASSIFIER_VERSION }
}

/**
 * Load the (body, subject, fromAddress) tuple for one reply, regardless
 * of which physical table it lives in. Returns null if the reply is
 * not found.
 *
 * @param {import('pg').Pool} pool
 * @param {number} signedId  — operator-facing signed reply id
 * @returns {Promise<null | { body: string, subject: string, from: string, handled: boolean, source: 'reply_inbox'|'unmatched_inbound', physicalId: number }>}
 */
async function loadReplyContent(pool, signedId) {
  if (!Number.isFinite(signedId) || signedId === 0) return null

  if (signedId > 0) {
    // reply_inbox path.
    // G3.5 fix (2026-05-29): join channel_messages for the INBOUND reply body
    // instead of outreach_messages (which held the outbound sent body).
    // The trigger trg_reply_inbox_to_channel_messages inserts a row to
    // channel_messages with direction='inbound' for each reply_inbox INSERT,
    // linked by from_email. We prefer channel_messages.body over body_html
    // because plain text classifies better with the regex engine.
    const { rows } = await pool.query(
      `SELECT r.id, r.from_email, r.subject, r.handled,
              cm.body AS cm_body, cm.body_html AS cm_body_html
         FROM reply_inbox r
         LEFT JOIN channel_messages cm
           ON lower(cm.from_handle) LIKE ('%' || lower(r.from_email) || '%')
          AND cm.direction = 'inbound'
          AND cm.received_at BETWEEN r.received_at - interval '10 minutes'
                                 AND r.received_at + interval '10 minutes'
        WHERE r.id = $1
        ORDER BY cm.id DESC
        LIMIT 1`,
      [signedId],
    )
    if (!rows.length) return null
    const r = rows[0]
    const body = String(r.cm_body || r.cm_body_html || '').slice(0, 10_000)
    return {
      body,
      subject: r.subject || '',
      from: r.from_email || '',
      handled: !!r.handled,
      source: 'reply_inbox',
      physicalId: Number(r.id),
    }
  }

  // unmatched_inbound path.
  const physicalId = -signedId
  const { rows } = await pool.query(
    `SELECT id, from_address, subject, body_preview, body_html, classification, reviewed
       FROM unmatched_inbound
      WHERE id = $1
      LIMIT 1`,
    [physicalId],
  )
  if (!rows.length) return null
  const u = rows[0]
  const body = String(u.body_html || u.body_preview || '').slice(0, 10_000)
  return {
    body,
    subject: u.subject || '',
    from: u.from_address || '',
    handled: !!u.reviewed,
    source: 'unmatched_inbound',
    physicalId: Number(u.id),
  }
}

/**
 * Apply the verdict to the source row (reply_inbox or unmatched_inbound).
 * Writes operator_audit_log inside the same transaction
 * (feedback_audit_log_on_mutations T0).
 *
 * @returns {Promise<{ applied: true }>}
 */
async function applyVerdict(pool, signedId, source, physicalId, verdict) {
  const { actor, classifierVersion } = resolveStageLabels(verdict)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (source === 'reply_inbox') {
      await client.query(
        `UPDATE reply_inbox
            SET classification = $1,
                handled = TRUE,
                handled_at = now()
          WHERE id = $2
            AND handled = FALSE`,
        [verdict.classification, physicalId],
      )
    } else {
      await client.query(
        `UPDATE unmatched_inbound
            SET classification = $1,
                reviewed = TRUE,
                reviewed_at = now()
          WHERE id = $2
            AND reviewed = FALSE`,
        [verdict.classification, physicalId],
      )
    }
    await client.query(
      `INSERT INTO operator_audit_log (action, actor, entity_type, entity_id, details)
       VALUES ('auto_classified', $1, $2, $3, $4::jsonb)`,
      [
        actor,
        source === 'reply_inbox' ? 'reply_inbox' : 'unmatched_inbound',
        String(physicalId),
        JSON.stringify({
          reply_id: signedId,
          classifier_version: classifierVersion,
          classification: verdict.classification,
          confidence: verdict.confidence,
        }),
      ],
    )
    await client.query('COMMIT')
    return { applied: true }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* ignored */ }
    throw e
  } finally {
    client.release()
  }
}

/**
 * Run the classifier for a single reply. Returns { verdict, applied,
 * idempotent }. Idempotent=true means we returned a previously logged
 * verdict.
 *
 * @param {import('pg').Pool} pool
 * @param {number} signedId
 * @returns {Promise<{ ok: boolean, error?: string, verdict?: object, applied?: boolean, idempotent?: boolean }>}
 */
export async function autoClassifyReply(pool, signedId, opts = {}) {
  // 1. Idempotency check — look for ANY prior verdict (regex or ollama).
  //    If an ollama_v1 row exists, prefer it (it's the higher-stage verdict).
  //    Otherwise reuse regex_v1.
  const { rows: existing } = await pool.query(
    `SELECT classifier_version, classification, confidence, reasoning, applied
       FROM reply_classifications_log
      WHERE reply_id = $1
        AND classifier_version IN ($2, $3)
      ORDER BY CASE classifier_version WHEN $3 THEN 0 ELSE 1 END,
               created_at DESC
      LIMIT 1`,
    [signedId, CLASSIFIER_VERSION, LLM_CLASSIFIER_VERSION],
  )
  if (existing.length) {
    const row = existing[0]
    return {
      ok: true,
      idempotent: true,
      verdict: {
        classification: row.classification,
        confidence: Number(row.confidence),
        reasoning: row.reasoning,
      },
      applied: !!row.applied,
      stages: Array.isArray(row.reasoning?.stages) ? row.reasoning.stages : [{
        version: row.classifier_version,
        classification: row.classification,
        confidence: Number(row.confidence),
      }],
      classifier_version: row.classifier_version,
    }
  }

  // 2. Load body + subject + from.
  const content = await loadReplyContent(pool, signedId)
  if (!content) return { ok: false, error: 'not_found' }

  // 3. Run regex + (conditionally) LLM second stage.
  //    Tests can inject a llmClient via opts to keep unit tests synchronous;
  //    production passes nothing and the wrapper auto-imports the real client.
  const verdict = await classifyReplyWithLLM(
    content.body,
    content.subject,
    content.from,
    {
      llmClient: opts.llmClient,
      buildPrompt: opts.buildPrompt,
      logger: opts.logger,
    },
  )
  const stages = verdict.stages || [{
    version: CLASSIFIER_VERSION,
    classification: verdict.classification,
    confidence: verdict.confidence,
  }]
  const { classifierVersion } = resolveStageLabels(verdict)

  // 4. Decide whether to auto-apply.
  //    Only the DETERMINISTIC regex stage may auto-apply (auto-mark handled).
  //    The Ollama LLM stage (3b model, hallucination-prone) enriches the
  //    classification + rationale for the operator but must NOT auto-handle a
  //    reply — a hallucinated verdict would silently hide a real hot lead from
  //    triage. LLM-decided verdicts are persisted (visible pill) and left for
  //    the operator to confirm. This preserves the pre-Ollama auto-apply
  //    baseline (regex-only) while adding the LLM as a non-destructive assist.
  const shouldApply =
    verdict.classification !== null &&
    verdict.confidence >= AUTO_APPLY_THRESHOLD &&
    classifierVersion === CLASSIFIER_VERSION &&
    !content.handled

  // 5. Persist verdict (always) + apply if threshold crossed.
  let applied = false
  if (shouldApply) {
    await applyVerdict(pool, signedId, content.source, content.physicalId, verdict)
    applied = true
  }

  const reasoningWithStages = {
    ...(verdict.reasoning || {}),
    stages,
    llm_invoked: !!verdict.llm_invoked,
    ...(verdict.llm_error ? { llm_error: verdict.llm_error } : {}),
  }

  await pool.query(
    `INSERT INTO reply_classifications_log
       (reply_id, classifier_version, classification, confidence, reasoning, applied)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (reply_id, classifier_version) DO NOTHING`,
    [
      signedId,
      classifierVersion,
      verdict.classification,
      verdict.confidence,
      JSON.stringify(reasoningWithStages),
      applied,
    ],
  )

  return {
    ok: true,
    verdict: { ...verdict, reasoning: reasoningWithStages },
    applied,
    idempotent: false,
    stages,
    classifier_version: classifierVersion,
  }
}

/**
 * Mount POST /api/replies/:id/auto-classify on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{ pool: import('pg').Pool, capture500?: Function, safeError?: Function }} deps
 */
export function mountReplyClassifyEndpoint(app, { pool, capture500, safeError } = {}) {
  const safe = safeError || ((e) => (e && e.message) ? String(e.message) : 'unknown error')
  const cap500 = capture500 || ((res, err) => {
    res.status(500).json({ error: safe(err) })
  })

  app.post('/api/replies/:id/auto-classify', async (req, res) => {
    try {
      const signedId = Number.parseInt(String(req.params.id || ''), 10)
      if (!Number.isFinite(signedId) || signedId === 0) {
        return res.status(400).json({ error: 'invalid_id' })
      }
      const result = await autoClassifyReply(pool, signedId)
      if (!result.ok) {
        const status = result.error === 'not_found' ? 404 : 400
        return res.status(status).json({ error: result.error })
      }
      res.json({
        ok: true,
        verdict: result.verdict,
        applied: result.applied,
        idempotent: result.idempotent,
        stages: result.stages || [],
        classifier_version: result.classifier_version || CLASSIFIER_VERSION,
      })
    } catch (e) {
      cap500(res, e, safe)
    }
  })

  // GET /api/replies/:id/classification — read latest verdict for the banner.
  // Returns null if no row yet (operator UI hides the banner in that case).
  app.get('/api/replies/:id/classification', async (req, res) => {
    try {
      const signedId = Number.parseInt(String(req.params.id || ''), 10)
      if (!Number.isFinite(signedId) || signedId === 0) {
        return res.status(400).json({ error: 'invalid_id' })
      }
      const { rows } = await pool.query(
        `SELECT classifier_version, classification, confidence, reasoning,
                applied, operator_override, operator_override_at, created_at
           FROM reply_classifications_log
          WHERE reply_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        [signedId],
      )
      if (!rows.length) return res.json({ ok: true, verdict: null })
      const r = rows[0]
      res.json({
        ok: true,
        verdict: {
          classifier_version: r.classifier_version,
          classification: r.classification,
          confidence: Number(r.confidence),
          reasoning: r.reasoning,
          applied: !!r.applied,
          operator_override: r.operator_override || null,
          operator_override_at: r.operator_override_at,
          created_at: r.created_at,
        },
      })
    } catch (e) {
      cap500(res, e, safe)
    }
  })
}

/**
 * Cron tick: classify every recent unclassified reply.
 *
 * - Pulls reply_inbox rows received in the last 24h with handled=FALSE
 *   AND classification IS NULL.
 * - Pulls unmatched_inbound rows in the last 24h with classification IS NULL.
 * - Paginates by 50 at a time to bound per-tick work.
 *
 * Safe to invoke repeatedly — `autoClassifyReply` short-circuits on the
 * existing verdict via the unique index.
 *
 * @param {import('pg').Pool} pool
 */
export async function runAutoClassifyCron(pool) {
  const BATCH_SIZE = 50
  // No time-window: a reply that wasn't classified within the old 24h LOOKBACK
  // (cron down, arrived during a gap, or pre-dated the cron) was abandoned NULL
  // forever. The reply_classifications_log NOT-EXISTS guard already prevents
  // re-attempting rows tried with the current classifier version, so scanning
  // the whole unclassified-unhandled backlog (LIMIT BATCH_SIZE/tick) is
  // idempotent + bounded — it just drains stragglers. (#unclassified backlog.)
  let classified = 0
  let applied = 0
  let skipped = 0
  // reply_inbox: ids > 0
  // Skip rows that already have a verdict from EITHER classifier version
  // (regex_v1 from AV-F2 OR ollama_v1 from AV-F4). autoClassifyReply
  // short-circuits on the existing verdict anyway, but the filter saves
  // a per-tick query for stable rows.
  const replyRows = await pool.query(
    `SELECT id
       FROM reply_inbox
      WHERE handled = FALSE
        AND classification IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM reply_classifications_log l
           WHERE l.reply_id = reply_inbox.id
             AND l.classifier_version IN ($1, $3)
        )
      ORDER BY received_at DESC
      LIMIT $2`,
    [CLASSIFIER_VERSION, BATCH_SIZE, LLM_CLASSIFIER_VERSION],
  )
  for (const row of replyRows.rows) {
    try {
      const r = await autoClassifyReply(pool, Number(row.id))
      classified++
      if (r.applied) applied++
    } catch (e) {
      skipped++
      console.warn(`[cron] runAutoClassifyCron reply_inbox=${row.id} err=${e?.message}`)
    }
  }

  // unmatched_inbound: signed id = -physical_id
  const umRows = await pool.query(
    `SELECT id
       FROM unmatched_inbound
      WHERE reviewed = FALSE
        AND classification IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM reply_classifications_log l
           WHERE l.reply_id = -unmatched_inbound.id
             AND l.classifier_version IN ($1, $3)
        )
      ORDER BY received_at DESC
      LIMIT $2`,
    [CLASSIFIER_VERSION, BATCH_SIZE, LLM_CLASSIFIER_VERSION],
  )
  for (const row of umRows.rows) {
    try {
      const r = await autoClassifyReply(pool, -Number(row.id))
      classified++
      if (r.applied) applied++
    } catch (e) {
      skipped++
      console.warn(`[cron] runAutoClassifyCron unmatched=${row.id} err=${e?.message}`)
    }
  }

  console.log(`[cron] runAutoClassifyCron classified=${classified} applied=${applied} skipped=${skipped}`)
}
