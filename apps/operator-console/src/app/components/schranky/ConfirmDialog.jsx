import { useEffect, useRef } from 'react'
import { AlertTriangle } from 'lucide-react'

// ConfirmDialog — generic confirm step for state-changing mailbox mutations.
// v1's bulk pause/resume fired immediately on click (no dialog); ADDS this
// confirm gate before any destructive op (pause/resume of live mailboxes) so an
// operator can't accidentally halt the send fleet. Optional reason input is
// required by the per-mailbox /status endpoint when re-activating (unpause).
export default function ConfirmDialog({
  title,
  body = null,
  confirmLabel = 'Potvrdit',
  cancelLabel = 'Zrušit',
  danger = false,
  busy = false,
  error = null,
  reasonLabel = null,
  reasonValue = '',
  onReasonChange = null,
  reasonRequired = false,
  onConfirm,
  onCancel,
  testid = 'app-schranky-confirm',
}) {
  const confirmRef = useRef(null)
  const reasonOk = !reasonRequired || (typeof reasonValue === 'string' && reasonValue.trim().length > 0)

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape' && !busy) onCancel?.() }
    window.addEventListener('keydown', h)
    confirmRef.current?.focus()
    return () => window.removeEventListener('keydown', h)
  }, [busy, onCancel])

  return (
    <div className="app-sb-modalbg" onClick={busy ? undefined : onCancel}>
      <div
        className="app-sb-modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Potvrzení'}
        data-testid={testid}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-sb-modal__title">
          {danger ? <AlertTriangle size={16} strokeWidth={1.8} className="app-sb-modal__titleico" /> : null}
          {title}
        </div>
        {body ? <div className="app-sb-modal__body">{body}</div> : null}
        {reasonLabel ? (
          <label className="app-sb-modal__reason">
            <span>{reasonLabel}{reasonRequired ? ' *' : ''}</span>
            <input
              type="text"
              value={reasonValue}
              onChange={(e) => onReasonChange?.(e.target.value.slice(0, 200))}
              disabled={busy}
              maxLength={200}
              autoComplete="off"
              data-testid={`${testid}-reason`}
            />
          </label>
        ) : null}
        {error ? (
          <div className="app-sb-modal__err" role="alert" data-testid={`${testid}-error`}>{error}</div>
        ) : null}
        <div className="app-sb-modal__actions">
          <button
            type="button"
            className="app-sb-btn"
            onClick={onCancel}
            disabled={busy}
            data-testid={`${testid}-cancel`}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`app-sb-btn ${danger ? 'app-sb-btn--danger' : 'app-sb-btn--primary'}`}
            onClick={onConfirm}
            disabled={busy || !reasonOk}
            data-testid={`${testid}-confirm`}
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
