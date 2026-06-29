/**
 * AR-Wave3 (2026-05-18) — Czech-locale relative + absolute time formatters
 * for the /replies surface (ticket #5: relativní + absolutní čas).
 *
 * `formatRelative(date, now?)` returns a compact webmail-style relative
 * label (e.g. "právě teď", "5 min", "dnes 14:35", "včera 09:12",
 * "Po 14:36", "18. 5."). `formatAbsolute(date)` returns the full Czech
 * datetime ("18. 5. 2026 17:35") that the row's `title=` attribute
 * surfaces on hover/focus.
 *
 * Both helpers are pure — exposing them in `src/lib/` lets every reply
 * surface (RepliesTableRow, RepliesBreadcrumb, ThreadDetail, etc.)
 * format received_at consistently instead of each component sprinkling
 * its own `.toLocaleString('cs-CZ')` call.
 *
 * Memory rules referenced:
 *   feedback_no_magic_thresholds T0 — every threshold/branch boundary is
 *     a named constant (SECOND_MS, MINUTE_MS, HOUR_MS, DAY_MS, WEEK_MS,
 *     YEAR_MS) instead of a literal inside the conditional.
 *   feedback_no_speculation T0 — Czech weekday list + month/day order
 *     verified against cs-CZ locale conventions (D. M. YYYY).
 *
 * Branch behavior:
 *   < 60 s              → "právě teď"
 *   < 60 min            → "X min"
 *   same calendar day   → "dnes HH:MM"
 *   yesterday           → "včera HH:MM"
 *   < 7 days            → "<cs weekday short> HH:MM" (Po/Út/St/Čt/Pá/So/Ne)
 *   < 365 days          → "DD. MM."
 *   older               → "DD. MM. YYYY"
 *   invalid / nullish   → "—" (relative) or "" (absolute)
 */

// AR-Wave3 — boundary thresholds surfaced as named constants per
// feedback_no_magic_thresholds T0. All milliseconds.
const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS
const YEAR_MS = 365 * DAY_MS

// Czech short weekday names (Mon-first), matching Outlook / Seznam Email
// usage. Index by Date.getDay() with `(getDay() + 6) % 7` to shift Sunday
// from index 0 to index 6.
const WEEKDAYS_CS_SHORT = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne']

/**
 * @param {Date | number | string | null | undefined} input
 * @returns {Date | null}
 */
function toDate(input) {
  if (input == null) return null
  const d = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(d.getTime())) return null
  return d
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * Render `receivedAt` as a compact Czech relative-time label suitable for
 * a dense list cell. Falls back to "—" when the input is missing or
 * unparseable.
 *
 * @param {Date | number | string | null | undefined} receivedAt
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function formatRelative(receivedAt, now = Date.now()) {
  const d = toDate(receivedAt)
  if (!d) return '—'
  const ts = d.getTime()
  const ageMs = Math.max(0, now - ts)

  if (ageMs < MINUTE_MS) return 'právě teď'
  if (ageMs < HOUR_MS) {
    const min = Math.max(1, Math.floor(ageMs / MINUTE_MS))
    return `${min} min`
  }
  // For "today" / "yesterday" branches we compare local calendar days,
  // not raw ageMs — so a 19:00 reply seen at 02:00 next day renders as
  // "včera 19:00" rather than "7 h", matching operator mental model.
  const nowDate = new Date(now)
  if (isSameLocalDay(d, nowDate)) {
    return `dnes ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  const yesterday = new Date(nowDate)
  yesterday.setDate(nowDate.getDate() - 1)
  if (isSameLocalDay(d, yesterday)) {
    return `včera ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  if (ageMs < WEEK_MS) {
    const wd = WEEKDAYS_CS_SHORT[(d.getDay() + 6) % 7]
    return `${wd} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  }
  if (ageMs < YEAR_MS) {
    return `${d.getDate()}. ${d.getMonth() + 1}.`
  }
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`
}

/**
 * Render `receivedAt` as the full Czech absolute timestamp shown on
 * hover/focus tooltips. Returns "" for missing/invalid input so callers
 * can safely pass straight to `title=`.
 *
 * @param {Date | number | string | null | undefined} receivedAt
 * @returns {string}
 */
export function formatAbsolute(receivedAt) {
  const d = toDate(receivedAt)
  if (!d) return ''
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
