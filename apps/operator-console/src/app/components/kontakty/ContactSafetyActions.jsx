import { useState, useEffect } from 'react'
import { EyeOff, ShieldCheck, Ban, Loader } from 'lucide-react'
import { useToast } from '../../../components/Toast'

// Per-contact safety + GDPR action cluster for the Kontakty detail aside.
// Twin-parity port of the ContactDrawer action zone (src/pages/Contacts.jsx):
//   • DNT (Do Not Track) opt-out — GDPR Art. 21. PATCH {dnt} with a two-step
//     confirm before SETTING (removing is direct). This is a legal control —
//     copy + endpoint ported verbatim from v1.
//   • Suppress / restore — PATCH {status}. uses the canonical 'suppressed'
//     value (the BFF audit keys 'contact_suppress' off it) instead of v1's
//     drifted 'blacklisted', so the operator_audit_log row is correct.
//   • Verify e-mail — POST /api/contacts/:id/verify-email (rate-limited 5/h).
//
// HARD RULE: same endpoints + same headers as v1. sends NO X-Confirm-Send on
// any of these (the BFF requires none) — so neither do we. The only
// X-Confirm-Send on the Kontakty surface stays on the pre-existing campaign
// reset-next-send path in Kontakty.jsx. Mutations toast via useToast().

// Full email_status meta in --app-* tokens (covers the verifier's whole enum,
// unlike contactMeta.emailStatusMeta which intentionally renders no chip for
// unverified/unknown — kept untouched so the list rows don't change).
const VERIFY_META = {
  valid:      { label: 'Platný',      fg: 'var(--app-positive)',   bg: 'var(--app-positive-soft)' },
  invalid:    { label: 'Neplatný',    fg: 'var(--app-negative)',   bg: 'var(--app-negative-soft)' },
  risky:      { label: 'Rizikový',    fg: 'var(--app-warning)',    bg: 'var(--app-warning-soft)' },
  catch_all:  { label: 'Catch-all',   fg: 'var(--app-warning)',    bg: 'var(--app-warning-soft)' },
  spamtrap:   { label: 'Spamtrap',    fg: 'var(--app-negative)',   bg: 'var(--app-negative-soft)' },
  role_only:  { label: 'Role adresa', fg: 'var(--app-warning)',    bg: 'var(--app-warning-soft)' },
  no_email:   { label: 'Bez e-mailu', fg: 'var(--app-text-muted)', bg: 'var(--app-surface-sunk)' },
  unverified: { label: 'Neověřeno',   fg: 'var(--app-text-muted)', bg: 'var(--app-surface-sunk)' },
}
const verifyMeta = (s) => VERIFY_META[s] || VERIFY_META.unverified
const confColor = (c) =>
  c == null ? 'var(--app-text-muted)' : c >= 75 ? 'var(--app-positive)' : c >= 45 ? 'var(--app-warning)' : 'var(--app-negative)'

export default function ContactSafetyActions({ contact, onMutated }) {
  const toast = useToast()

  // Optimistic local mirrors, re-seeded whenever the selected contact changes.
  // onMutated() also re-fetches the detail + list, so these only bridge the
  // refresh latency — they never become the source of truth.
  const [dnt, setDnt] = useState(!!contact?.dnt)
  const [status, setStatus] = useState(contact?.status || '')
  const [verify, setVerify] = useState({
    status: contact?.email_status || 'unverified',
    confidence: contact?.email_confidence ?? null,
    verified_at: contact?.email_verified_at || null,
    detail: contact?.email_verification?.detail || '',
  })

  useEffect(() => {
    setDnt(!!contact?.dnt)
    setStatus(contact?.status || '')
    setVerify({
      status: contact?.email_status || 'unverified',
      confidence: contact?.email_confidence ?? null,
      verified_at: contact?.email_verified_at || null,
      detail: contact?.email_verification?.detail || '',
    })
    setDntConfirm(false)
  }, [contact?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const [dntConfirm, setDntConfirm] = useState(false)
  const [dntPending, setDntPending] = useState(false)
  const [suppressing, setSuppressing] = useState(false)
  const [verifying, setVerifying] = useState(false)

  const id = contact?.id
  const suppressed = status === 'suppressed'

  // ── DNT (GDPR Art. 21) ──────────────────────────────────────────────────
  const applyDnt = async (newDnt) => {
    if (id == null) return
    setDntConfirm(false)
    setDntPending(true)
    try {
      const r = await fetch(`/api/contacts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dnt: newDnt }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = await r.json()
      setDnt(!!body.dnt)
      toast(newDnt ? 'Kontakt označen jako DNT' : 'DNT odstraněno', 'ok')
      onMutated?.(id, { dnt: !!body.dnt })
    } catch (e) {
      toast(e?.message ? `Chyba DNT: ${e.message}` : 'Chyba DNT', 'err')
    } finally {
      setDntPending(false)
    }
  }

  // ── Suppress / restore ──────────────────────────────────────────────────
  const suppress = async () => {
    if (id == null) return
    setSuppressing(true)
    const newStatus = suppressed ? 'valid' : 'suppressed'
    try {
      const r = await fetch(`/api/contacts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = await r.json()
      setStatus(body.status)
      toast(newStatus === 'suppressed' ? 'Kontakt potlačen' : 'Kontakt obnoven', 'ok')
      onMutated?.(id, { status: body.status })
    } catch (e) {
      toast(e?.message ? `Chyba: ${e.message}` : 'Chyba při potlačení', 'err')
    } finally {
      setSuppressing(false)
    }
  }

  // ── Verify e-mail ───────────────────────────────────────────────────────
  const runVerify = async () => {
    if (id == null) return
    setVerifying(true)
    try {
      const r = await fetch(`/api/contacts/${id}/verify-email`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = await r.json()
      setVerify({
        status: body.status,
        confidence: body.confidence ?? null,
        verified_at: new Date().toISOString(),
        detail: body.detail || '',
      })
      toast(`Ověřeno: ${verifyMeta(body.status).label}`,
        body.status === 'invalid' || body.status === 'spamtrap' ? 'err' : 'ok')
      onMutated?.(id, {
        email_status: body.status,
        email_confidence: body.confidence ?? null,
        email_verified_at: new Date().toISOString(),
      })
    } catch (e) {
      toast(e?.message ? `Chyba ověření: ${e.message}` : 'Chyba ověření', 'err')
    } finally {
      setVerifying(false)
    }
  }

  if (id == null) return null
  const vm = verifyMeta(verify.status)

  return (
    <div className="app-kacts" data-testid="app-contact-safety">
      {/* DNT — Do Not Track (GDPR Art. 21 opt-out) */}
      <div className="app-kacts__row" data-testid="app-contact-dnt">
        <span className="app-kacts__lead">
          <EyeOff size={13} color={dnt ? 'var(--app-negative)' : 'var(--app-text-muted)'} className="app-ico" />
          {dnt
            ? <span className="app-kdnt__on" data-testid="app-contact-dnt-badge"
                title="Do Not Track — GDPR Art. 21 opt-out">DNT (Do Not Track)</span>
            : <span className="app-kacts__muted">Bez DNT</span>}
        </span>
        <button
          type="button"
          className="app-kbtn"
          onClick={dnt ? () => applyDnt(false) : () => setDntConfirm(true)}
          disabled={dntPending}
          title={dnt ? 'Odebrat DNT označení' : 'Označit jako Do Not Track (GDPR Art. 21)'}
          data-testid="app-contact-dnt-toggle"
        >
          {dntPending ? <Loader size={12} className="app-ico app-spin" /> : <EyeOff size={12} className="app-ico" />}
          {dnt ? 'Odebrat DNT' : 'Nastavit DNT'}
        </button>
      </div>

      {dntConfirm && (
        <div className="app-kdnt__confirm" data-testid="app-contact-dnt-confirmbox">
          <div className="app-kdnt__confirm-title">Označit kontakt jako DNT?</div>
          <div className="app-kdnt__confirm-body">
            Toto zastaví všechny budoucí outreach včetně follow-upů. Kontakt bude blokován
            na základě GDPR Art. 21 opt-out.
          </div>
          <div className="app-kdnt__confirm-actions">
            <button type="button" className="app-kbtn app-kbtn--danger"
              onClick={() => applyDnt(true)} data-testid="app-contact-dnt-confirm">Potvrdit DNT</button>
            <button type="button" className="app-kbtn"
              onClick={() => setDntConfirm(false)} data-testid="app-contact-dnt-cancel">Zrušit</button>
          </div>
        </div>
      )}

      {/* Suppress / restore */}
      <div className="app-kacts__row">
        <span className="app-kacts__lead">
          <Ban size={13} color={suppressed ? 'var(--app-negative)' : 'var(--app-text-muted)'} className="app-ico" />
          {suppressed
            ? <span className="app-kdnt__on">Potlačený</span>
            : <span className="app-kacts__muted">Aktivní pro outreach</span>}
        </span>
        <button
          type="button"
          className={`app-kbtn${suppressed ? '' : ' app-kbtn--danger'}`}
          onClick={suppress}
          disabled={suppressing}
          title={suppressed ? 'Obnovit kontakt pro outreach' : 'Potlačit — zastaví outreach na tento kontakt'}
          data-testid="app-contact-suppress"
        >
          {suppressing ? <Loader size={12} className="app-ico app-spin" /> : <Ban size={12} className="app-ico" />}
          {suppressed ? 'Obnovit' : 'Potlačit'}
        </button>
      </div>

      {/* Verify e-mail */}
      {contact?.email && (
        <div className="app-kverify" data-testid="app-contact-verify-block">
          <div className="app-kacts__row">
            <span className="app-kacts__muted">Ověření e-mailu</span>
            <button
              type="button"
              className="app-kbtn"
              onClick={runVerify}
              disabled={verifying}
              title="Ověřit doručitelnost e-mailu (SMTP probe)"
              data-testid="app-contact-verify"
            >
              {verifying ? <Loader size={12} className="app-ico app-spin" /> : <ShieldCheck size={12} className="app-ico" />}
              Ověřit
            </button>
          </div>
          <div className="app-kverify__chip" data-testid="app-contact-verify-status"
            style={{ color: vm.fg, background: vm.bg }}>
            <span className="app-kverify__label">{vm.label}</span>
            <span className="app-kverify__meta">
              {typeof verify.confidence === 'number' && (
                <span className="app-kverify__bar-wrap" title={`Spolehlivost ${verify.confidence}/100`}>
                  <span className="app-kverify__bar">
                    <span className="app-kverify__fill"
                      style={{ width: `${Math.max(0, Math.min(100, verify.confidence))}%`, background: confColor(verify.confidence) }} />
                  </span>
                  <span style={{ color: confColor(verify.confidence), fontWeight: 600 }}>{verify.confidence}</span>
                </span>
              )}
              <span>{verify.verified_at
                ? `ověřeno ${new Date(verify.verified_at).toLocaleDateString('cs-CZ')}`
                : 'dosud neověřeno'}</span>
            </span>
          </div>
          {verify.detail ? <div className="app-kverify__detail">{verify.detail}</div> : null}
        </div>
      )}
    </div>
  )
}
