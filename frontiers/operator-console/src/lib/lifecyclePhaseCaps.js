// lifecyclePhaseCaps.js — AC2 (2026-05-14) + AJ10d (2026-05-16)
//
// Single source of truth (JS side) for mailbox lifecycle phase → daily-send
// cap mapping. Mirrors the DB function `compute_phase_cap(text)` in
// migration 116 (Sprint AG1.5, 2026-05-15). Operators see these caps in the
// `<DailyLimitCard>` inside MailboxDrawer (AC2) and the BFF endpoint
// GET /api/mailboxes/:id/today-usage uses the same constants.
//
// HARD RULE feedback_no_magic_thresholds (T0): never inline cap literals
// (10/30/70/120/180) anywhere else — import them from here.
//
// Authoritative source: migration 116 (operator-180 schedule).
// Verified 2026-05-16 via `psql \df compute_phase_cap` on PROD:
//   warmup_d0  →  10
//   warmup_d3  →  30
//   warmup_d7  →  70
//   warmup_d14 → 120
//   production → 180
// If the DB function changes, update this file in lockstep.

/**
 * Day count where each phase begins. Days are measured against the
 * mailbox `created_at` timestamp (NOW() - created_at) per
 * `advance_lifecycle_phase()` SQL function. Day 0 is the creation day.
 */
export const PHASE_THRESHOLD_DAYS = {
  warmup_d0:  0,
  warmup_d3:  3,
  warmup_d7:  7,
  warmup_d14: 14,
  production: 30,
}

/**
 * Daily send cap per lifecycle phase. Mirrors the DB function
 * `compute_phase_cap(phase text)` in migration 116 (Sprint AG1.5,
 * 2026-05-15). The trigger `trg_enforce_warmup_cap` on `send_events`
 * enforces this on the DB side — the BFF surface only displays it.
 *
 *  warmup_d0  →  10/day  (Day 0–2: hand-warmed, tight cap)
 *  warmup_d3  →  30/day  (Day 3–6: light reply-detection traffic)
 *  warmup_d7  →  70/day  (Day 7–13: light campaign traffic)
 *  warmup_d14 → 120/day  (Day 14–29: production-adjacent)
 *  production → 180/day  (Day 30+: full per-mailbox budget)
 */
export const PHASE_CAPS = {
  warmup_d0:   10,
  warmup_d3:   30,
  warmup_d7:   70,
  warmup_d14: 120,
  production: 180,
}

/**
 * Default cap returned when the lifecycle phase string is missing or
 * unrecognized. Conservative (matches warmup_d0) so a fresh / corrupted
 * row never accidentally hands the engine a 100/day budget.
 */
export const DEFAULT_PHASE_CAP = PHASE_CAPS.warmup_d0

/**
 * Ordered phase progression — used to look up the "next" phase for
 * the `phase_advances_at` projection on the today-usage endpoint.
 *
 * Last phase (`production`) has no next phase. Consumers should check
 * for `null` from nextPhase().
 */
export const PHASE_ORDER = ['warmup_d0', 'warmup_d3', 'warmup_d7', 'warmup_d14', 'production']

/**
 * Lookup the daily cap for a phase string. Unknown phase → DEFAULT_PHASE_CAP.
 * @param {string | null | undefined} phase
 * @returns {number}
 */
export function capForPhase(phase) {
  if (phase == null || typeof phase !== 'string') return DEFAULT_PHASE_CAP
  return PHASE_CAPS[phase] ?? DEFAULT_PHASE_CAP
}

/**
 * The phase that comes immediately after `phase` in the warmup progression.
 * Returns `null` if `phase` is already `production` or unrecognized.
 * @param {string | null | undefined} phase
 * @returns {string | null}
 */
export function nextPhase(phase) {
  if (phase == null || typeof phase !== 'string') return null
  const idx = PHASE_ORDER.indexOf(phase)
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return null
  return PHASE_ORDER[idx + 1]
}

/**
 * Resolve the effective cap, applying the `daily_cap_override` semantics
 * described in CLAUDE.md: override may LOWER the phase cap, never raise it.
 *
 * If override is null/undefined/<=0, return the raw phase cap.
 * Otherwise return min(phase_cap, override).
 *
 * @param {string | null | undefined} phase
 * @param {number | null | undefined} override
 * @returns {{ phase_cap: number, effective_cap: number, cap_source: 'lifecycle_phase' | 'daily_cap_override' }}
 */
export function resolveEffectiveCap(phase, override) {
  const phaseCap = capForPhase(phase)
  const numOverride = Number(override)
  if (!Number.isFinite(numOverride) || numOverride <= 0) {
    return { phase_cap: phaseCap, effective_cap: phaseCap, cap_source: 'lifecycle_phase' }
  }
  if (numOverride < phaseCap) {
    return { phase_cap: phaseCap, effective_cap: numOverride, cap_source: 'daily_cap_override' }
  }
  return { phase_cap: phaseCap, effective_cap: phaseCap, cap_source: 'lifecycle_phase' }
}

/**
 * Given a mailbox creation timestamp + current phase, compute the next
 * 03:00 Europe/Prague after the timestamp at which the phase would
 * advance. Implementation note: phase advancement is gated by the DB
 * cron `runLifecyclePhaseAdvanceCron` which runs at 03:00 Prague daily
 * and calls `advance_lifecycle_phase()`. The actual phase flip happens
 * the morning after the day threshold is crossed.
 *
 * Returns null when:
 *   - phase is already `production` (terminal)
 *   - createdAt is invalid
 *
 * @param {string | Date | null | undefined} createdAt
 * @param {string | null | undefined} phase
 * @param {Date} [now]
 * @returns {Date | null}
 */
export function nextPhaseAdvanceAt(createdAt, phase, now = new Date()) {
  if (!createdAt || phase === 'production') return null
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt)
  if (Number.isNaN(created.getTime())) return null
  const next = nextPhase(phase)
  if (!next) return null
  const thresholdDays = PHASE_THRESHOLD_DAYS[next]
  if (thresholdDays == null) return null

  // Earliest UTC moment at which the row qualifies for the next phase
  // (created_at + threshold_days). The cron runs at 03:00 Europe/Prague
  // after that moment — i.e. either 03:00 same day if we are before
  // 03:00 Prague, or 03:00 next day.
  const eligibleAt = new Date(created.getTime() + thresholdDays * 24 * 60 * 60 * 1000)

  // Find the next 03:00 Europe/Prague slot AT OR AFTER eligibleAt.
  return nextPragueCronTick(eligibleAt, now)
}

/**
 * Helper: returns the next 03:00 Europe/Prague timestamp >= candidate,
 * but also >= now (so already-expired ticks don't appear in the future).
 *
 * @param {Date} candidate
 * @param {Date} now
 * @returns {Date}
 */
function nextPragueCronTick(candidate, now) {
  const target = candidate.getTime() > now.getTime() ? candidate : now
  // Find the Prague offset for the target instant (handles DST). Format
  // the target as YYYY-MM-DD in Europe/Prague then build a 03:00 ISO.
  const dayInPrague = new Date(target.toLocaleString('en-US', { timeZone: 'Europe/Prague' }))
  const year  = dayInPrague.getFullYear()
  const month = dayInPrague.getMonth()
  const date  = dayInPrague.getDate()
  // Build 03:00 Prague for that day. Construct from a wall-clock string
  // so DST is interpreted in-zone.
  const y = String(year)
  const m = String(month + 1).padStart(2, '0')
  const d = String(date).padStart(2, '0')
  // Use sv-SE for ISO-ish formatting; build candidate at 03:00 Prague.
  const pragueWallClock = new Date(`${y}-${m}-${d}T03:00:00`)
  // pragueWallClock is parsed as local time (operator's TZ) — recompute
  // by using a known anchor. Simpler: enumerate possibilities.
  // Use a robust offset-aware build via Intl: get the Prague offset at
  // the candidate ms, then construct the 03:00 instant.
  const offsetMin = getPragueOffsetMinutes(target)
  // 03:00 Prague === 03:00 - offset in UTC.
  const utc03 = Date.UTC(year, month, date, 3, 0, 0) - offsetMin * 60 * 1000
  if (utc03 >= target.getTime()) return new Date(utc03)
  // Past 03:00 today — roll to tomorrow.
  const utcNext = Date.UTC(year, month, date + 1, 3, 0, 0) - offsetMin * 60 * 1000
  return new Date(utcNext)
}

/**
 * Compute the offset (minutes east of UTC) for Europe/Prague at the
 * given instant. Handles DST without external dependencies — relies on
 * Intl.DateTimeFormat tokens.
 * @param {Date} at
 * @returns {number}
 */
function getPragueOffsetMinutes(at) {
  // Format the target in Europe/Prague and in UTC, then diff the parts.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Prague',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(at)
  const get = (t) => Number(parts.find(p => p.type === t)?.value)
  const pragueMs = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') === 24 ? 0 : get('hour'),
    get('minute'),
    get('second'),
  )
  // Diff between Prague wall-clock and the UTC instant of `at`. Round to
  // nearest minute (avoids sub-minute fp drift).
  return Math.round((pragueMs - at.getTime()) / 60000)
}
