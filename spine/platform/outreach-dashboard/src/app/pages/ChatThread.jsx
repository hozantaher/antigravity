import { useEffect } from 'react'
import { Check, Clock, TriangleAlert } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useEventStream } from '../../hooks/useEventStream'
import { bodyToText, relativeCs, decodeMimeWords } from '../lib/replyMeta'
import { stripQuotedReply } from '../../lib/quoteStrip'

// Stable event-name array — keeps useEventStream from re-subscribing each render.
const THREAD_EVENTS = ['inbound']

// Odpovědi — conversation rendered as a chat thread (WhatsApp/Signal/
// Chatwoot style). Our outbound sends are right-aligned accent bubbles; the
// customer's inbound replies are left-aligned neutral bubbles, in time order.
// Reads /api/threads/:id/messages (assembles send_events + reply_inbox). The
// reply body for a bubble decodes/strips HTML the same XSS-safe way as the
// pane (bodyToText). Read-only.

// Delivery state for the operator's own manual reply: it lands in
// manual_reply_outbox first (pending), then the Go worker dispatches via the
// relay (sent), or records an error. Mirrors the messenger "✓ / hodiny / !"
// affordance so the operator knows whether their reply actually went out.
function ManualStatus({ status }) {
  if (status === 'sent') return <span className="app-msg__status app-msg__status--sent" data-testid="app-msg-status"> · <Check size={12} className="app-ico" aria-hidden="true" /> odesláno</span>
  if (status === 'error') return <span className="app-msg__status app-msg__status--err" data-testid="app-msg-status"> · <TriangleAlert size={12} className="app-ico" aria-hidden="true" /> nepodařilo se odeslat</span>
  return <span className="app-msg__status app-msg__status--pending" data-testid="app-msg-status"> · <Clock size={12} className="app-ico" aria-hidden="true" /> odesílá se…</span>
}

function bubbleText(m) {
  // Prefer real body; fall back to the subject (MIME-decoded so it's readable,
  // not a raw =?UTF-8?Q?…?= token).
  const body = bodyToText({ body_text: m.body_text, body_html: m.body_html })
  // #1586 R1: show what the person actually wrote, not the quoted-back original
  // they replied above (the Go-proxied thread body carries the full history —
  // "> Od: … > Datum: 24.0" cruft otherwise dominates the reading pane).
  // stripQuotedReply guards against blanking a quote-only body.
  const visible = stripQuotedReply(body)
  if (visible) return visible
  return decodeMimeWords(m.subject || m.body || '')
}

export default function ChatThread({ replyId, nonce = 0 }) {
  // Poll so a freshly-composed manual reply appears, and its pending→sent flip
  // (once the Go worker dispatches via relay) shows live without a manual reload.
  const thread = useResource(replyId ? `/api/threads/${replyId}/messages` : null,
    { enabled: !!replyId, pollMs: 15_000, pauseHidden: true })
  const messages = thread.data?.messages || []

  // Real-time: an inbound reply on this thread → refetch at once (poll is the
  // fallback). The BFF /api/threads/stream emits `inbound` via PG NOTIFY.
  useEventStream(replyId ? '/api/threads/stream' : null, {
    events: THREAD_EVENTS,
    enabled: !!replyId,
    onEvent: () => thread.refresh?.(),
  })
  // Parent bumps `nonce` right after the operator sends, so their own reply
  // bubble appears immediately instead of waiting for the next poll tick.
  useEffect(() => { if (nonce) thread.refresh?.() }, [nonce])  // eslint-disable-line react-hooks/exhaustive-deps

  if (thread.status === 'error') {
    return <div className="app-chat__note">Konverzaci se nepodařilo načíst.</div>
  }
  if (thread.status !== 'ok' && messages.length === 0) {
    return <div className="app-chat__note">Načítám konverzaci…</div>
  }
  if (messages.length === 0) {
    return <div className="app-chat__note">Žádné zprávy v konverzaci.</div>
  }

  return (
    <div className="app-chat" data-testid="app-chat">
      {messages.map((m) => {
        const ours = m.type === 'auto_send' || m.type === 'manual_send' || m.type === 'manual_reply' || m.type === 'outbound'
        const text = bubbleText(m)
        const when = m.sent_at || m.received_at
        return (
          <div key={m.id} className={`app-msg ${ours ? 'app-msg--ours' : 'app-msg--theirs'}`} data-testid={ours ? 'app-msg-ours' : 'app-msg-theirs'}>
            <div className="app-msg__bubble">
              {text ? <div className="app-msg__text">{text}</div> : <div className="app-msg__text app-msg__text--empty">(bez textu)</div>}
            </div>
            <div className="app-msg__meta">
              {ours ? 'My' : (m.sender || 'Zákazník')} · {relativeCs(when)}
              {m.type === 'manual_reply' ? <ManualStatus status={m.status} /> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
