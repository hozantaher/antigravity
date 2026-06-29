import { useResource } from '../../hooks/useResource'
import { relativeCs } from '../lib/replyMeta'

// Top-right pipeline-heartbeat indicator: "kdy se naposledy vyzvedly data".
// Reads /api/ingest-freshness (mailbox_imap_state.polled_at — the Go runner
// stamps it every IMAP poll, so it shows the fetcher is alive in real time,
// not just "last reply"). Polls every 30s. A live dot turns warm/grey when no
// mailbox has polled in the last 10 min (fetcher likely stalled).
export default function IngestFreshness() {
  const r = useResource('/api/ingest-freshness', { pollMs: 30_000, pauseHidden: true })
  const d = r.data
  if (r.status !== 'ok' || !d?.last_poll_at) {
    // Don't show a misleading "now" before the first load; stay quiet.
    return r.status === 'loading'
      ? <span className="app-fresh app-fresh--idle" data-testid="app-ingest-freshness">vyzvedávám…</span>
      : null
  }
  const live = d.mailboxes_polled_recently > 0
  const title = [
    `Poslední vyzvednutí: ${relativeCs(d.last_poll_at)}`,
    d.last_inbound_at ? `Poslední příchozí: ${relativeCs(d.last_inbound_at)}` : null,
    `Schránek čerstvě pollnutých: ${d.mailboxes_polled_recently}`,
  ].filter(Boolean).join('\n')
  return (
    <span className={`app-fresh ${live ? 'app-fresh--live' : 'app-fresh--stale'}`}
      title={title} data-testid="app-ingest-freshness">
      <span className="app-fresh__dot" aria-hidden="true" />
      Vyzvednuto {relativeCs(d.last_poll_at)}
    </span>
  )
}
