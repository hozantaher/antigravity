// AW8-2: relay queue-depth observability proxy.
//
// GET /api/relay/queue-depth
//   Proxies anti-trace-relay GET /v1/status (Bearer-auth) and returns a
//   trimmed payload the dashboard sidebar/topbar uses to render a
//   backpressure indicator. Drives the visual warning when relay queue
//   approaches the AW4-2 backpressure cap (RELAY_MAX_QUEUE_DEPTH=100 by
//   default; PR #1193).
//
// Response shape:
//   {
//     ok: boolean,
//     queue_depth: number,
//     oldest_pending_age_seconds: number,   // -1 if queue empty
//     uptime_seconds: number,
//     bridge_status: 'ok' | 'unreachable' | null,
//     retry_queue_depth: number|null,       // AW8-3: greylist retry queue (post-AW7-5);
//                                           // null if relay version doesn't expose it.
//     reason?: string,                      // present when ok=false
//   }
//
// On ANTI_TRACE_RELAY_URL not configured: 200 { ok: false, reason }
// (UI hides the badge in this case — never blow up the dashboard for an
// optional observability feed).
//
// On relay 5xx / network failure: 200 { ok: false, reason } as above.
// Operator inspects Pozorovatelnost panel for the underlying alert.
//
// AW8-3 (forward-compat with AW7-5 greylist retry queue): the relay /v1/status
// payload may grow a `retry_queue_depth` field once Sprint AW7-5 lands in
// services/relay/web/server.go. Until then, this proxy reads the field
// defensively and returns null — the UI hides its retry-queue badge in that
// case. No coordination needed between BFF + relay deploys.

/**
 * @param {import('express').Express} app
 */
export function mountRelayQueueDepthRoute(app) {
  app.get('/api/relay/queue-depth', async (_req, res) => {
    const url = process.env.ANTI_TRACE_RELAY_URL || process.env.ANTI_TRACE_URL
    const token = process.env.ANTI_TRACE_RELAY_TOKEN || process.env.ANTI_TRACE_TOKEN
    if (!url || !token) {
      return res.json({
        ok: false,
        reason: 'ANTI_TRACE_RELAY_URL not configured',
        queue_depth: 0,
        oldest_pending_age_seconds: -1,
        uptime_seconds: 0,
        bridge_status: null,
        retry_queue_depth: null,
      })
    }
    try {
      const r = await fetch(`${url.replace(/\/+$/, '')}/v1/status`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4_000),
      })
      if (!r.ok) {
        return res.json({
          ok: false,
          reason: `relay status ${r.status}`,
          queue_depth: 0,
          oldest_pending_age_seconds: -1,
          uptime_seconds: 0,
          bridge_status: null,
          retry_queue_depth: null,
        })
      }
      const body = await r.json()
      // AW8-3: forward-compat — relay versions without AW7-5 greylist retry
      // queue support omit `retry_queue_depth`. Pass null through so the UI
      // can hide the retry-queue badge cleanly.
      const retryDepthRaw = body.retry_queue_depth
      const retryDepth = (typeof retryDepthRaw === 'number' && Number.isFinite(retryDepthRaw))
        ? retryDepthRaw
        : null
      return res.json({
        ok: true,
        queue_depth: Number(body.queue_depth ?? body.pending_envelopes ?? 0),
        oldest_pending_age_seconds: Number(body.oldest_pending_age_seconds ?? -1),
        uptime_seconds: Number(body.uptime_seconds ?? 0),
        bridge_status: body.bridge_status ?? null,
        retry_queue_depth: retryDepth,
      })
    } catch (err) {
      return res.json({
        ok: false,
        reason: `relay fetch error: ${err?.message || String(err)}`,
        queue_depth: 0,
        oldest_pending_age_seconds: -1,
        uptime_seconds: 0,
        bridge_status: null,
        retry_queue_depth: null,
      })
    }
  })
}
