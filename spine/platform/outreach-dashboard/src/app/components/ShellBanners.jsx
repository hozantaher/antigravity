import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert, AlertTriangle } from 'lucide-react'
import { useOutreachHealth } from '../../store/outreachHealth'

// shell health banners (S3 shell-parity). Rebuild-clean of the
// AuthFailAlertBanner + DegradedBffBanner on --app-* tokens. The auth-fail
// banner links to the mailboxes surface (/schranky). Fail-silent on
// fetch error — the BFF log + webhook paths remain authoritative, and a
// flickering banner on transient 5xx is worse than silence.
const AUTH_FAIL_POLL_MS = 60_000

export default function ShellBanners() {
  const degraded = useOutreachHealth((s) => s.degraded)
  const [authFail, setAuthFail] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/api/health/auth-fail-alerts')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setAuthFail(Number(d.count) || 0) })
        .catch(() => { /* fail-silent */ })
    load()
    const id = setInterval(() => { if (!document.hidden) load() }, AUTH_FAIL_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (!degraded && !authFail) return null

  return (
    <div className="app-banners">
      {authFail > 0 ? (
        <div className="app-banner app-banner--err" role="alert" aria-live="assertive"
          data-testid="app-auth-fail-banner">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>
            <strong>SMTP AUTH selhává</strong> — opakované AUTH chyby ({authFail}).{' '}
            <Link to="/schranky">Zkontrolovat schránky</Link>
          </span>
        </div>
      ) : null}
      {degraded ? (
        <div className="app-banner app-banner--warn" role="alert" aria-live="polite"
          data-testid="app-degraded-banner">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>Backend neodpovídá. UI ukazuje data z poslední úspěšné odpovědi.</span>
        </div>
      ) : null}
    </div>
  )
}
