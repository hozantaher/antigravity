import { useEffect, useRef, useState } from 'react'
import { Share2 } from 'lucide-react'

// ReplyForwardDialog — white-label "Předat do CRM" handoff modal. Shared by the
// bulk bar (acts on the selection) AND the single open reply in the detail pane.
// Collects optional shared notes + a listing URL, then POSTs through the parent's
// onConfirm → POST /api/replies/:id/forward-to-crm (the generic endpoint, NOT
// the legacy /forward-to-garaaage). Each forwarded reply is marked handled +
// audited server-side. lucide icons, no emoji; .app-dialog* tokens in app-odpovedi.css.
export default function ReplyForwardDialog({ open, count, busy = false, onConfirm, onClose }) {
  const [notes, setNotes] = useState('')
  const [url, setUrl] = useState('')
  const confirmRef = useRef(null)

  // Reset inputs whenever the dialog (re)opens so a previous handoff's text
  // never leaks into the next.
  useEffect(() => { if (open) { setNotes(''); setUrl('') } }, [open])

  useEffect(() => {
    if (!open) return undefined
    const h = (e) => { if (e.key === 'Escape' && !busy) onClose?.() }
    window.addEventListener('keydown', h)
    confirmRef.current?.focus()
    return () => window.removeEventListener('keydown', h)
  }, [open, busy, onClose])

  if (!open) return null

  return (
    <div className="app-dialog-bg" onClick={busy ? undefined : onClose}>
      <div
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Předat do CRM"
        data-testid="app-forward-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-dialog__title">Předat do CRM ({count})</div>
        <p className="app-dialog__note">
          Sdílené poznámky a URL listingu se použijí pro {count === 1 ? 'tuto odpověď' : 'všechny vybrané odpovědi'}.
          Každá bude označena jako vyřízená a zapsána do auditu.
        </p>
        <textarea
          className="app-dialog__input"
          rows={3}
          placeholder="Poznámky pro CRM (volitelné)…"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={busy}
          data-testid="app-forward-notes"
        />
        <input
          className="app-dialog__input"
          type="url"
          placeholder="URL listingu / složky (volitelné)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={busy}
          data-testid="app-forward-url"
        />
        <div className="app-dialog__actions">
          <button type="button" className="app-btn" onClick={onClose} disabled={busy} data-testid="app-forward-cancel">
            Zrušit
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="app-btn app-btn--primary"
            onClick={() => onConfirm({ notes, crm_url: url })}
            disabled={busy}
            data-testid="app-forward-confirm"
          >
            <Share2 size={14} className="app-ico" aria-hidden="true" /> {busy ? 'Předávám…' : `Předat ${count}`}
          </button>
        </div>
      </div>
    </div>
  )
}
