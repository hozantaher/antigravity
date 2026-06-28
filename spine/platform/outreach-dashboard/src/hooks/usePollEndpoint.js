// usePollEndpoint.js
// ─────────────────────────────────────────────────────────────────────────────
// Thin adapter over useResource for the common sales-widget poll pattern:
//   first fetch on mount → setInterval(intervalMs) → pause on tab blur → cleanup
//
// Returns { data, error, refresh } — data is raw JSON or null, error is string or null.
//
// HARD feedback_no_magic_thresholds T0 — pass intervalMs as a named const at call site.
// HARD feedback_outreach_dashboard_local_only T0.
//
// Usage:
//   const { data, error, refresh } = usePollEndpoint('/api/dashboard/live-activity', 15_000)

import { useResource } from './useResource'

/**
 * Poll an endpoint with auto-refresh, visibility pause, and unmount cleanup.
 *
 * @param {string} url - Endpoint to poll.
 * @param {number} intervalMs - Polling cadence; use a named constant at the call site.
 * @param {{ credentials?: string }} [opts]
 * @returns {{ data: unknown, error: string|null, refresh: () => void }}
 */
export function usePollEndpoint(url, intervalMs, opts = {}) {
  const { status, data, error, refresh } = useResource(url, {
    pollMs: intervalMs,
    pauseHidden: true,
  })
  return {
    data,
    error: status === 'error' ? (error ?? 'Chyba načítání') : null,
    refresh,
  }
}
