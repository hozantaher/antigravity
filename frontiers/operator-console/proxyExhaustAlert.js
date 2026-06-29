// Aggregator for `proxy_reassign_exhausted` watchdog events. Pure function so
// the trigger logic is testable without a DB — endpoint just hands over the
// SELECTed rows and renders the result.
//
// "Exhausted" fires when proxyReassignGuard tried every proxy in the pool and
// none passed AUTH. If this happens repeatedly within a short window, the
// pool is effectively unusable and the user needs to see a red banner — not
// just a silent "still null" return in stderr.

const DEFAULT_WINDOW_MS = 10 * 60 * 1000
const TRIGGER_THRESHOLD = 2

function toMs(ts) {
  if (ts instanceof Date) return ts.getTime()
  const n = new Date(ts).getTime()
  return Number.isFinite(n) ? n : 0
}

export function aggregateProxyExhaust(rows, now = new Date(), windowMs = DEFAULT_WINDOW_MS) {
  const cutoff = (now instanceof Date ? now.getTime() : Date.now()) - windowMs
  const recent = (rows || []).filter(r => toMs(r.created_at) >= cutoff)
  const mailboxesAffected = [...new Set(recent.map(r => r.mailbox_id).filter(v => v != null))].sort((a, b) => a - b)
  const count = recent.length
  const triggered = count >= TRIGGER_THRESHOLD
  const sinceMs = recent.length ? Math.min(...recent.map(r => toMs(r.created_at))) : null
  return {
    count,
    triggered,
    since: sinceMs ? new Date(sinceMs).toISOString() : null,
    mailboxes_affected: mailboxesAffected,
    severity: triggered ? 'error' : (count > 0 ? 'warn' : 'ok'),
    window_ms: windowMs,
    threshold: TRIGGER_THRESHOLD,
  }
}

export const PROXY_EXHAUST_CONSTANTS = {
  DEFAULT_WINDOW_MS,
  TRIGGER_THRESHOLD,
}
