import { useEffect, useRef, useState } from 'react'
import { Forward } from 'lucide-react'

// ForwardComposer — "Přeposlat e-mail" modal. The operator forwards the open
// inbound reply to a chosen third-party address (e.g. handing a hot lead to a
// dealer). Send goes through the EXISTING safe path: POST /api/replies/:id/forward
// → manual_reply_outbox (kind='forward') → outbound-reply dispatcher → relay
// (~2 min). NEVER raw SMTP. Two-step confirm guards against a stray dispatch.
//
// Distinct from ReplyComposer (replies to the original sender) and the "Do CRM"
// handoff stub (no email). Mirrors ReplyForwardDialog's modal shell + tokens.
//
// props: reply (the open detail row — id, from_email, subject, body_text,
//        attachments_meta), open, onClose(), onSent().

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_PREVIEW_CHARS = 600

export default function ForwardComposer({ reply, open, onClose, onSent }) {
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [includeOriginal, setIncludeOriginal] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | sending | sent | error
  const [msg, setMsg] = useState('')
  const firstRef = useRef(null)

  // Reset on (re)open so a previous forward's text never leaks into the next.
  useEffect(() => {
    if (open) {
      setTo(''); setNote(''); setIncludeOriginal(true)
      setConfirming(false); setPhase('idle'); setMsg('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const h = (e) => { if (e.key === 'Escape' && phase !== 'sending') onClose?.() }
    window.addEventListener('keydown', h)
    firstRef.current?.focus()
    return () => window.removeEventListener('keydown', h)
  }, [open, phase, onClose])

  if (!open || !reply?.id) return null

  const attCount = Array.isArray(reply.attachments_meta) ? reply.attachments_meta.length : 0
  const toTrim = to.trim()
  const toValid = EMAIL_RE.test(toTrim)
  const canSend = toValid && phase !== 'sending'
  const preview = String(reply.body_text || reply.body_text_preview || reply.body_preview || '').slice(0, MAX_PREVIEW_CHARS)

  const send = async () => {
    setConfirming(false); setPhase('sending'); setMsg('Odesílám do fronty…')
    try {
      const fd = new FormData()
      fd.append('to', toTrim)
      if (note.trim()) fd.append('note', note.trim())
      fd.append('include_original', includeOriginal ? 'true' : 'false')
      const r = await fetch(`/api/replies/${reply.id}/forward`, { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) throw new Error(d.error || `forward ${r.status}`)
      setPhase('sent')
      setMsg('Zařazeno do fronty — relay odešle do ~2 min.')
      if (typeof onSent === 'function') onSent()
    } catch (e) {
      setPhase('error')
      setMsg(`Přeposlání selhalo: ${e.message || 'zkus to znovu'}`)
    }
  }

  return (
    <div className="app-dialog-bg" onClick={phase === 'sending' ? undefined : onClose}>
      <div
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Přeposlat e-mail"
        data-testid="app-forward-email-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-dialog__title">
          <Forward size={16} className="app-ico" aria-hidden="true" /> Přeposlat e-mail
        </div>

        {phase === 'sent' ? (
          <>
            <p className="app-dialog__note" data-testid="app-forward-email-done">{msg}</p>
            <div className="app-dialog__actions">
              <button type="button" className="app-btn app-btn--primary" onClick={onClose} data-testid="app-forward-email-close">
                Zavřít
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="app-dialog__note">
              Pošle obsah této odpovědi na zadanou adresu přes napojenou schránku (relay, ne přímé SMTP). Akce je auditována.
            </p>

            <input
              ref={firstRef}
              className="app-dialog__input"
              type="email"
              placeholder="Komu (e-mail příjemce)…"
              value={to}
              onChange={(e) => { setTo(e.target.value); if (phase === 'error') setPhase('idle') }}
              disabled={phase === 'sending'}
              data-testid="app-forward-email-to"
            />
            {toTrim && !toValid ? (
              <div className="app-dialog__err" data-testid="app-forward-email-err">Neplatný e-mail.</div>
            ) : null}

            <textarea
              className="app-dialog__input"
              rows={3}
              placeholder="Poznámka nad přeposlanou zprávou (volitelné)…"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={phase === 'sending'}
              data-testid="app-forward-email-note"
            />

            {attCount > 0 ? (
              <label className="app-dialog__check" data-testid="app-forward-email-include">
                <input
                  type="checkbox"
                  checked={includeOriginal}
                  onChange={(e) => setIncludeOriginal(e.target.checked)}
                  disabled={phase === 'sending'}
                />
                <span>Připojit původní přílohy ({attCount})</span>
              </label>
            ) : null}

            {preview ? (
              <div className="app-dialog__quote" data-testid="app-forward-email-quote">
                <div className="app-dialog__quote-h">Přeposílaná zpráva — {reply.from_email || 'odesílatel'}</div>
                <div className="app-dialog__quote-b">{preview}{preview.length >= MAX_PREVIEW_CHARS ? '…' : ''}</div>
              </div>
            ) : null}

            {msg ? <div className="app-dialog__note" data-testid="app-forward-email-msg">{msg}</div> : null}

            <div className="app-dialog__actions">
              {!confirming ? (
                <>
                  <button type="button" className="app-btn" onClick={onClose} disabled={phase === 'sending'} data-testid="app-forward-email-cancel">
                    Zrušit
                  </button>
                  <button
                    type="button"
                    className="app-btn app-btn--primary"
                    disabled={!canSend}
                    onClick={() => setConfirming(true)}
                    data-testid="app-forward-email-send"
                  >
                    <Forward size={14} className="app-ico" aria-hidden="true" /> Přeposlat →
                  </button>
                </>
              ) : (
                <>
                  <span className="app-dialog__confirm-q" data-testid="app-forward-email-confirm-q">Přeposlat na {toTrim}?</span>
                  <button type="button" className="app-btn" onClick={() => setConfirming(false)} disabled={phase === 'sending'} data-testid="app-forward-email-back">
                    Zpět
                  </button>
                  <button type="button" className="app-btn app-btn--primary" onClick={send} disabled={phase === 'sending'} data-testid="app-forward-email-confirm">
                    {phase === 'sending' ? 'Odesílám…' : 'Ano, přeposlat'}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
