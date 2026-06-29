// runVehicleAutoCaptureCron — automated reply→vehicle inventory linking.
//
// North-star (operator, 2026-05-30): "máme desetitisíce řádků informací, je
// to jenom o to je správně automatizovaně propojit". A prospect replies
// offering machinery; the reply body names the vehicle. Until now that vehicle
// only reached the Vozidla inventory tab if the operator manually clicked
// "Zapsat vozidlo". This cron closes the loop: it sweeps recent replies, runs
// the DETERMINISTIC regex_v2 extractor, and auto-inserts each qualified vehicle
// fully linked to the sender's contact → company → crm_client.
//
// Why deterministic-only (no Ollama here): a hallucinated make/model must never
// silently create inventory rows. The relative-LLM extractor stays behind the
// operator-triggered on-demand endpoint. See vehicleCapture.js header.
//
// Idempotent: capture dedups on (source_reply_id, make, model), so re-sweeping
// the same reply inserts nothing new. A reply that yields no vehicles is cheap
// to re-scan (regex, no I/O) and simply contributes 0.
//
// HARD rules: feedback_no_magic_thresholds (named constants below),
// feedback_audit_log_on_mutations (each insert audited inside captureVehiclesFromReply).

import { captureVehiclesFromReply } from '../lib/vehicleCapture.js'

// Only sweep recent replies — older inventory is already triaged, and an
// unbounded scan would re-extract the whole history every tick.
export const AUTO_CAPTURE_LOOKBACK = '30 days'
// Cap rows examined per tick. Regex is cheap but this bounds DB round-trips
// (one dedup SELECT + optional INSERT per candidate vehicle).
export const AUTO_CAPTURE_BATCH_LIMIT = 200
// Cron cadence — 10 min. Replies trickle in; near-real-time capture is enough.
export const AUTO_CAPTURE_INTERVAL_MS = 10 * 60 * 1000

/**
 * Sweep recent reply_inbox rows and auto-capture any vehicles they name.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{ scanned: number, inserted: number, skipped: number, repliesWithVehicles: number }>}
 */
export async function runVehicleAutoCaptureCron(pool) {
  // Replies received within the lookback window that have a usable body and
  // no vehicle already captured from them. body_text is canonical (Schema-A);
  // fall back to subject-only is handled inside the extractor.
  const { rows } = await pool.query(
    `SELECT r.id, r.from_email, r.subject, r.body_text
       FROM reply_inbox r
      WHERE r.received_at > NOW() - INTERVAL '${AUTO_CAPTURE_LOOKBACK}'
        AND COALESCE(r.body_text, '') <> ''
        AND NOT EXISTS (
          SELECT 1 FROM vehicles v WHERE v.source_reply_id = r.id
        )
      ORDER BY r.received_at DESC
      LIMIT $1`,
    [AUTO_CAPTURE_BATCH_LIMIT]
  )

  let inserted = 0
  let skipped = 0
  let repliesWithVehicles = 0
  let errors = 0
  for (const r of rows) {
    try {
      const out = await captureVehiclesFromReply(pool, {
        replyId: r.id,
        fromEmail: r.from_email,
        subject: r.subject,
        body: r.body_text,
      })
      inserted += out.inserted
      skipped += out.skipped
      if (out.inserted > 0) repliesWithVehicles += 1
    } catch (e) {
      // Per-reply failure must not abort the sweep — next tick retries. But it
      // must NOT be silent: a swallowed catch here hid an entire class of
      // dropped offers (make-only vehicles failing a NOT NULL model constraint)
      // until a manual audit found them. Log every failure so the next one
      // surfaces immediately.
      errors += 1
      console.error('[cron] runVehicleAutoCaptureCron capture failed', {
        op: 'runVehicleAutoCaptureCron/capture',
        reply_id: r.id,
        error: e?.message || String(e),
        code: e?.code,
      })
    }
  }

  return { scanned: rows.length, inserted, skipped, repliesWithVehicles, errors }
}
