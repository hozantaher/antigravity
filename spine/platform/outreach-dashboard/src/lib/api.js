// api.js — Sprint G12 (master issue #1241).
//
// Single canonical fetch wrapper for /api/* requests from the React app.
// Replaces four near-identical `const api = (path, opts) =>` helpers that
// lived inside Replies.jsx, ThreadDetail.jsx, Inbox.jsx, and
// CampaignDetail.jsx — drift risk + duplicated error-handling shape.
//
// Behavior matches the CampaignDetail variant (which was the richest of
// the four): on non-2xx the rejected error carries `err.status` +
// `err.details` so callers can branch on HTTP status without re-parsing
// the response body.
//
// Memory:
//   feedback_no_pii_in_commands — no inline credentials; uses Vite proxy
//   (dev) or relative path (prod) so the Content-Security-Policy stays
//   tight.
//   feedback_search_before_implement — verified no other api() shim
//   exists in src/lib/ before adding this one.

/**
 * @param {string} path — leading slash, e.g. "/replies?limit=30"
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 * @throws {Error & { status?: number, details?: any }}
 */
export function api(path, opts) {
  return fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  }).then(async (r) => {
    if (!r.ok) {
      let details = null
      try { details = await r.json() } catch { /* non-JSON */ }
      const err = new Error(details?.error || `${r.status} ${r.statusText}`)
      err.status = r.status
      err.details = details
      throw err
    }
    return r.json()
  })
}

export default api
