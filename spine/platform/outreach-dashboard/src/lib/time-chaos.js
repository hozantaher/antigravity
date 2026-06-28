// HX4 — Time-travel chaos library
//
// Pure-JS, deterministic, host-TZ-independent send-window math + clock-skew
// safety helpers. Mirrors the Go-side `services/common/calendar/sendwindow.go`
// contract (Mon–Fri 08:00..17:00 Europe/Prague, end exclusive).
//
// Why this exists:
//   • JS Date is locale-dependent. Server containers may run UTC, devs run
//     Europe/Prague, CI may run America/Los_Angeles. Using the host TZ leaks
//     into scheduling math and produces flaky bugs.
//   • Intl.DateTimeFormat with timeZone: 'Europe/Prague' is the only stdlib
//     primitive that's deterministic across hosts. We use it to extract Prague
//     wall-clock components and run all comparisons on those.
//
// DST handling decisions:
//   • Spring forward (last Sun in March, 02:00 CET → 03:00 CEST):
//     wall-clock 02:xx doesn't exist on that day. classifyWallClock on a
//     post-jump UTC instant maps to Prague 03:xx with occurrences=1.
//   • Fall back (last Sun in October, 03:00 CEST → 02:00 CET):
//     wall-clock 02:xx occurs twice. We detect this by checking if a UTC
//     instant +/- 1 hour produces the same Prague wall-clock minute. The send
//     window starts at 08:00, so the ambiguous hour never overlaps it — but
//     `classifyWallClock` is exposed for external use.
//   • Send-window math is computed entirely from extracted Prague wall-clock
//     components (year/month/day/hour/min/weekday), so DST shifts don't
//     produce off-by-one errors.
//
// Clock-skew safety:
//   • safeDuration clamps negative deltas (NTP backward) to 0, so token-bucket
//     refunds never go negative.
//   • Invalid Date inputs (NaN getTime) yield 0, never NaN/Infinity.

const PRAGUE_TZ = 'Europe/Prague'
const SEND_WINDOW_START_HOUR = 8 // 08:00 inclusive
const SEND_WINDOW_END_HOUR = 17 // 17:00 exclusive

// Long weekday names from Intl.DateTimeFormat({weekday:'long'}) for Prague.
// Used for Mon-Fri detection.
const WEEKDAY_BUSINESS = new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])

/**
 * Extract Prague wall-clock components from a Date.
 * Returns null if the input is not a valid Date.
 *
 * @param {Date} d
 * @returns {{
 *   year: number, month: number, day: number,
 *   hour: number, minute: number, second: number,
 *   weekday: string,
 * } | null}
 */
function pragueParts(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return null
  // Intl with weekday:'long' gives 'Monday' etc. — locale-independent for
  // 'en-US' base. We pin to 'en-US' so the weekday string is always English.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: PRAGUE_TZ,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(d)
  const lookup = {}
  for (const p of parts) {
    if (p.type !== 'literal') lookup[p.type] = p.value
  }
  // Edge: hour can be '24' in some Intl impls when crossing midnight; normalise.
  let hour = Number(lookup.hour)
  if (hour === 24) hour = 0
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour,
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: lookup.weekday,
  }
}

/**
 * Returns true iff `timestamp` is within the send window
 * (Mon-Fri 08:00..17:00 Europe/Prague, end exclusive).
 *
 * @param {Date} timestamp
 * @returns {boolean}
 */
export function isInSendWindow(timestamp) {
  const p = pragueParts(timestamp)
  if (!p) return false
  if (!WEEKDAY_BUSINESS.has(p.weekday)) return false
  if (p.hour < SEND_WINDOW_START_HOUR) return false
  if (p.hour >= SEND_WINDOW_END_HOUR) return false
  return true
}

// Day-of-week index: Monday=1..Sunday=7
const WEEKDAY_INDEX = {
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
  Sunday: 7,
}

/**
 * Find the UTC Date corresponding to Prague wall-clock 08:00:00 on the
 * given (year, month, day). Uses iterative refinement because the UTC
 * offset depends on whether that calendar day is in CET or CEST — and
 * around DST transitions the simple guess can be off by ±1h.
 *
 * @param {number} y
 * @param {number} m  1..12
 * @param {number} d  1..31
 * @returns {Date}
 */
function pragueWallClockToUTC(y, m, d, hour, minute) {
  // Initial guess: assume CET (UTC+1). Refine by checking actual Prague parts.
  // Up to two iterations are sufficient because the offset is ±1h and stable
  // outside of the 1-hour DST window — and we always target hour=8 which is
  // never in the DST gap (gap is 02:00-03:00).
  let guess = new Date(Date.UTC(y, m - 1, d, hour - 1, minute, 0)) // assume CET
  for (let i = 0; i < 3; i++) {
    const p = pragueParts(guess)
    if (!p) break
    // Compute the diff in minutes between target wall-clock and guess parts.
    // If guess.day matches target.day and hour matches → done.
    if (p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute) {
      return guess
    }
    // Compute shift in minutes (from current Prague wall-clock to target wall-clock).
    const guessMinutes = p.hour * 60 + p.minute + (p.day === d ? 0 : (p.day < d ? -24 * 60 : 24 * 60))
    const targetMinutes = hour * 60 + minute
    const deltaMinutes = targetMinutes - guessMinutes
    guess = new Date(guess.getTime() + deltaMinutes * 60_000)
  }
  return guess
}

/**
 * Returns the next send-window opening at or after `now`.
 * If `now` is already within the window, returns `now` unchanged.
 *
 * @param {Date} now
 * @returns {Date}
 */
export function nextSendWindowOpen(now) {
  if (isInSendWindow(now)) return now
  const p = pragueParts(now)
  if (!p) return now // can't compute — return input

  // Step 1: pick target calendar day in Prague.
  // If today is a business day and current Prague hour < 08:00 → today.
  // Otherwise → next business day (Mon-Fri).
  let targetY = p.year
  let targetM = p.month
  let targetD = p.day

  const isBizToday = WEEKDAY_BUSINESS.has(p.weekday)
  const beforeOpen = p.hour < SEND_WINDOW_START_HOUR

  if (!(isBizToday && beforeOpen)) {
    // Advance to next day (UTC arithmetic on the *Prague calendar day* — we
    // build a UTC noon date for that Prague day to get a reliable reference,
    // then add 24h until weekday is business).
    let cursor = new Date(Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0))
    while (true) {
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
      const cp = pragueParts(cursor)
      if (cp && WEEKDAY_BUSINESS.has(cp.weekday)) {
        targetY = cp.year
        targetM = cp.month
        targetD = cp.day
        break
      }
    }
  }

  return pragueWallClockToUTC(targetY, targetM, targetD, SEND_WINDOW_START_HOUR, 0)
}

/**
 * Returns ms until the next send-window opens. Returns 0 if currently inside.
 *
 * @param {Date} now
 * @returns {number}
 */
export function msUntilNextSendWindow(now) {
  if (isInSendWindow(now)) return 0
  const next = nextSendWindowOpen(now)
  if (!(next instanceof Date) || !Number.isFinite(next.getTime())) return 0
  const delta = next.getTime() - now.getTime()
  return delta > 0 ? delta : 0
}

/**
 * Returns true iff `t1` and `t2` belong to the same Prague calendar day.
 *
 * @param {Date} t1
 * @param {Date} t2
 * @returns {boolean}
 */
export function sameDay(t1, t2) {
  const a = pragueParts(t1)
  const b = pragueParts(t2)
  if (!a || !b) return false
  return a.year === b.year && a.month === b.month && a.day === b.day
}

/**
 * Detects whether the Prague wall-clock representation of `timestamp` is
 * ambiguous (i.e. occurs twice on its calendar day due to fall-back DST).
 * The UTC instant itself is always unambiguous; this checks the *wall clock*.
 *
 * Algorithm: take the Prague (y,m,d,hour,minute) of `timestamp`. Look at
 * timestamp ± 1h: if either also maps to the same Prague (y,m,d,hour,minute),
 * the wall-clock is ambiguous.
 *
 * @param {Date} timestamp
 * @returns {{ambiguous: boolean, occurrences: 1|2}}
 */
export function classifyWallClock(timestamp) {
  const p = pragueParts(timestamp)
  if (!p) return { ambiguous: false, occurrences: 1 }
  const offset = 60 * 60 * 1000
  const before = pragueParts(new Date(timestamp.getTime() - offset))
  const after = pragueParts(new Date(timestamp.getTime() + offset))
  const samePartsAs = (q) =>
    q && q.year === p.year && q.month === p.month && q.day === p.day && q.hour === p.hour && q.minute === p.minute
  const ambiguous = samePartsAs(before) || samePartsAs(after)
  return ambiguous ? { ambiguous: true, occurrences: 2 } : { ambiguous: false, occurrences: 1 }
}

/**
 * Format a Date as an RFC 5322 §3.3 date-time in the given IANA timezone.
 *
 * Output: "Mon, 02 Jan 2006 15:04:05 -0700" — wall-clock components and the
 * numeric offset both reflect `tz`. Used to set the outgoing `Date:` header
 * so the wire-MIME carries the mailbox's locale (typically Europe/Prague,
 * +0100/+0200) instead of UTC; some webmail clients display the header
 * timestamp verbatim, and a UTC stamp on a CZ-locale mailbox shows up to
 * the recipient as "2 hours behind" during CEST.
 *
 * @param {Date} now
 * @param {string} tz  IANA timezone, default 'Europe/Prague'
 * @returns {string}
 */
export function formatRFC5322Date(now, tz = 'Europe/Prague') {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    now = new Date()
  }
  // Wall-clock parts in tz (en-US locale → English weekday/month abbreviations).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(now)
  const lookup = {}
  for (const p of parts) if (p.type !== 'literal') lookup[p.type] = p.value
  let hour = Number(lookup.hour)
  if (hour === 24) hour = 0
  const hh = String(hour).padStart(2, '0')

  // Compute numeric offset for `tz` at this instant.
  // Trick: Intl emits "GMT+02:00" / "GMT-04:00" via timeZoneName='shortOffset'.
  // Map that to "+0200" / "-0400". Fallback to "+0000" if unavailable.
  let offset = '+0000'
  try {
    const offFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
      hour: 'numeric',
    })
    const tzPart = offFmt.formatToParts(now).find(p => p.type === 'timeZoneName')?.value || ''
    // tzPart shapes: "GMT+2", "GMT+02:00", "GMT", "UTC"
    const m = tzPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
    if (m) {
      const sign = m[1]
      const oh = String(parseInt(m[2], 10)).padStart(2, '0')
      const om = m[3] ?? '00'
      offset = `${sign}${oh}${om}`
    } else if (/^(GMT|UTC)$/.test(tzPart)) {
      offset = '+0000'
    }
  } catch { /* leave +0000 */ }

  return `${lookup.weekday}, ${lookup.day} ${lookup.month} ${lookup.year} ${hh}:${lookup.minute}:${lookup.second} ${offset}`
}

/**
 * Safe duration in ms between two Date instants.
 *  • Negative deltas (clock skew backward) → 0.
 *  • Invalid Date inputs (NaN getTime) → 0.
 *  • Identical instants → 0.
 * Never returns NaN, Infinity, or negative.
 *
 * @param {Date} start
 * @param {Date} end
 * @returns {number}
 */
export function safeDuration(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return 0
  const a = start.getTime()
  const b = end.getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  const delta = b - a
  if (!Number.isFinite(delta) || delta <= 0) return 0
  return delta
}
