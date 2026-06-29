import { Link } from 'react-router-dom'
import { Inbox, Truck, Megaphone, ShieldCheck, ArrowRight } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { STAGES, stageMeta } from '../lib/vehicleMeta'
import { campaignStatusMeta, bounceRate } from '../lib/campaignMeta'
import './app-home.css'

// Days since an ISO timestamp (for the aging-backlog urgency note).
function daysSince(iso) {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return null
  return Math.floor(ms / 86_400_000)
}

// Přehled — a calm glance at the whole pipeline (odpovědi · vozidla ·
// kampaň), live from the same endpoints the surfaces use. Each card links to
// its surface. Never a false 0 — values show '—' until data lands.
// docs/initiatives/2026-05-31-ux-app-claude.md.

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(n)

// Aging tiers for the hot-lead backlog (days a positive reply has waited).
// NAG = gentle reminder; STALE = the lead is going cold, escalate the card.
const HOT_NAG_DAYS = 2
const HOT_STALE_DAYS = 7

function Card({ to, icon: Icon, title, children, loading, urgent }) {
  return (
    <Link to={to} className={`app-home-card${urgent ? ' app-home-card--urgent' : ''}`} data-testid={`app-home-card-${title}`}>
      <div className="app-home-card__head">
        <span className="app-home-card__icon"><Icon size={18} /></span>
        <span className="app-home-card__title">{title}</span>
        <ArrowRight size={15} className="app-home-card__arrow" />
      </div>
      <div className={loading ? 'app-home-card__body app-home-card__body--load' : 'app-home-card__body'}>
        {children}
      </div>
    </Link>
  )
}

export default function Home() {
  const stats = useResource('/api/replies/stats', { pollMs: 30_000, pauseHidden: true })
  // size=500 (not the dead ?limit=200 — the server reads `size`, capped at 500)
  // so the per-stage chip breakdown counts the whole inventory and matches the
  // headline total instead of just the newest 30.
  const vehicles = useResource('/api/vehicles?size=500', { pollMs: 30_000, pauseHidden: true })
  const campaigns = useResource('/api/campaigns', { pollMs: 60_000, pauseHidden: true })
  const dq = useResource('/api/data-quality', { pollMs: 60_000, pauseHidden: true })

  const sLoad = stats.status !== 'ok'
  const n = (v) => (stats.status === 'ok' ? fmt(Number(v ?? 0)) : '—')

  const vRows = vehicles.data?.rows || []
  const byStage = vRows.reduce((m, v) => { m[v.status] = (m[v.status] || 0) + 1; return m }, {})
  const vTotal = vehicles.data?.total ?? vRows.length

  const camps = Array.isArray(campaigns.data) ? campaigns.data : (campaigns.data?.rows || [])
  const camp = camps[0] || null
  const cst = camp ? campaignStatusMeta(camp.status) : null
  const rate = camp ? bounceRate(camp.stats) : null

  // Data-quality task count for the Kvalita dat card — open checks (count > 0)
  // plus the synthesized hot-lead task, so this matches the úkolovník's count.
  const dqOpen = dq.status === 'ok'
    ? (dq.data?.checks || []).filter((c) => c.count > 0).length + ((stats.data?.hot_unhandled || 0) > 0 ? 1 : 0)
    : null
  const dqErrors = dq.data?.errors || 0

  return (
    <div className="app-home" data-testid="app-home">
      <p className="app-home__eyebrow">Hozan · alchymistická laboratoř</p>
      <h1>Klid pro denní triáž.</h1>
      <p className="app-home__intro">
        Celý tok na jednom místě — příchozí odpovědi, výkupní pipeline a kampaň.
        Klikni na kteroukoliv kartu a ponoř se.
      </p>

      <div className="app-home__grid">
        {(() => {
          const age = stats.status === 'ok' ? daysSince(stats.data?.oldest_hot_unhandled_at) : null
          const hot = stats.data?.hot_unhandled
          const stale = age != null && age >= HOT_STALE_DAYS && hot > 0
          return (
            // Deep-link straight into the "Zájem" triage lane (oldest-first), not
            // the generic inbox — one click from glance to the waiting hot leads.
            <Card to="/odpovedi?mode=hot" icon={Inbox} title="Odpovědi" loading={sLoad} urgent={stale}>
              <div className="app-home-card__big">{n(stats.data?.nezpracovane ?? stats.data?.unhandled)}</div>
              <div className="app-home-card__sub">nevyřízených</div>
              <div className="app-home-card__chips">
                <span className="app-home-chip app-home-chip--pos">{hot != null ? fmt(hot) : '—'} zájem čeká</span>
                <span className="app-home-chip">{n(stats.data?.dotazy)} dotazy</span>
              </div>
              {age != null && age > HOT_NAG_DAYS && hot > 0 ? (
                <div className={`app-home-card__aged${stale ? ' app-home-card__aged--stale' : ''}`} data-testid="app-home-oldest-hot">
                  {stale ? '⏳ nejstarší zájem stydne už ' : 'nejstarší zájem čeká '}{age} {age <= 4 ? 'dny' : 'dní'}
                </div>
              ) : null}
            </Card>
          )
        })()}

        <Card to="/vozidla" icon={Truck} title="Vozidla" loading={vehicles.status !== 'ok'}>
          <div className="app-home-card__big">{vehicles.status === 'ok' ? fmt(vTotal) : '—'}</div>
          <div className="app-home-card__sub">ve výkupní pipeline</div>
          <div className="app-home-card__chips">
            {STAGES.filter((s) => byStage[s.key]).map((s) => {
              const m = stageMeta(s.key)
              return <span key={s.key} className="app-home-chip" style={{ color: m.fg, background: m.bg }}>{byStage[s.key]} {m.label.toLowerCase()}</span>
            })}
            {vehicles.status === 'ok' && vTotal === 0 ? <span className="app-home-chip">zatím prázdné</span> : null}
          </div>
        </Card>

        <Card to="/kampane" icon={Megaphone} title="Kampaň" loading={campaigns.status !== 'ok'}>
          {camp ? (
            <>
              <div className="app-home-card__big">{fmt(Number(camp.stats?.sent || 0))}</div>
              <div className="app-home-card__sub">odesláno · {camp.name}</div>
              <div className="app-home-card__chips">
                <span className="app-home-chip" style={{ color: cst.fg, background: cst.bg }}>{cst.label}</span>
                {rate != null ? <span className="app-home-chip">{rate} % bounce</span> : null}
              </div>
            </>
          ) : (
            <div className="app-home-card__sub">{campaigns.status === 'ok' ? 'Žádná kampaň' : '—'}</div>
          )}
        </Card>

        <Card to="/kvalita" icon={ShieldCheck} title="Kvalita dat" loading={dq.status !== 'ok'} urgent={dqErrors > 0}>
          <div className="app-home-card__big">{dqOpen == null ? '—' : fmt(dqOpen)}</div>
          <div className="app-home-card__sub">{dqOpen === 0 ? 'vše v pořádku' : 'úkolů k vyřízení'}</div>
          <div className="app-home-card__chips">
            {dqErrors > 0 ? <span className="app-home-chip" style={{ color: 'var(--app-negative)', background: 'var(--app-negative-soft)' }}>{dqErrors} naléhavé</span> : null}
            {dqOpen > 0 ? <span className="app-home-chip">co data říkají</span> : null}
          </div>
        </Card>
      </div>
    </div>
  )
}
