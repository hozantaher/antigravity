import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import { Check, AlertCircle, Info, X } from 'lucide-react'
import { T } from '../lib/tokens'

const Ctx = createContext(null)
const DURATION = 4200

// H5: above this many simultaneous toasts, show a "Zavřít vše" control.
const DISMISS_ALL_MIN = 2

const ICONS = { ok: Check, err: AlertCircle, info: Info }

// Self-contained styling for the dismiss-all control so it stays on-aesthetic
// without depending on a CSS class living in another file. Uses theme-aware
// design tokens (--surface / --border / --muted) so light + dark both read
// intentionally; sizing/radii come from the shared T scale.
const dismissAllStyle = {
  alignSelf: 'flex-end',
  display: 'inline-flex',
  alignItems: 'center',
  gap: T.s(1),
  padding: `${T.s(1)}px ${T.s(2)}px`,
  fontSize: T.text.sm,
  fontWeight: 600,
  color: 'var(--muted-strong)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: T.radius.base,
  cursor: 'pointer',
  boxShadow: '0 1px 2px rgba(0,0,0,.08)',
  transition: 'background var(--dur), border-color var(--dur)',
}

function ToastItem({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false)
  const [progress, setProgress] = useState(100)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const startRef = useRef(Date.now())
  const elapsedRef = useRef(0)
  const duration = toast.duration ?? DURATION

  // `toast.count` bumps each time a same-group toast coalesces in. Restart the
  // countdown on coalesce so a freshly-merged toast does not vanish instantly.
  useEffect(() => {
    elapsedRef.current = 0
    startRef.current = Date.now()
    setProgress(100)
  }, [toast.count])

  useEffect(() => {
    if (paused) { elapsedRef.current += Date.now() - startRef.current; return }
    startRef.current = Date.now()
    let raf
    const tick = () => {
      const total = elapsedRef.current + (Date.now() - startRef.current)
      const pct = Math.max(0, 100 - (total / duration) * 100)
      setProgress(pct)
      if (total >= duration) onDismiss()
      else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [paused, onDismiss, duration, toast.count])

  const Icon = ICONS[toast.type] || Info
  // cs-CZ: "3× …" — coalesced count prefix. Singular toasts render unchanged.
  const label = toast.count > 1 ? `${toast.count}× ${toast.msg}` : toast.msg
  const hasSecondaryAction = toast.secondaryAction != null
  return (
    <div
      className={`toast toast-${toast.type}`}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="status"
    >
      <Icon size={T.icon.lg} className="toast-icon" />
      <div style={{ flex: 1 }}>
        <span className="toast-msg">{label}</span>
        {toast.failureDetails && detailsOpen && (
          <div
            data-testid="toast-failure-details"
            style={{
              marginTop: 8,
              padding: '8px 0',
              borderTop: '1px solid rgba(255,255,255,.1)',
              fontSize: 12,
              fontFamily: 'monospace',
              color: 'var(--c-text-soft, var(--text-soft, #c7c7c7))',
            }}
          >
            {toast.failureDetails.map((d, i) => (
              <div key={i} style={{ marginTop: i > 0 ? 4 : 0 }}>
                <span style={{ fontWeight: 500 }}>ID {d.id}</span>
                {d.from_email && (
                  <div style={{ fontSize: 11, opacity: 0.8 }}>
                    {d.from_email.length > 50 ? d.from_email.slice(0, 50) + '…' : d.from_email}
                  </div>
                )}
                <div style={{ fontSize: 11, opacity: 0.7 }}>{d.error}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            if (toast.failureDetails) setDetailsOpen(!detailsOpen)
            else { toast.action.onClick(); onDismiss() }
          }}
        >
          {toast.action.label}
        </button>
      )}
      {hasSecondaryAction && (
        <button
          className="toast-action"
          onClick={() => { toast.secondaryAction.onClick(); onDismiss() }}
          style={{ marginLeft: 4 }}
        >
          {toast.secondaryAction.label}
        </button>
      )}
      <button className="toast-close" onClick={onDismiss} aria-label="Zavřít">
        <X size={T.icon.md} />
      </button>
      <span className="toast-progress" style={{ width: `${progress}%` }} />
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const show = useCallback((msg, type = 'info', opts = {}) => {
    const id = Date.now() + Math.random()
    const groupId = opts.groupId ?? null
    setToasts(t => {
      // H5 + Rank 5: coalesce — same group + same type folds into one stacked
      // toast with a running count, refreshing its message + resetting its
      // countdown. Callers without groupId are appended unchanged
      // (backward-compatible). Bulk partial-failure bursts (groupId 'bulk-ops')
      // collapse into a single toast carrying failureDetails + a retry action.
      if (groupId != null) {
        const idx = t.findIndex(x => x.groupId === groupId && x.type === type)
        if (idx !== -1) {
          const existing = t[idx]
          const merged = {
            ...existing,
            msg,
            count: (existing.count ?? 1) + 1,
            action: opts.action ?? existing.action,
            secondaryAction: opts.secondaryAction ?? existing.secondaryAction,
            failureDetails: opts.failureDetails ?? existing.failureDetails,
            duration: opts.duration ?? existing.duration,
          }
          const next = [...t]
          next[idx] = merged
          return next
        }
      }
      return [...t, {
        id, msg, type, groupId, count: 1,
        action: opts.action,
        secondaryAction: opts.secondaryAction,
        failureDetails: opts.failureDetails,
        duration: opts.duration,
      }]
    })
  }, [])
  // Both call-styles exist in the codebase: toast(msg, 'err') and toast.error(msg).
  // Expose chained shortcuts so neither breaks.
  show.success = (msg, opts) => show(msg, 'ok', opts)
  show.error = (msg, opts) => show(msg, 'err', opts)
  show.warn = (msg, opts) => show(msg, 'warn', opts)
  show.info = (msg, opts) => show(msg, 'info', opts)
  const dismiss = useCallback((id) => setToasts(t => t.filter(x => x.id !== id)), [])
  const dismissAll = useCallback(() => setToasts([]), [])

  // iter56 infra-gap-2 — expose window.__toast for Playwright E2E tests that
  // need to trigger toasts programmatically. Only mounted in non-production
  // (dev + test modes) so production bundles never touch window.__toast.
  // Uses import.meta.env.DEV which Vite sets to false in `vite build`.
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    window.__toast = show
  }
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast-wrap">
        {toasts.length > DISMISS_ALL_MIN && (
          <button
            className="toast-dismiss-all"
            style={dismissAllStyle}
            onClick={dismissAll}
          >
            <X size={T.icon.sm} />
            Zavřít vše ({toasts.length})
          </button>
        )}
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  )
}
export const useToast = () => useContext(Ctx)
