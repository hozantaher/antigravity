import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, AlertCircle, Info, CheckCircle2, RefreshCw, Mailbox } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { relativeCs } from '../lib/replyMeta'
import { useToast } from '../../components/Toast'
import Empty from '../components/Empty'
import './app-upozorneni.css'

// Upozornění — operator notification center on the Claude frame. Surfaces
// every actionable alert (mailbox auth-lock, bounce breach, IMAP fail,
// blacklist, runner crash) with severity tones + per-alert resolve. Clean
// rebuild of the Notifications page against the SAME BFF endpoints
// (/api/notifications + /:id/resolve). Port P8 — docs/initiatives/2026-06-20-dashboard-unification.md.

const SEVERITY = {
  critical: { label: 'Kritické', fg: 'var(--app-negative)', Icon: AlertCircle },
  warning:  { label: 'Varování', fg: 'var(--app-warning)', Icon: AlertTriangle },
  info:     { label: 'Info', fg: 'var(--app-text-muted)', Icon: Info },
}

export default function Upozorneni() {
  const toast = useToast()
  const feed = useResource('/api/notifications', { pollMs: 60_000, pauseHidden: true })
  const [resolving, setResolving] = useState(null)

  const counts = feed.data?.counts || { total: 0, critical: 0, warning: 0, info: 0 }
  const notifications = feed.data?.notifications || []

  const resolve = async (n) => {
    if (!n.resolvable || n.alert_id == null) return
    setResolving(n.id)
    try {
      const r = await fetch(`/api/notifications/${n.alert_id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      toast('Upozornění vyřešeno', 'ok')
      feed.refresh?.()
    } catch (e) {
      toast(`Chyba: ${e.message || 'zkus to znovu'}`, 'err')
    } finally {
      setResolving(null)
    }
  }

  const statCells = [
    { l: 'Celkem', v: counts.total },
    { l: 'Kritická', v: counts.critical, tone: counts.critical > 0 ? 'err' : null },
    { l: 'Varování', v: counts.warning, tone: counts.warning > 0 ? 'warn' : null },
    { l: 'Info', v: counts.info },
  ]

  return (
    <div className="app-upozorneni" data-testid="app-upozorneni">
      <div className="app-upozorneni__head">
        <div>
          <h1 className="app-upozorneni__title">Upozornění</h1>
          {feed.loadedAt ? (
            <span className="app-upozorneni__sub">Aktualizováno {relativeCs(feed.loadedAt)}</span>
          ) : null}
        </div>
        <button type="button" className="app-upozorneni__refresh" onClick={() => feed.refresh?.()}
          disabled={feed.status === 'loading'} data-testid="app-upozorneni-refresh" title="Obnovit">
          <RefreshCw size={15} /> Obnovit
        </button>
      </div>

      <div className="app-upozorneni__stats" data-testid="app-upozorneni-stats">
        {statCells.map((c) => (
          <div className={`app-ustat${c.tone ? ' app-ustat--' + c.tone : ''}`} key={c.l}>
            <div className="app-ustat__n">{feed.status === 'ok' ? c.v : '—'}</div>
            <div className="app-ustat__l">{c.l}</div>
          </div>
        ))}
      </div>

      {feed.status === 'error' ? (
        <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{feed.error}</div></div>
      ) : (feed.status === 'loading' || feed.status === 'idle') && notifications.length === 0 ? (
        <div className="app-upozorneni__list">{[0, 1, 2].map((i) => <div className="app-skeleton-row" key={i} />)}</div>
      ) : notifications.length === 0 ? (
        <Empty icon={CheckCircle2} testid="app-upozorneni-empty"
          title="Žádné upozornění" hint="Vše běží v pořádku — klid." />
      ) : (
        <ul className="app-upozorneni__list" data-testid="app-upozorneni-list">
          {notifications.map((n) => {
            const sev = SEVERITY[n.severity] || SEVERITY.info
            const Icon = sev.Icon
            return (
              <li key={n.id} className="app-unotif" data-testid="app-upozorneni-row"
                style={{ borderLeftColor: sev.fg }}>
                <div className="app-unotif__icon" style={{ color: sev.fg }}><Icon size={17} strokeWidth={1.7} /></div>
                <div className="app-unotif__body">
                  <div className="app-unotif__meta">
                    <span className="app-unotif__sev" style={{ color: sev.fg }}>{sev.label}</span>
                    {n.type ? <span>{n.type}</span> : null}
                    {n.from_address ? <span>· {n.from_address}</span> : null}
                    {n.created_at ? <span>· {relativeCs(n.created_at)}</span> : null}
                  </div>
                  <div className="app-unotif__msg">{n.message}</div>
                </div>
                <div className="app-unotif__actions">
                  {n.mailbox_id != null ? (
                    // TODO(P1): repoint to /schranky?focus= once Mailboxes is ported.
                    <Link to={`/mailboxes?focus=${n.mailbox_id}`} className="app-unotif__btn"
                      data-testid="app-upozorneni-open" title="Otevřít schránku">
                      <Mailbox size={14} /> Otevřít
                    </Link>
                  ) : null}
                  {n.resolvable ? (
                    <button type="button" className="app-unotif__btn app-unotif__btn--primary" onClick={() => resolve(n)}
                      disabled={resolving === n.id} data-testid="app-upozorneni-resolve">
                      {resolving === n.id ? '…' : 'Vyřešit'}
                    </button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
