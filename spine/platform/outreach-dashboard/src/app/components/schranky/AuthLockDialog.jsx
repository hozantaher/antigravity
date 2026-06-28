import { useEffect, useState } from 'react'
import { Lock, Clock, AlertTriangle } from 'lucide-react'

// AuthLockDialog — operator unlock for AP6 auto-quarantined mailboxes.
//
// SAFETY-CRITICAL. Wired verbatim to the documented BFF contract
// (POST /api/mailboxes/:id/clear-auth-lock, see CLAUDE.md "Auth-fail
// auto-quarantine" + tests/contract/bff-mailbox-auth-lock-ap6.contract.test.ts):
//   - MUST carry the `X-Confirm-Send: yes` header (403 without it).
//   - 425 cooldown_not_elapsed → surface `hours_remaining` (24h forced cooldown;
//     operator CANNOT unlock before it elapses).
//   - 409 → mailbox is no longer auth_locked (concurrent change) → close + reload.
//   - 200 → mailbox set to status='paused' (NOT 'active'); operator must
//     re-verify credentials and explicitly resume afterward.
//
// had NO UI for this endpoint at all — this dialog ADDS the missing operator
// surface (per the UX/UI-first hard rule: build the surface, don't shell out to
// psql), bound to the exact contract above.
export default function AuthLockDialog({ mb, onClose, onDone, toast }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [cooldownHours, setCooldownHours] = useState(null) // hours_remaining from 425

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape' && !busy) onClose?.() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [busy, onClose])

  const submit = async () => {
    setBusy(true)
    setError(null)
    setCooldownHours(null)
    try {
      const r = await fetch(`/api/mailboxes/${mb.id}/clear-auth-lock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
        body: JSON.stringify({ reason: reason.trim() || 'operator_clear_auth_lock' }),
      })
      if (r.status === 425) {
        const d = await r.json().catch(() => ({}))
        setCooldownHours(typeof d.hours_remaining === 'number' ? d.hours_remaining : null)
        return
      }
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}))
        toast?.(`Schránka už není zamčená (stav: ${d.status || '?'})`, 'ok')
        onDone?.()
        onClose?.()
        return
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        setError(d.error || `HTTP ${r.status}`)
        return
      }
      const d = await r.json().catch(() => ({}))
      const next = d.mailbox?.status || 'paused'
      toast?.(`Auth-lock zrušen — schránka je nyní „${next}". Ověř přihlašovací údaje a poté ji aktivuj.`, 'ok')
      onDone?.()
      onClose?.()
    } catch (e) {
      setError(e?.message || 'Síťová chyba')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-sb-modalbg" onClick={busy ? undefined : onClose}>
      <div
        className="app-sb-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Zrušit auth-lock"
        data-testid="app-schranky-authlock-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="app-sb-modal__title">
          <Lock size={16} strokeWidth={1.8} className="app-sb-modal__titleico" />
          Zrušit auth-lock schránky
        </div>

        <div className="app-sb-modal__body">
          <div className="app-sb-authlock__who">{mb.email}</div>
          <p className="app-sb-authlock__note">
            Schránka byla automaticky uzamčena po opakovaných selháních přihlášení
            (AP6). Odemčení je možné až <strong>24 h</strong> od uzamčení. Po
            odemčení přejde do stavu <code>paused</code> — nejprve ověř
            přihlašovací údaje, teprve poté ji aktivuj.
          </p>
        </div>

        {cooldownHours != null ? (
          <div className="app-sb-authlock__cooldown" role="alert" data-testid="app-schranky-authlock-cooldown">
            <Clock size={14} strokeWidth={1.8} />
            <span>
              Cooldown ještě neuplynul — zbývá <strong>~{Math.ceil(cooldownHours)} h</strong>.
              Odemčení bude možné po uplynutí 24 h od uzamčení.
            </span>
          </div>
        ) : null}

        <label className="app-sb-modal__reason">
          <span>Důvod (volitelný)</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 200))}
            disabled={busy}
            maxLength={200}
            autoComplete="off"
            placeholder="např. credentials_rotated"
            data-testid="app-schranky-authlock-reason"
          />
        </label>

        {error ? (
          <div className="app-sb-modal__err" role="alert" data-testid="app-schranky-authlock-error">
            <AlertTriangle size={13} strokeWidth={1.8} /> {error}
          </div>
        ) : null}

        <div className="app-sb-modal__actions">
          <button type="button" className="app-sb-btn" onClick={onClose} disabled={busy}
            data-testid="app-schranky-authlock-cancel">
            Zavřít
          </button>
          <button type="button" className="app-sb-btn app-sb-btn--danger" onClick={submit} disabled={busy}
            data-testid="app-schranky-authlock-confirm">
            {busy ? '…' : 'Zrušit auth-lock'}
          </button>
        </div>
      </div>
    </div>
  )
}
