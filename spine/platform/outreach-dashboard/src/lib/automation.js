/**
 * automation.js — Pure automation-engine helpers.
 * No side effects, no DB, no network.
 * Used by server.js automation engine.
 */

/**
 * Classifies the root cause of an SMTP failure from SMTP check steps.
 * Mirrors classifySmtpFailure() from mailboxUtils.js but operates on
 * the raw steps array (server-side, no import chain required).
 *
 * Returns:
 *   'proxy_fail'  — socks_dial failed (transient, proxy will rotate)
 *   'auth_fail'   — smtp_auth failed (permanent until credentials fixed)
 *   'tls_fail'    — TLS/STARTTLS failed (permanent-ish)
 *   'unknown'     — other failure
 *   null          — steps array is missing / ok (no failure)
 *
 * @param {Array<{name: string, ok: boolean}>|null|undefined} steps
 * @returns {'proxy_fail'|'auth_fail'|'tls_fail'|'unknown'|null}
 */
export function classifySmtpSteps(steps) {
  if (!Array.isArray(steps)) return null
  if (steps.find(s => s?.name === 'socks_dial' && !s.ok)) return 'proxy_fail'
  if (steps.find(s => s?.name === 'smtp_auth' && !s.ok)) return 'auth_fail'
  if (steps.find(s => (s?.name === 'tls_handshake' || s?.name === 'starttls') && !s.ok)) return 'tls_fail'
  return 'unknown'
}

/**
 * Determines whether a mailbox should be automatically paused based on
 * recent SMTP check history.
 *
 * @param {Array<{smtp_ok: boolean|null}>|null} recentHistory - Newest last.
 * @param {number} threshold - Number of consecutive failures required.
 * @returns {{pause: boolean, reason: string|null}}
 */
export function shouldAutoPause(recentHistory, threshold = 3) {
  if (!Array.isArray(recentHistory) || recentHistory.length < threshold) {
    return { pause: false, reason: null }
  }

  const tail = recentHistory.slice(-threshold)
  const allFailed = tail.every(r => r.smtp_ok === false)

  if (allFailed) {
    return { pause: true, reason: `auto: ${threshold} consecutive SMTP failures` }
  }

  return { pause: false, reason: null }
}

/**
 * Determines whether a paused mailbox should be automatically resumed.
 *
 * @param {{status: string, status_reason: string|null}|null} mb
 * @param {{checks: {smtp: {ok: boolean}}}|null} latestCheckResult
 * @returns {boolean}
 */
export function shouldAutoResume(mb, latestCheckResult) {
  if (!mb || !latestCheckResult) return false
  if (mb.status !== 'paused') return false
  if (typeof mb.status_reason !== 'string' || !mb.status_reason.startsWith('auto:')) return false

  // Optional chain avoids a silent catch swallowing unrelated runtime errors;
  // shape-mismatched input → `undefined === true` → false, which is the intent.
  return latestCheckResult?.checks?.smtp?.ok === true
}

/**
 * Classifies an inbound reply by subject and body.
 *
 * Priority: auto_reply > negative > positive > neutral
 *
 * @param {string} subject
 * @param {string} body
 * @returns {'positive' | 'negative' | 'auto_reply' | 'neutral'}
 */
export function classifyReply(subject = '', body = '') {
  const text = `${subject} ${body}`.toLowerCase()

  const autoReplyTerms = [
    'out of office', 'vacation', 'dovolená', 'nepřítomen',
    'mimo kancelář', 'auto-reply', 'abwesenheit',
  ]
  if (autoReplyTerms.some(t => text.includes(t))) return 'auto_reply'

  const negativeTerms = [
    'nechci', 'nemám zájem', 'odhlaste', 'unsubscrib',
    'stop', 'remove me', 'opt-out', 'nezasílejte', 'odmítám',
  ]
  if (negativeTerms.some(t => text.includes(t))) return 'negative'

  const positiveTerms = [
    'zájem', 'zajímá mě', 'pošlete', 'zavolejte',
    'schůzk', 'meeting', 'call', 'demo', 'rád bych', 'souhlasím',
  ]
  if (positiveTerms.some(t => text.includes(t))) return 'positive'

  return 'neutral'
}

/**
 * Determines send-rate throttle status.
 *
 * @param {number|string} sentToday
 * @param {number|string} limit
 * @returns {'ok' | 'warn' | 'block'}
 */
export function shouldThrottle(sentToday, limit) {
  const s = Number(sentToday)
  const l = Number(limit)

  if (l <= 0) return 'ok'
  if (s >= l) return 'block'
  if (s / l >= 0.8) return 'warn'
  return 'ok'
}

/**
 * Determines whether warm-up should be paused.
 *
 * @param {string} bounceClassification
 * @param {number} consecutiveBounces
 * @returns {boolean}
 */
export function shouldPauseWarmup(bounceClassification, consecutiveBounces) {
  return consecutiveBounces >= 5 || bounceClassification === 'critical'
}

/**
 * Classifies an SMTP error message into a category.
 *
 * Priority: auth_invalid > geo_block > timeout > proxy_dead > unknown
 *
 * @param {string} errorMessage
 * @returns {'auth_invalid' | 'geo_block' | 'timeout' | 'proxy_dead' | 'unknown'}
 */
export function classifySmtpError(errorMessage = '') {
  const msg = errorMessage.toLowerCase()

  if (msg.includes('535') || msg.includes('incorrect credentials') || msg.includes('authentication failed')) {
    return 'auth_invalid'
  }
  if (msg.includes('421') || msg.includes('not welcome here') || msg.includes('banned')) {
    return 'geo_block'
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
    return 'timeout'
  }
  if (
    msg.includes('econnrefused') ||
    msg.includes('connection refused') ||
    msg.includes('enotfound') ||
    msg.includes('socks')
  ) {
    return 'proxy_dead'
  }

  return 'unknown'
}

/**
 * Determines whether an error type warrants proxy failover.
 *
 * @param {string} errorType
 * @returns {boolean}
 */
export function isFailoverWorthy(errorType) {
  return ['geo_block', 'proxy_dead', 'timeout', 'auth_invalid'].includes(errorType)
}

/**
 * Returns the first proxy candidate not yet tried.
 *
 * @param {Array<{addr: string}>} rankedProxies
 * @param {string[]} triedAddrs
 * @returns {{addr: string} | null}
 */
export function nextProxyCandidate(rankedProxies, triedAddrs) {
  if (!Array.isArray(rankedProxies) || rankedProxies.length === 0) return null
  const tried = new Set(triedAddrs)
  return rankedProxies.find(p => !tried.has(p.addr)) ?? null
}

/**
 * Calculates new daily cap after bounce event.
 * warn → -20%, critical → -50%, floor 10. Other classifications → null (no change).
 *
 * @param {number} currentCap
 * @param {string} bounceClassification
 * @returns {number|null}
 */
export function calcNewDailyCap(currentCap, bounceClassification) {
  if (bounceClassification === 'warn')     return Math.max(10, Math.floor(currentCap * 0.8))
  if (bounceClassification === 'critical') return Math.max(10, Math.floor(currentCap * 0.5))
  return null
}

/**
 * Determines whether warmup_day should be incremented today.
 *
 * @param {{ smtpOk: boolean, bounceRate: number|null, consecutiveBounces: number, bounceClass: string }} opts
 * @returns {boolean}
 */
export function shouldAdvanceWarmup({ smtpOk, bounceRate, consecutiveBounces, bounceClass }) {
  if (!smtpOk) return false
  if (bounceRate !== null && bounceRate >= 5) return false
  if (shouldPauseWarmup(bounceClass, consecutiveBounces)) return false
  return true
}

/**
 * Maps a warmup day (1-indexed) to the target daily sending cap.
 * Linear ramp: day 1 → 20 emails, day 30 → 120 emails.
 * Clamped to [20, 120] — safe for day 0 (returns 20) and day > 30 (returns 120).
 *
 * @param {number} day  Warmup day number (1-indexed)
 * @returns {number}    Daily cap (integer, inclusive [20, 120])
 */
export function warmupDayToCap(day) {
  const safeDay = Math.max(1, day)
  return Math.min(120, Math.round(20 + (safeDay - 1) * (100 / 29)))
}

/**
 * Formats a daily operator health report.
 *
 * @param {Array<{email:string, status:string, score:number|null, critical:string[]}>} mailboxes
 * @param {string} date  ISO date string e.g. '2026-04-18'
 * @returns {{ subject: string, text: string }}
 */
export function formatDailyReport(mailboxes, date) {
  const total    = mailboxes.length
  const healthy  = mailboxes.filter(m => m.score != null && m.score >= 80).length
  const degraded = mailboxes.filter(m => m.score != null && m.score >= 50 && m.score < 80).length
  const critical = mailboxes.filter(m => m.score == null || m.score < 50).length
  const paused   = mailboxes.filter(m => m.status === 'paused').length

  const issues = mailboxes
    .filter(m => m.critical?.length)
    .flatMap(m => m.critical.map(c => `  • ${m.email}: ${c}`))

  const subject = `[Outreach Report] ${date} — ${healthy}/${total} zdravých schránek`
  const mbLines = mailboxes.map(m =>
    `  ${(m.score ?? '??').toString().padStart(3)} | ${m.status.padEnd(7)} | ${m.email}`
  )

  const text = [
    `Denní report: ${date}`,
    '',
    `Celkem schránek:  ${total}`,
    `  Zdravé  (≥80):  ${healthy}`,
    `  Varování(50-79):${degraded}`,
    `  Kritické(<50):  ${critical}`,
    `  Pozastavené:    ${paused}`,
    '',
    'Schránky:',
    ...mbLines,
    '',
    issues.length
      ? `Kritické problémy:\n${issues.join('\n')}`
      : 'Žádné kritické problémy.',
  ].join('\n')

  return { subject, text }
}

/**
 * Returns true when a reply classification warrants suppressing the contact.
 *
 * @param {string|null|undefined} classification
 * @returns {boolean}
 */
export function shouldSuppress(classification) {
  // 'unsubscribe' is an EXPLICIT opt-out ("nekontaktujte mě", "odhlásit") —
  // a stronger signal than 'negative' and a compliance obligation to honor.
  // It was previously missing here, so reclassified opt-outs were never
  // suppressed (gap found 2026-05-31 via reply id=101 "Nekontaktujte mě").
  return classification === 'negative' || classification === 'unsubscribe'
}

/**
 * Returns true when now falls within the allowed send window.
 *
 * Defaults: Mon–Fri 08:00–16:59 (end exclusive) in the given IANA timezone.
 *
 * Env overrides (read each call so operator changes take effect at next request):
 *   SEND_WINDOW_START_HOUR (0..24, default 8)
 *   SEND_WINDOW_END_HOUR   (0..24, default 17)
 *   SEND_WEEKDAYS_ONLY     ("false"/"0" disables — default true)
 *
 * Invalid / inverted ranges fall back to the safe 8–17 default. Set
 * START=0, END=24, SEND_WEEKDAYS_ONLY=false to allow 24/7 send.
 *
 * @param {Date} now
 * @param {string} tz  IANA timezone e.g. 'Europe/Prague'
 * @returns {boolean}
 */
export function isWithinSendWindow(now, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now)

  const get = type => parts.find(p => p.type === type)?.value
  const weekday = get('weekday')  // 'Mon','Tue',...
  let hour = parseInt(get('hour'), 10)
  if (hour === 24) hour = 0  // some Intl impls emit '24' at midnight
  const minute = parseInt(get('minute'), 10)

  let startH = parseInt(process.env.SEND_WINDOW_START_HOUR, 10)
  let endH = parseInt(process.env.SEND_WINDOW_END_HOUR, 10)
  if (!Number.isFinite(startH) || startH < 0 || startH > 24) startH = 8
  if (!Number.isFinite(endH) || endH < 0 || endH > 24) endH = 17
  if (endH <= startH) { startH = 8; endH = 17 }

  const weekdaysOnlyRaw = process.env.SEND_WEEKDAYS_ONLY
  const weekdaysOnly = weekdaysOnlyRaw === undefined
    ? true
    : !(weekdaysOnlyRaw === 'false' || weekdaysOnlyRaw === '0')

  if (weekdaysOnly && !['Mon','Tue','Wed','Thu','Fri'].includes(weekday)) return false
  const minuteOfDay = hour * 60 + minute
  return minuteOfDay >= startH * 60 && minuteOfDay < endH * 60
}

/**
 * Matches inbound IMAP messages to send_events by fromAddr and classifies them.
 *
 * @param {Array<{fromAddr:string, subject:string, snippet:string}>} messages
 * @param {Array<{id:number, contactId:number, contactEmail:string}>} sendEvents
 * @returns {Array<{sendEventId:number, contactId:number, classification:string}>}
 */
export function processImapReplies(messages, sendEvents) {
  const results = []
  for (const msg of messages) {
    const from = (msg.fromAddr || '').toLowerCase()
    const match = sendEvents.find(se => se.contactEmail.toLowerCase() === from)
    if (!match) continue
    const classification = classifyReply(msg.subject, msg.snippet)
    results.push({ sendEventId: match.id, contactId: match.contactId, classification, subject: msg.subject, fromAddr: msg.fromAddr })
  }
  return results
}

/**
 * Determines whether a bounce escalation pause should auto-resume.
 * Conditions: paused with bounce-escalation reason, cooldown elapsed, bounce rate recovered.
 *
 * @param {{ status: string, status_reason: string|null, daily_cap_reduced_at: string|null }} mb
 * @param {{ bounceRate: number|null, consecutiveBounces: number }} current
 * @returns {boolean}
 */
export function shouldResumeBounceEscalation(mb, current) {
  if (mb.status !== 'paused') return false
  if (mb.status_reason !== 'auto: sustained bounce warn — daily cap at floor') return false
  if (!mb.daily_cap_reduced_at) return false
  const age = Date.now() - new Date(mb.daily_cap_reduced_at).getTime()
  if (age < 24 * 60 * 60 * 1000) return false
  return (!current.bounceRate || current.bounceRate < 3) && current.consecutiveBounces === 0
}

/**
 * Determines whether an IMAP circuit breaker should open.
 *
 * @param {number} consecutiveFailures
 * @returns {{ open: boolean, durationMinutes: number }}
 */
export function imapCircuitDecision(consecutiveFailures) {
  if (consecutiveFailures < 5) return { open: false, durationMinutes: 0 }
  const durationMinutes = consecutiveFailures >= 10 ? 240 : 120
  return { open: true, durationMinutes }
}

/**
 * Returns true if auth failure count warrants circuit-breaking (pausing) the mailbox.
 *
 * @param {number} consecutiveAuthFailures
 * @returns {boolean}
 */
export function shouldBreakAuthCircuit(consecutiveAuthFailures) {
  return consecutiveAuthFailures >= 2
}

/**
 * Returns true if the score drop warrants a score-trend alert.
 *
 * @param {number|null} previousScore
 * @param {number|null} currentScore
 * @returns {boolean}
 */
export function isScoreDrop(previousScore, currentScore) {
  if (previousScore == null || currentScore == null) return false
  return (currentScore - previousScore) <= -20
}

/**
 * Returns true if a proxy should be proactively rotated (slow but alive).
 *
 * @param {{ ok: boolean, ms: number|null }|null} proxyCheck
 * @returns {boolean}
 */
export function shouldProactivelyRotateProxy(proxyCheck) {
  if (!proxyCheck) return false
  if (!proxyCheck.ok) return false
  return (proxyCheck.ms ?? 0) > 3000
}

/**
 * evaluateCampaignWatchdog — pure decision function for runCampaignWatchdogCron.
 *
 * Returns the action to take for a campaign given its send_events
 * aggregate. Extracted so the cron is just I/O orchestration and the
 * thresholds are unit-testable.
 *
 * Thresholds (matched to existing cron):
 *   - sent < 10: insufficient data → 'noop'
 *   - bounceRate > 5% AND sent ≥ 10: 'auto_pause'
 *   - sent ≥ 50 AND replyRate < 0.5%: 'low_performance' (advisory only)
 *   - otherwise: 'noop'
 *
 * @param {{ sent: number, bounced: number, replied: number }} agg
 * @returns {{
 *   action: 'noop'|'auto_pause'|'low_performance',
 *   bounceRate: number,
 *   replyRate: number,
 *   reason: string
 * }}
 */
export function evaluateCampaignWatchdog(agg) {
  const sent = Number(agg?.sent || 0)
  const bounced = Number(agg?.bounced || 0)
  const replied = Number(agg?.replied || 0)

  if (sent < 10) {
    return { action: 'noop', bounceRate: 0, replyRate: 0, reason: 'sent < 10 (insufficient data)' }
  }

  const bounceRate = bounced / sent
  const replyRate = replied / sent

  if (bounceRate > 0.05) {
    return {
      action: 'auto_pause',
      bounceRate,
      replyRate,
      reason: `bounce rate ${(bounceRate * 100).toFixed(1)}% > 5% threshold (${bounced}/${sent} sent)`,
    }
  }

  if (sent >= 50 && replyRate < 0.005) {
    return {
      action: 'low_performance',
      bounceRate,
      replyRate,
      reason: `reply rate ${(replyRate * 100).toFixed(2)}% after ${sent} sends — consider reviewing template`,
    }
  }

  return { action: 'noop', bounceRate, replyRate, reason: 'within thresholds' }
}

/**
 * computeImapNewUids — pure delta function for runImapPollCron (#27 fix).
 *
 * Replaces the previous `unseen > prev_unseen` count delta with a
 * UID-watermark approach robust to external mark-read races.
 *
 * Rules:
 *   1. UIDVALIDITY changed (prev != current, both non-null) → process all
 *      unseen UIDs (mailbox was recreated, watermark no longer applies)
 *   2. First poll (prev_uid is null) → process all unseen UIDs
 *   3. Otherwise → process UIDs strictly greater than prev_uid
 *
 * Watermark advances monotonically (never moves backward) except on
 * UIDVALIDITY change where we reset the reference frame.
 *
 * @param {{
 *   uids: number[],
 *   uidValidity: number|null,
 *   prevUid: number|null|undefined,
 *   prevUidValidity: number|null|undefined
 * }} input
 * @returns {{ newUids: number[], nextWatermark: number|null, validityChanged: boolean }}
 */
export function computeImapNewUids({ uids = [], uidValidity = null, prevUid = null, prevUidValidity = null }) {
  const validityChanged = prevUidValidity != null && uidValidity != null && prevUidValidity !== uidValidity
  const watermark = validityChanged ? null : (prevUid ?? null)
  const newUids = watermark != null ? uids.filter(u => u > watermark) : [...uids]
  const maxUid = uids.length > 0 ? Math.max(...uids) : null
  let nextWatermark
  if (validityChanged) {
    nextWatermark = maxUid
  } else if (watermark != null && maxUid != null) {
    nextWatermark = Math.max(watermark, maxUid)
  } else {
    nextWatermark = maxUid ?? watermark
  }
  return { newUids, nextWatermark, validityChanged }
}

// ════════════════════════════════════════════════════════════════════════
// BF-A2 — Greylist retry decision logic (pure)
// ════════════════════════════════════════════════════════════════════════
//
// Two pure decisions extracted from runGreylistRetryCron + the mailbox
// variant. Both crons mix decision + I/O; tests live on the decision.

/**
 * Per-item decision for the email_verify_queue greylist retry loop.
 * Determines whether an item should be given up on or retried.
 *
 * @param {{ attempts: number|null|undefined, maxAttempts: number }} input
 * @returns {{ action: 'give_up'|'retry', reason: string }}
 */
export function evaluateGreylistQueueItem({ attempts, maxAttempts }) {
  const a = Number(attempts || 0)
  const cap = Number(maxAttempts)
  if (!Number.isFinite(cap) || cap < 1) {
    return { action: 'retry', reason: 'invalid maxAttempts; default to retry' }
  }
  if (a >= cap) {
    return { action: 'give_up', reason: `attempts ${a} >= max ${cap}` }
  }
  return { action: 'retry', reason: `attempts ${a} < max ${cap}` }
}

/**
 * Decides whether a paused mailbox should be auto-resumed after a
 * health-cycle check. Conservative: only resume when (1) status was
 * specifically auto-paused (status_reason starts with 'auto:'), (2) the
 * latest score is healthy (>= scoreFloor, default 80), (3) the score is
 * fresh (last_score_at within freshnessMs).
 *
 * The check WHERE clause guards against a manual pause being silently
 * overwritten by the recovery cron — operator-set status_reason like
 * 'manual: ops' must NOT be auto-resumed.
 *
 * @param {{
 *   status: string,
 *   status_reason: string|null,
 *   last_score: number|null,
 *   last_score_at: Date|string|null,
 * }} mb
 * @param {{ scoreFloor?: number, freshnessMs?: number, now?: Date }} [opts]
 * @returns {{ action: 'resume'|'skip', reason: string }}
 */
export function evaluateMailboxAutoResume(mb, opts = {}) {
  const scoreFloor = opts.scoreFloor ?? 80
  const freshnessMs = opts.freshnessMs ?? 10 * 60 * 1000
  const now = opts.now ?? new Date()
  if (!mb || mb.status !== 'paused') {
    return { action: 'skip', reason: 'not paused' }
  }
  if (!mb.status_reason || !/^auto:/.test(String(mb.status_reason))) {
    return { action: 'skip', reason: 'not auto-paused (manual reason preserved)' }
  }
  const score = Number(mb.last_score)
  if (!Number.isFinite(score) || score < scoreFloor) {
    return { action: 'skip', reason: `score ${score} < floor ${scoreFloor}` }
  }
  if (!mb.last_score_at) {
    return { action: 'skip', reason: 'no last_score_at — cannot trust freshness' }
  }
  const at = mb.last_score_at instanceof Date ? mb.last_score_at : new Date(mb.last_score_at)
  if (Number.isNaN(at.getTime())) {
    return { action: 'skip', reason: 'invalid last_score_at' }
  }
  if (now.getTime() - at.getTime() > freshnessMs) {
    return { action: 'skip', reason: `score stale: ${Math.round((now - at) / 60000)}min old` }
  }
  return { action: 'resume', reason: `score ${score} ≥ ${scoreFloor} and fresh` }
}

/**
 * BF-A6 — Compute the next daily-fire instant in a given IANA time zone.
 *
 * Replaces the buggy server.js scheduler that used `getTimezoneOffset()`
 * (server-local, not Prague) and a fixed 24h `setInterval` (drifts on
 * DST transitions: CET→CEST shrinks the day to 23h, CEST→CET stretches
 * to 25h).
 *
 * Returns a Date that is the *next* moment when wall-clock time in `tz`
 * reads `hour:00:00`. If the time has already passed today in `tz`,
 * returns tomorrow's instant.
 *
 * Implementation note: we trust the runtime's IANA database via
 * Intl.DateTimeFormat. We compute the offset *for the target instant*
 * (not for `now`) so DST boundary days are handled correctly.
 *
 * @param {Date} now - current instant
 * @param {number} hour - 0..23
 * @param {string} [tz='Europe/Prague']
 * @returns {Date}
 */
export function computeNextDailyFire(now, hour, tz = 'Europe/Prague') {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('computeNextDailyFire: now must be a valid Date')
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError('computeNextDailyFire: hour must be 0..23')
  }
  // Render `now` in the target tz to get its calendar day.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  // Try today, then tomorrow if already past.
  for (let bumpDays = 0; bumpDays <= 1; bumpDays++) {
    const yyyy = Number(parts.year)
    const mm = Number(parts.month) - 1
    const dd = Number(parts.day) + bumpDays
    // Build a candidate UTC instant; then offset to local-tz.
    // We iterate to find the right offset (handles DST transitions).
    let candidate = new Date(Date.UTC(yyyy, mm, dd, hour, 0, 0, 0))
    for (let i = 0; i < 3; i++) {
      const renderedHour = Number(
        new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', hour12: false }).format(candidate)
      )
      if (renderedHour === hour) break
      // Adjust by the difference in hours.
      const delta = hour - renderedHour
      // Wrap small deltas around midnight (e.g. -23 → +1)
      const adj = delta > 12 ? delta - 24 : delta < -12 ? delta + 24 : delta
      candidate = new Date(candidate.getTime() + adj * 3600 * 1000)
    }
    if (candidate.getTime() > now.getTime()) return candidate
  }
  // Fallback: shouldn't reach here.
  return new Date(now.getTime() + 24 * 3600 * 1000)
}

/**
 * BF-A5 — Email reverify batch budget (pure).
 *
 * The reverify cron picks N rows per run to re-validate stale entries.
 * Picking too many at once risks tripping outbound SMTP abuse heuristics
 * on our shared egress; picking too few starves the queue. This fn
 * decides the cap given:
 *   - stale: how many rows are eligible
 *   - defaultBatch (default 200): nominal per-run budget
 *   - dailyMax (default 1000): hard ceiling per UTC day
 *   - alreadyToday: how many already verified in current UTC day
 *
 * Returns 0 when the daily cap is exhausted (cron should noop).
 *
 * @param {{
 *   stale: number,
 *   alreadyToday?: number,
 * }} input
 * @param {{ defaultBatch?: number, dailyMax?: number }} [opts]
 * @returns {{ batch: number, reason: string }}
 */
export function computeReverifyBudget({ stale, alreadyToday = 0 }, opts = {}) {
  const defaultBatch = opts.defaultBatch ?? 200
  const dailyMax = opts.dailyMax ?? 1000
  const s = Number(stale || 0)
  const a = Number(alreadyToday || 0)
  if (s <= 0) return { batch: 0, reason: 'no stale rows' }
  if (a >= dailyMax) return { batch: 0, reason: `daily cap reached (${a} >= ${dailyMax})` }
  const remaining = dailyMax - a
  const batch = Math.min(defaultBatch, remaining, s)
  return { batch, reason: `pick ${batch} (stale=${s} remaining=${remaining})` }
}

/**
 * BF-A4 — Per-mailbox bounce-throttle decision (pure).
 * Mirrors the cascade in mailboxBounceThrottle.js. Returns one of:
 *   - 'pause'     — bounce_rate >= 10% OR consecutive_bounces >= 5
 *   - 'throttle'  — bounce_rate >= 5% OR consecutive_bounces >= 3 AND
 *                   currentCap > floor (newCap < currentCap is a real change)
 *   - 'at_floor'  — would throttle but cap already at/below floor (no change)
 *   - 'noop'      — within healthy thresholds OR insufficient data
 *
 * @param {{
 *   bounceRate: number|string|null,
 *   consecutiveBounces: number|string|null,
 *   totalSent: number|string|null,
 *   currentCap: number|string|null|undefined,
 * }} input
 * @param {{ floor?: number, defaultCap?: number, minSent?: number }} [opts]
 * @returns {{ action: 'pause'|'throttle'|'at_floor'|'noop', newCap?: number, reason: string }}
 */
export function evaluateBounceThrottleAction(input, opts = {}) {
  const floor = opts.floor ?? 10
  const defaultCap = opts.defaultCap ?? 90
  const minSent = opts.minSent ?? 10
  const sent = Number(input.totalSent || 0)
  if (sent < minSent) {
    return { action: 'noop', reason: `total_sent ${sent} < ${minSent}` }
  }
  const rate = Number(input.bounceRate || 0)
  const cb = Number(input.consecutiveBounces || 0)
  if (rate >= 10 || cb >= 5) {
    return { action: 'pause', reason: `bounce_rate ${rate.toFixed(1)}% / consecutive ${cb}` }
  }
  if (rate >= 5 || cb >= 3) {
    const cap = Number(input.currentCap) || defaultCap
    const newCap = Math.max(floor, Math.floor(cap * 0.5))
    if (newCap >= cap) {
      return { action: 'at_floor', newCap: cap, reason: `cap ${cap} at/below floor ${floor}` }
    }
    return { action: 'throttle', newCap, reason: `cap ${cap}→${newCap} (rate ${rate.toFixed(1)}% / cb ${cb})` }
  }
  return { action: 'noop', reason: `within thresholds (rate ${rate.toFixed(1)}% / cb ${cb})` }
}

/**
 * Per-mailbox decision after re-running the full check on a greylisted
 * mailbox. Mirrors the if/else cascade in runMailboxGreylistRetryCron.
 *
 * `smtp` is the smtp check sub-object (or null/undefined).
 * `isGreylistedFn` is injected so tests don't need the real heuristic.
 *
 * @param {object|null|undefined} smtp
 * @param {(s: object|null|undefined) => boolean} isGreylistedFn
 * @returns {{ action: 'clear'|'resolve_other'|'still_greylisted', reason: string }}
 */
export function evaluateMailboxGreylistResult(smtp, isGreylistedFn) {
  if (typeof isGreylistedFn !== 'function') {
    throw new TypeError('evaluateMailboxGreylistResult: isGreylistedFn must be a function')
  }
  if (smtp && smtp.ok === true) {
    return { action: 'clear', reason: 'smtp.ok=true → greylisting lifted' }
  }
  if (!isGreylistedFn(smtp)) {
    return { action: 'resolve_other', reason: 'non-greylist failure; let automation decide' }
  }
  return { action: 'still_greylisted', reason: '451/temporary persists' }
}

// ── AM2: Contact verify loop pure helpers ────────────────────────────────

/**
 * AM2 — Maps a verifyEmail() result object to a contacts.email_status value.
 *
 * Valid email_status values (from 066_email_verify_state.sql constraint):
 *   unverified | verifying | valid | role_only | risky | invalid | spamtrap | bounce_hold | suppressed | catch_all
 *
 * @param {{ status: string, is_spamtrap?: boolean, is_catch_all?: boolean, is_role?: string }} result
 * @returns {string}
 */
export function classifyContactStatus(result) {
  if (!result || typeof result !== 'object') return 'risky'
  const s = String(result.status ?? '').toLowerCase()
  // Direct passthrough for statuses that map 1:1
  if (s === 'valid')     return 'valid'
  if (s === 'invalid')   return 'invalid'
  if (s === 'spamtrap')  return 'spamtrap'
  if (s === 'role_only') return 'role_only'
  if (s === 'catch_all') return 'catch_all'
  if (s === 'risky')     return 'risky'
  if (s === 'unverified') return 'risky'  // treat unverified probe result as risky
  // Fallback: unknown status from probe → risky (will retry)
  return 'risky'
}

/**
 * AM2 — Computes next scheduled verify timestamp for a contact.
 *
 * Returns null for terminal statuses (invalid, spamtrap) — don't reverify.
 * Returns an ISO string (or Date) for everything else.
 *
 * @param {string} status  — email_status after verification
 * @param {number} attempts — total attempts AFTER current increment
 * @returns {Date|null}
 */
export function computeContactNextVerifyAt(status, attempts) {
  const s = String(status ?? '').toLowerCase()
  const a = Number(attempts) || 1

  // Terminal — never reverify
  if (s === 'invalid' || s === 'spamtrap') return null
  // 5+ attempts on risky → permanent invalid (caller must flip status)
  if (s === 'risky' && a >= 5) return null

  const now = Date.now()
  if (s === 'valid')     return new Date(now + 90  * 24 * 60 * 60 * 1000)  // 90 days
  if (s === 'role_only') return new Date(now + 180 * 24 * 60 * 60 * 1000)  // 180 days
  if (s === 'catch_all') return new Date(now + 90  * 24 * 60 * 60 * 1000)  // 90 days

  // risky / bounce_hold / anything else → exponential backoff
  return computeContactRetryAt(a)
}

/**
 * AM2 — Exponential backoff for contact verify retries.
 *
 * attempt 1 → +1h
 * attempt 2 → +6h
 * attempt 3 → +24h
 * attempt 4 → +7d
 * attempt 5+ → null (give up — caller marks invalid)
 *
 * @param {number} attempt — 1-based attempt number
 * @returns {Date|null}
 */
export function computeContactRetryAt(attempt) {
  const a = Number(attempt) || 1
  if (a >= 5) return null
  const now = Date.now()
  const delays = [
    1   * 60 * 60 * 1000,   // 1h
    6   * 60 * 60 * 1000,   // 6h
    24  * 60 * 60 * 1000,   // 24h
    7   * 24 * 60 * 60 * 1000, // 7d
  ]
  const ms = delays[Math.min(a - 1, delays.length - 1)]
  return new Date(now + ms)
}
