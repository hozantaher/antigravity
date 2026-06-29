// undeliverableFilter.js — single source of truth for the "undeliverable /
// bounce notification" signature that keeps non-deliverable mail out of the
// operator's Odpovědi queue.
// ─────────────────────────────────────────────────────────────────────────────
// WHY this exists on top of the classification='bounce' filter:
//   The default replies view already hides classification IN ('bounce',
//   'corrupted_charset'). But the prod IMAP path (Go orchestrator, Z3) inserts
//   some real DSN/NDR notifications into reply_inbox with classification=NULL —
//   the Go DetectBounce gate requires an RFC 3464 "Status: X.Y.Z" body line,
//   which seznam.cz `postmaster@` NDRs (and several SK/foreign MTAs) do not
//   carry. Those rows leak into the queue as fake "replies" even though they
//   are plainly mailer-daemon / postmaster delivery failures.
//
//   This module recognises an undeliverable message by its STRUCTURAL signature
//   (bounce sender OR NDR subject) so the operator-facing surface stays clean
//   regardless of whether the upstream classifier labelled it. It is a strictly
//   looser, view-only guard layered under the authoritative classifier — it
//   never mutates data.
//
// VALIDATED against PROD on 2026-06-24 (psql `~*`):
//   - matches exactly the 42 mislabeled-NULL bounce rows in reply_inbox
//     (postmaster@seznam.cz "Nedoručitelná zpráva / Undelivered Mail…",
//     mailer-daemon "Mail delivery failed: returning message to sender",
//     "Delivery Status Notification (Failure)", postmaster@{mcfd,kami-profit})
//   - ZERO collisions with any real classified reply
//     (positive/negative/question/auto_reply/unsubscribe)
//   - deliberately does NOT treat a "noreply"/"no-reply" sender as
//     undeliverable: reply_inbox id 381 (info+noreply@smartstavby.cz "Re:
//     Dotaz") is a REAL human reply and must stay visible. (The replyClassifier
//     BOUNCE_FROM_RX includes noreply, but it pairs it with body/DSN scoring;
//     a bare sender heuristic in a view filter cannot, so noreply is excluded
//     here on purpose.)
//
// feedback_no_magic_thresholds T0: the two patterns are named constants defined
//   once here and imported by every SQL site (replies.js list + fallback stats,
//   repliesStats.js canonical stats) so the list and the stat strip can never
//   drift apart.
// feedback_no_speculation: patterns derive from real PROD rows + the existing
//   replyClassifier BOUNCE_*_RX domain, not gut feel.

// Canonical RFC 5321 bounce senders. mailer-daemon / mail-daemon / postmaster
// are reserved mailbox names for mail-system administration — a real lead never
// replies from them. "mail delivery subsystem/system/service" covers the
// display-name form some MTAs use (Sendmail, Exchange NDR). NOTE: "noreply" is
// intentionally absent — see module header (id 381 false positive).
export const UNDELIVERABLE_FROM_RX =
  '(^|[<[:space:]:])(mailer-daemon|postmaster|mail-daemon)@|mail delivery (subsystem|system|service)'

// Subject lines of real Non-Delivery Reports, EN + CZ + SK. Mirrors the
// replyClassifier BOUNCE_SUBJECT_RX domain and adds the live-observed Czech
// "Nedoručiteln*" / "nelze doručit" / "doručení se nezdařilo" wording.
export const UNDELIVERABLE_SUBJECT_RX =
  'nedoručiteln|nedoručeno|undeliverable|undelivered|delivery status notification|failure notice|returned mail|returned to sender|returning message to sender|mail delivery (failed|fail|system|subsystem)|could not be delivered|nelze doručit|doručení se nezda'

/**
 * SQL boolean (Postgres `~*` case-insensitive POSIX regex) that is TRUE when a
 * row looks like an undeliverable/bounce notification by sender OR subject.
 *
 * Column names are caller-supplied so the same predicate serves reply_inbox
 * (from_email) and unmatched_inbound (from_address). Both columns are wrapped
 * in COALESCE(...,'') so a NULL never NULL-propagates and accidentally hides a
 * legitimate row.
 *
 * The patterns are module constants (no user input, no single quotes) → safe to
 * inline; this builder consumes NO `$N` parameter placeholders, so it composes
 * cleanly into a growing parameterised query without shifting indices.
 *
 * @param {string} fromCol  SQL expression for the sender column (e.g. 'r.from_email')
 * @param {string} subjCol  SQL expression for the subject column (e.g. 'r.subject')
 * @returns {string} a parenthesised SQL boolean expression
 */
export function isUndeliverableSql(fromCol, subjCol) {
  return `(COALESCE(${fromCol},'') ~* '${UNDELIVERABLE_FROM_RX}' OR COALESCE(${subjCol},'') ~* '${UNDELIVERABLE_SUBJECT_RX}')`
}

/**
 * Negation of {@link isUndeliverableSql} — TRUE when the row is NOT an
 * undeliverable notification. Push this into a WHERE/FILTER conjunction to keep
 * delivery-failure noise out of the operator's queue.
 *
 * @param {string} fromCol
 * @param {string} subjCol
 * @returns {string}
 */
export function notUndeliverableSql(fromCol, subjCol) {
  return `NOT ${isUndeliverableSql(fromCol, subjCol)}`
}
