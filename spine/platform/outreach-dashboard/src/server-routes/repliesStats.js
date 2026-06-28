// AM-F3 — clickable stat strip for /replies page header.
// ─────────────────────────────────────────────────────────────────────────────
// Mounts GET /api/replies/stats with a SUPERSET response shape that adds
// Czech-key buckets (nezpracovane, cekaji_na_odpoved, zajem, dotazy, odmitnuti,
// dnes) on top of the existing English keys (total, unhandled, positive,
// negative, auto_reply, today, unmatched, unmatched_real, unmatched_bounces).
//
// The new Czech keys back the AM-F3 clickable stat strip — each card maps
// to a concrete filter state the operator can apply with one click.
//
// Why a separate file (not replies.js):
// ----------------------------------------------------------------------------
// The replies.js handler is the canonical /api/replies/stats — extending it
// in-place is the obvious move, but the AM-F3 spec required this surface to
// land as its own mount-point so the F1 SSE refactor (replies.js) and the F3
// stat strip read paths can move forward independently. Registration order
// in server.js ensures THIS handler responds before replies.js's identical
// route definition (Express first-match wins). The replies.js handler stays
// as a defensive fallback for the (unlikely) case AM-F3 is unregistered.
//
// Schema verification (HARD RULE feedback_schema_verify_before_sql):
//   psql \d reply_inbox      → columns: classification, handled, received_at ✓
//   psql \d unmatched_inbound → columns: classification, reviewed, received_at ✓
// Both verified against PROD on 2026-05-18 before this handler was written.
//
// Memory rules:
//   feedback_no_magic_thresholds — CEKAJI_INTERVAL named constant, not literal
//   feedback_no_speculation — every counter derives from FILTER aggregates,
//     no client-side math; SQL FILTER ignores NULL by definition so
//     'cekaji_na_odpoved' (classification IS NULL) is unambiguous
//   feedback_no_pii_in_commands — aggregate-only, no PII fields surfaced

// "Čekají na odpověď" window: unhandled + unclassified rows received in the
// last 24h. The interval keeps the count actionable — stale-but-unhandled rows
// past 24h fall into 'nezpracovane' only.
// Undeliverable/NDR signature negation — keep mislabeled-NULL bounce
// notifications (seznam postmaster NDRs etc.) out of the operator-facing
// counters so the stat strip matches the default /api/replies list exactly.
// Single source of truth with the list filter. (undeliverableFilter.js)
import { notUndeliverableSql } from '../lib/undeliverableFilter.js'

const CEKAJI_INTERVAL = '24 hours'

/**
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 *   capture500: (res: import('express').Response, err: unknown, safeError: (e: unknown) => string) => void,
 *   safeError: (e: unknown) => string,
 * }} deps
 */
export function mountRepliesStatsRoute(app, deps) {
  const { pool, capture500, safeError } = deps

  app.get('/api/replies/stats', async (req, res) => {
    try {
      // ── reply_inbox aggregate ─────────────────────────────────────────────
      // SQL FILTER clauses ignore NULL by definition; 'positive' / 'negative' /
      // 'question' / 'auto_reply' counters skip rows where classification IS NULL.
      //
      // AS-F1 (2026-05-19) — `nezpracovane`, `total`, `today` must reflect the
      // SAME filter the default /api/replies list view applies: hide bounce +
      // corrupted_charset. Otherwise stats says 166 unhandled and list shows 45.
      // 'positive' / 'negative' / 'question' / 'auto_reply' / 'cekaji' counters
      // are unchanged (already classification-specific).
      const riNotNdr = notUndeliverableSql('from_email', 'subject')
      const { rows: [s] } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset')) AND ${riNotNdr})::int AS total,
          COUNT(*) FILTER (
            WHERE NOT handled
              AND (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset'))
              AND ${riNotNdr}
          )::int                                                              AS unhandled,
          COUNT(*) FILTER (WHERE classification='positive')::int              AS positive,
          COUNT(*) FILTER (WHERE classification='negative')::int              AS negative,
          COUNT(*) FILTER (WHERE classification='auto_reply')::int            AS auto_reply,
          COUNT(*) FILTER (WHERE classification='question')::int              AS question,
          COUNT(*) FILTER (
            WHERE received_at > now() - interval '24 hours'
              AND (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset'))
              AND ${riNotNdr}
          )::int                                                              AS today,
          COUNT(*) FILTER (
            WHERE NOT handled
              AND received_at > now() - interval '${CEKAJI_INTERVAL}'
              AND classification IS NULL
              AND ${riNotNdr}
          )::int                                                              AS cekaji,
          -- Oldest still-unhandled hot (positive) reply — drives the Přehled
          -- urgency signal. The whole hot backlog is aging (18d+ on 2026-06-01),
          -- so surfacing the oldest age the moment the operator opens the app.
          MIN(received_at) FILTER (WHERE NOT handled AND classification='positive') AS oldest_hot_unhandled,
          -- Hot leads still waiting: positive replies the operator hasn't acted
          -- on. This is the real triage backlog (≠ total positive) and the count
          -- the Odpovědi "Zájem" lane shows so the chip matches the list.
          COUNT(*) FILTER (WHERE NOT handled AND classification='positive')::int AS hot_unhandled,
          -- Sellers still waiting for a call: unhandled replies that left a phone
          -- number (#1578 M1). Drives the Odpovědi "📞 K zavolání" lane count —
          -- the whole výkup closes by phone, so this is a primary triage number.
          COUNT(*) FILTER (WHERE NOT handled AND mined IS NOT NULL AND jsonb_array_length(mined->'phones') > 0)::int AS phone_unhandled
        FROM reply_inbox
      `)

      // ── unmatched_inbound aggregate ───────────────────────────────────────
      // Orphan replies the orchestrator could not match to a send_event.
      // Bounces are surfaced separately so the UI can render a distinct chip.
      // u_total / u_unhandled / u_today now exclude bounce + corrupted_charset
      // so they roll up into operator-facing counters consistently.
      const umNotNdr = notUndeliverableSql('from_address', 'subject')
      const { rows: [u] } = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset')) AND ${umNotNdr})::int AS u_total,
          COUNT(*) FILTER (
            WHERE NOT reviewed
              AND (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset'))
              AND ${umNotNdr}
          )::int                                                              AS u_unhandled,
          COUNT(*) FILTER (
            WHERE received_at > now() - interval '24 hours'
              AND (classification IS NULL OR classification NOT IN ('bounce','corrupted_charset'))
              AND ${umNotNdr}
          )::int                                                              AS u_today,
          COUNT(*) FILTER (WHERE classification = 'bounce')::int              AS u_bounces,
          COUNT(*) FILTER (WHERE classification IS NULL OR classification != 'bounce')::int AS u_real,
          COUNT(*)::int                                                       AS u_total_all,
          COUNT(*) FILTER (
            WHERE NOT reviewed
              AND received_at > now() - interval '${CEKAJI_INTERVAL}'
              AND classification IS NULL
              AND ${umNotNdr}
          )::int                                                              AS u_cekaji
        FROM unmatched_inbound
      `)

      const total       = Number(s?.total      || 0) + Number(u?.u_total     || 0)
      const unhandled   = Number(s?.unhandled  || 0) + Number(u?.u_unhandled || 0)
      const positive    = Number(s?.positive   || 0)
      const negative    = Number(s?.negative   || 0)
      const auto_reply  = Number(s?.auto_reply || 0)
      const question    = Number(s?.question   || 0)
      const today       = Number(s?.today      || 0) + Number(u?.u_today    || 0)
      const cekaji      = Number(s?.cekaji     || 0) + Number(u?.u_cekaji   || 0)

      const body = {
        // English keys — back-compat with existing consumers + contract test.
        total,
        unhandled,
        positive,
        negative,
        auto_reply,
        today,
        // ISO timestamp of the oldest unhandled hot reply, or null when none.
        oldest_hot_unhandled_at: s?.oldest_hot_unhandled || null,
        // Count of hot leads still waiting (positive + unhandled) — the triage
        // backlog the Odpovědi "Zájem" lane shows.
        hot_unhandled: Number(s?.hot_unhandled || 0),
        // Count of unhandled replies that left a phone number — the "📞 K
        // zavolání" call-queue lane count (#1578 M1).
        phone_unhandled: Number(s?.phone_unhandled || 0),
        // `unmatched` keeps its raw all-rows meaning so existing Bounces-chip
        // consumers still receive the inclusive count; default-view consumers
        // should read `nezpracovane` instead.
        unmatched:         Number(u?.u_total_all || 0),
        unmatched_real:    Number(u?.u_real      || 0),
        unmatched_bounces: Number(u?.u_bounces   || 0),

        // AM-F3 — Czech-key buckets for the clickable stat strip. The strip
        // maps each to a concrete filter object via the onFilterChange prop.
        nezpracovane:      unhandled,          // !handled AND not bounce/corrupted (matches default list)
        cekaji_na_odpoved: cekaji,             // !handled AND <24h AND classification IS NULL
        zajem:             positive,           // classification='positive'
        dotazy:            question,           // classification='question'
        odmitnuti:         negative,           // classification='negative'
        dnes:              today,              // received in last 24h, not bounce/corrupted
      }

      res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.json(body)
    } catch (e) {
      capture500(res, e, safeError)
    }
  })
}
