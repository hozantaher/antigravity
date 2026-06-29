// Helpers for staleness indicators on polling widgets.
//
// Motivation: `useResource` exposes `loadedAt` (Date of last successful load),
// but once a poll starts failing the UI shows an error banner with no hint
// of HOW old the still-visible data is. These helpers feed a tiny corner
// badge (see components/StaleIndicator.jsx).

function toMs(loadedAt) {
  if (loadedAt == null) return null
  if (loadedAt instanceof Date) return loadedAt.getTime()
  const t = new Date(loadedAt).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * formatAge(loadedAt, now?) → Czech relative-time string.
 *   < 5 s          → "právě teď"
 *   < 60 s         → "před 5 s"
 *   < 60 min       → "před 2 min"
 *   otherwise      → "před 1 h"
 *
 * Returns '—' when loadedAt is missing/unparseable. Treats future timestamps
 * (clock skew) as "právě teď" rather than letting negative numbers leak.
 */
export function formatAge(loadedAt, now = Date.now()) {
  const t = toMs(loadedAt)
  if (t == null) return '—'
  const ms = now - t
  if (ms < 5000) return 'právě teď'
  if (ms < 60_000) return `před ${Math.floor(ms / 1000)} s`
  if (ms < 3_600_000) return `před ${Math.floor(ms / 60_000)} min`
  return `před ${Math.floor(ms / 3_600_000)} h`
}

/**
 * isStale(loadedAt, pollMs, now?) → true when age > pollMs * 2.5.
 *
 * Rule of thumb: a single missed interval is expected (network blip), but
 * 2.5× means we have skipped multiple polls and the data is untrustworthy.
 * Returns false when loadedAt is missing or pollMs is non-positive (no
 * polling → nothing to go stale against).
 */
export function isStale(loadedAt, pollMs, now = Date.now()) {
  const t = toMs(loadedAt)
  if (t == null) return false
  if (!Number.isFinite(pollMs) || pollMs <= 0) return false
  return (now - t) > pollMs * 2.5
}
