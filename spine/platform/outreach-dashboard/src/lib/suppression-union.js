// suppression-union.js — pure-JS helpers for in-memory suppression
// reasoning. Mirrors the canonical SQL fragment in suppressionFilter.js
// (UNION of outreach_suppressions + suppression_list, lower(trim(email)))
// for paths that already have both rowsets in memory and need to answer
// "is this contact already suppressed?" without a Postgres round-trip.
//
// Two suppression tables exist (memory: project_two_suppression_tables.md):
//   - outreach_suppressions — Go-side (reply classifier, bounce cascade)
//   - suppression_list      — JS BFF (manual ops UI add, server.js bounce)
//
// Helpers here ALWAYS take both inputs. There is no single-table
// shortcut by design — that is the bug class this module exists to
// prevent (commit e000fb9 fixed the runner-side variant of the same).

/**
 * Normalize an email exactly as the SQL fragment does:
 *   lower(trim(email))
 * Returns null when the input is not a usable string after trimming.
 *
 * @param {unknown} email
 * @returns {string|null}
 */
function normalizeEmail(email) {
  if (email === null || email === undefined) return null
  if (typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Build the union of two suppression rowsets. Mirrors:
 *
 *   SELECT lower(trim(email)) FROM outreach_suppressions
 *   UNION
 *   SELECT lower(trim(email)) FROM suppression_list
 *
 * Each row is expected to expose an `email` field (matching the columns
 * present in both tables). Empty / null / non-string emails are filtered
 * out. The returned Set is the canonical lookup structure.
 *
 * @param {ReadonlyArray<{ email?: unknown }>} outreachSuppressions
 * @param {ReadonlyArray<{ email?: unknown }>} suppressionList
 * @returns {Set<string>}
 */
export function unionSuppressions(outreachSuppressions, suppressionList) {
  const out = new Set()
  const rowsets = [outreachSuppressions, suppressionList]
  for (const rows of rowsets) {
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const norm = normalizeEmail(row.email)
      if (norm !== null) out.add(norm)
    }
  }
  return out
}

/**
 * O(1) membership check against a prebuilt union set. Normalizes the
 * candidate the same way the SQL fragment normalizes the bind value
 * (lower(trim($1))) so callers can pass raw user-supplied addresses.
 *
 * @param {unknown} email
 * @param {ReadonlySet<string>} unionSet
 * @returns {boolean}
 */
export function isSuppressed(email, unionSet) {
  if (!(unionSet instanceof Set)) return false
  const norm = normalizeEmail(email)
  if (norm === null) return false
  return unionSet.has(norm)
}

// ───────────────────────────────────────────────────────────────────
// Bounce → suppression classification
// ───────────────────────────────────────────────────────────────────
//
// Mirrors services/mailboxes/bounce/processor.go classifyBounceCode:
//
//   5xx hard codes (550 / 551 / 553 / 554) → permanent failure → suppress
//   552                                    → soft (mailbox full / quota) → no suppress
//   4xx                                    → soft (transient) → no suppress
//   535                                    → mailbox-side auth failure → no suppress
//   2xx / 3xx                              → not a bounce → no suppress
//
// 552 deserves a callout: the SMTP RFC bucket-numbers it as 5xx
// "permanent" but operationally it is a quota/storage condition that
// commonly clears on the recipient side. We treat it as soft for the
// suppression decision — the contact is still reachable.
//
// 535 is a SENDER-mailbox condition (bad creds). The contact is not at
// fault, so we never suppress on it. Per-mailbox circuit breaker
// handles 535 separately via auth_fail_count escalation.

const HARD_BOUNCE_CODES = new Set(['550', '551', '553', '554'])
const NEVER_SUPPRESS_CODES = new Set([
  '535', // mailbox-side auth failure
  '552', // mailbox full / over quota — soft
])

/**
 * Decide whether a single bounce event should generate a suppression
 * row. Returns `{ suppress: true, reason: 'hard_bounce' }` for
 * permanent contact-side failures, or `null` for everything else
 * (soft / transient / mailbox-side / non-bounce).
 *
 * @param {string|number|null|undefined} smtpCode
 * @param {string|null|undefined} _smtpDetail unused for now; reserved
 *   for future keyword fallback (e.g. "user unknown" without a code).
 * @returns {{ suppress: true, reason: 'hard_bounce' } | null}
 */
// eslint-disable-next-line no-unused-vars
export function classifyBounceForSuppression(smtpCode, _smtpDetail) {
  const code = coerceCode(smtpCode)
  if (code === null) return null
  if (NEVER_SUPPRESS_CODES.has(code)) return null
  if (HARD_BOUNCE_CODES.has(code)) {
    return { suppress: true, reason: 'hard_bounce' }
  }
  return null
}

/**
 * Coerce an SMTP code to a canonical 3-char string, or null when the
 * input is not a recognizable code.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function coerceCode(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const s = String(Math.trunc(raw))
    return /^\d{3}$/.test(s) ? s : null
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return /^\d{3}$/.test(trimmed) ? trimmed : null
}
