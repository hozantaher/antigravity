// ingestFreshness.js — GET /api/ingest-freshness — "kdy se naposledy vyzvedly data".
//
// Operator wants a small top-right indicator showing when the pipeline last
// pulled data. The truest signal is mailbox_imap_state.polled_at: the Go runner
// stamps it every IMAP poll (~every 2 min) EVEN WHEN no new mail arrived, so it
// reflects "the fetcher is alive" in real time — not just "last reply", which
// would look stale on a quiet day. We also return last_inbound_at (newest
// actual ingested message) for the tooltip. Read-only.
export function mountIngestFreshnessRoute(app, deps) {
  const { pool, capture500, safeError } = deps

  app.get('/api/ingest-freshness', async (req, res) => {
    try {
      const { rows: [r] } = await pool.query(`
        SELECT
          (SELECT max(polled_at) FROM mailbox_imap_state)                       AS last_poll_at,
          GREATEST(
            (SELECT max(received_at) FROM reply_inbox),
            (SELECT max(created_at)  FROM unmatched_inbound)
          )                                                                      AS last_inbound_at,
          (SELECT count(*)::int FROM mailbox_imap_state
             WHERE polled_at > now() - INTERVAL '10 minutes')                    AS mailboxes_polled_recently
      `)
      res.json({
        last_poll_at: r?.last_poll_at || null,
        last_inbound_at: r?.last_inbound_at || null,
        mailboxes_polled_recently: Number(r?.mailboxes_polled_recently || 0),
        as_of: new Date().toISOString(),
      })
    } catch (e) { capture500(res, e, safeError) }
  })
}
