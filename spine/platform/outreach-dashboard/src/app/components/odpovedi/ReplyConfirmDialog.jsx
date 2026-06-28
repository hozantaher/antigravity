import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'

// ReplyConfirmDialog — generic confirm step for destructive bulk triage ops
// (currently "Skrýt"). Hiding maps to PATCH handled=true (no DELETE endpoint —
// audit trail is preserved), so the dialog spells that out before the operator
// commits. Escape / click-outside cancel. lucide icons, no emoji; .app-dialog*
// tokens live in app-odpovedi.css.
export default function ReplyConfirmDialog({
  open,
  title,
  body = null,
  confirmLabel = 'Potvrdit',
  danger = false,
  busy = false,
  onConfirm,
  onClose,
  testid = 'app-confirm-dialog',
}) {
  const confirmRef = useRef(null)

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
        aria-label={typeof title === 'string' ? title : 'Potvrzení'}
        data-testid={testid}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-dialog__title">
          {danger ? <AlertTriangle size={16} className="app-ico" aria-hidden="true" /> : null}
          {title}
        </div>
        {body ? <p className="app-dialog__note">{body}</p> : null}
        <div className="app-dialog__actions">
          <button type="button" className="app-btn" onClick={onClose} disabled={busy} data-testid={`${testid}-cancel`}>
            Zrušit
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`app-btn ${danger ? 'app-btn--danger' : 'app-btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
            data-testid={`${testid}-ok`}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
