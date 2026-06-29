// BFF inbound thread real-time stream surface.
// ─────────────────────────────────────────────────────────────────────────────
// Backs the React inbound triage workflow (memory `feedback_operator_focus`
// T1 — primary axis = inbound triage/classify/reply). Clients open
// `EventSource('/api/threads/stream')` and receive an `inbound` event each
// time orchestrator's RecordInbound issues PG NOTIFY on the
// `thread_inbound` channel (orchestrator side wired in S3.2). The UI then
// refetches `/api/threads/:id/messages` (Go-proxied, not BFF-owned) to pull
// the new payload.
//
// PG LISTEN/NOTIFY is fire-and-forget; if the BFF is down at notify time
// the event is lost. UI's 30s polling fallback (S3.3) catches gaps. The
// LISTEN client is a single dedicated pg connection that holds open for
// the life of the BFF process. Connection is lazy: first SSE subscriber
// boots it, subsequent ones share. On error the listener resets and the
// next subscriber re-subscribes.
//
// Sprint G3 (2026-05-03): extracted verbatim from server.js per ADR-008
// D2 module sequence (after #690 mailboxes Batch A G1). Behavior is
// byte-equivalent to the inline declarations: same SSE headers, same
// hello/inbound/heartbeat envelope, same warn-only failure modes on
// LISTEN setup, same close-driven cleanup.
//
// Routes mounted (1 total):
//   GET /api/threads/stream
//
// State owned by this module (was inline at server.js scope):
//   - threadStreamClients : Set<Response>   — active SSE subscribers
//   - threadListenClient  : pg.Client|null  — dedicated LISTEN connection
//   - publishThreadEvent  : (payload) => void
//   - ensureThreadListenClient : async () => void
//
// HARD RULE — `feedback_anti_trace_full_stack`: this handler does not
// dial SMTP/IMAP. It only reads from PG NOTIFY and fans out to SSE
// subscribers. No relay/proxy concerns.

/**
 * Mount the inbound thread SSE surface on an Express app.
 *
 * @param {import('express').Express} app
 * @param {{
 *   pool: import('pg').Pool,
 * }} deps
 */
export function mountThreadsRoutes(app, { pool }) {
  // SSE: real-time inbound thread events (mail-client S3.1).
  const threadStreamClients = new Set()

  function publishThreadEvent(payload) {
    if (threadStreamClients.size === 0) return
    let line
    try {
      line = `event: inbound\ndata: ${JSON.stringify(payload)}\n\n`
    } catch {
      return
    }
    for (const res of threadStreamClients) {
      try { res.write(line) } catch { /* swept by close */ }
    }
  }

  // PG LISTEN client — single dedicated connection that holds open for the
  // life of the BFF process. Connection is lazy: first SSE subscriber boots
  // it, subsequent ones share. On error the listener is reset; the next
  // subscriber re-subscribes.
  let threadListenClient = null
  async function ensureThreadListenClient() {
    if (threadListenClient) return
    try {
      const c = await pool.connect()
      c.on('notification', (msg) => {
        if (msg.channel !== 'thread_inbound') return
        let payload
        try { payload = JSON.parse(msg.payload || '{}') }
        catch { payload = { raw: msg.payload } }
        publishThreadEvent(payload)
      })
      c.on('error', (err) => {
        console.warn('[threads/stream] LISTEN error:', err?.message)
        threadListenClient = null
      })
      await c.query('LISTEN thread_inbound')
      threadListenClient = c
    } catch (err) {
      console.warn('[threads/stream] LISTEN setup failed:', err?.message)
      threadListenClient = null
    }
  }

  app.get('/api/threads/stream', async (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
    threadStreamClients.add(res)
    await ensureThreadListenClient()

    const hb = setInterval(() => {
      try { res.write(`: hb ${Date.now()}\n\n`) } catch {}
    }, 25_000)
    req.on('close', () => {
      clearInterval(hb)
      threadStreamClients.delete(res)
    })
  })
}
