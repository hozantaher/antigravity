import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldCheck, SlidersHorizontal, Loader, Globe, Phone, ExternalLink } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { useToast } from '../../../components/Toast'
import { vehicleTitle } from '../../lib/vehicleMeta'
import { contactName } from '../../lib/contactMeta'
import {
  icpMeta, scoreValue, companySubtitle, companyTitle,
  sizeLabel, emailStatusMeta, fmtDateCs,
} from '../../lib/companyMeta'

const TREND_DAYS = 30
const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0)

// Tiny inline sparkline (no external dep) — composite-score history over the
// last 30 days. Calm: a single accent polyline, no axes.
function Sparkline({ points }) {
  if (!Array.isArray(points) || points.length < 2) return null
  const w = 120, h = 28, pad = 2
  const min = Math.min(...points), max = Math.max(...points)
  const span = max - min || 1
  const step = (w - 2 * pad) / (points.length - 1)
  const d = points
    .map((v, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((v - min) / span) * (h - 2 * pad)).toFixed(1)}`)
    .join(' ')
  return (
    <svg className="app-fd__spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}
      role="img" aria-label="Vývoj skóre za 30 dní" data-testid="app-firmy-trend">
      <polyline points={d} fill="none" stroke="var(--app-accent-strong)" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default function FirmyDetail({ ico }) {
  const toast = useToast()
  const detail = useResource(ico ? `/api/companies/${encodeURIComponent(ico)}` : null, { enabled: !!ico })
  const veh = useResource(ico ? `/api/vehicles?company_ico=${encodeURIComponent(ico)}&limit=20` : null, { enabled: !!ico })
  const con = useResource(ico ? `/api/contacts?company_ico=${encodeURIComponent(ico)}&limit=20` : null, { enabled: !!ico })
  const trend = useResource(ico ? `/api/companies/score-trends?days=${TREND_DAYS}&icos=${encodeURIComponent(ico)}` : null, { enabled: !!ico })

  const [verifying, setVerifying] = useState(false)
  const [scoring, setScoring] = useState(false)
  const [history, setHistory] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)

  if (!ico) {
    return (
      <div className="app-empty" data-testid="app-company-empty">
        <div className="app-empty__title">Vyber firmu</div>
        <div>Zvol firmu vlevo a uvidíš její kartu.</div>
      </div>
    )
  }
  if (detail.status === 'error') {
    return <div className="app-empty" data-testid="app-company-error"><div className="app-empty__title">Nepodařilo se načíst</div><div>{detail.error}</div></div>
  }
  if (detail.status !== 'ok' || !detail.data) {
    return <div className="app-empty"><div className="app-empty__title">Načítám…</div></div>
  }

  const c = detail.data
  const score = scoreValue(c)
  const icp = icpMeta(c.icp_tier)
  const em = emailStatusMeta(c.email_status)
  const trendPts = (Array.isArray(trend.data?.[ico]) ? trend.data[ico] : [])
    .map((x) => (x && typeof x === 'object' ? Number(x.score) : Number(x)))
    .filter((n) => Number.isFinite(n))
  const vehicles = veh.data?.rows || []
  const contacts = con.data?.rows || []

  // Mutations reuse the SAME endpoints uses (no X-Confirm-Send — companies.js
  // routes are not in the BFF X-Confirm gate, and sends none). On success we
  // refresh the detail resource rather than patching local state.
  const runVerify = async () => {
    setVerifying(true)
    try {
      const r = await fetch(`/api/companies/${encodeURIComponent(ico)}/verify-email`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = await r.json()
      const bad = body.status === 'invalid' || body.status === 'spamtrap'
      toast(`Ověřeno: ${emailStatusMeta(body.status).label}`, bad ? 'err' : 'ok')
      detail.refresh?.()
    } catch (e) {
      toast(e?.message ? `Chyba ověření: ${e.message}` : 'Chyba ověření', 'err')
    } finally { setVerifying(false) }
  }

  const runRecompute = async () => {
    setScoring(true)
    try {
      const r = await fetch(`/api/companies/${encodeURIComponent(ico)}/recompute-score`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      toast('Skóre přepočítáno', 'ok')
      detail.refresh?.()
      trend.refresh?.()
    } catch (e) {
      toast(e?.message ? `Přepočet selhal: ${e.message}` : 'Přepočet selhal', 'err')
    } finally { setScoring(false) }
  }

  const loadHistory = async () => {
    if (history) { setHistoryOpen((o) => !o); return }
    setHistoryOpen(true)
    try {
      const r = await fetch(`/api/companies/${encodeURIComponent(ico)}/verification-history`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setHistory(await r.json())
    } catch (e) {
      setHistory([])
      toast(e?.message ? `Historii se nepodařilo načíst: ${e.message}` : 'Historii se nepodařilo načíst', 'err')
    }
  }

  const rows = [
    ['IČO', c.ico],
    ['Sektor', c.sector_primary],
    ['NACE', c.nace_code],
    ['Region', c.region_normalized],
    ['Kategorie', c.category_path],
    ['Právní forma', c.enrichment?.pravni_forma?.value || c.pravni_forma],
    ['Velikost', sizeLabel(c.velikost_firmy)],
    ['Engagement', c.engagement_cluster],
    ['ICP tier', c.icp_tier && c.icp_tier !== 'irrelevant' ? c.icp_tier : null],
    ['Hodnocení', c.rating_value > 0 ? `${c.rating_value} (${c.rating_count || 0})` : null],
    ['Posl. kontakt', fmtDateCs(c.last_contacted)],
  ].filter(([, v]) => v != null && v !== '')

  return (
    <div className="app-firmy__pane" data-testid="app-company-detail">
      <div className="app-fd__head">
        <div className="app-fd__headmain">
          <h2 className="app-fd__name">{companyTitle(c)}</h2>
          <div className="app-fd__sub">{companySubtitle(c)}</div>
        </div>
        {score != null ? <span className="app-fd__scorebig">{score}</span> : null}
      </div>

      {/* Actions — reuse v1's verify-email + recompute-score endpoints. */}
      <div className="app-fd__actions">
        {c.email ? (
          <button type="button" className="app-fbtn" onClick={runVerify} disabled={verifying}
            data-testid="app-firmy-verify" title="Ověřit e-mail přes MX + SMTP probe">
            {verifying ? <Loader size={13} className="app-spin" /> : <ShieldCheck size={13} />} Ověřit e-mail
          </button>
        ) : null}
        <button type="button" className="app-fbtn" onClick={runRecompute} disabled={scoring}
          data-testid="app-firmy-recompute" title="Přepočítat composite score">
          {scoring ? <Loader size={13} className="app-spin" /> : <SlidersHorizontal size={13} />} Přepočítat skóre
        </button>
      </div>

      {/* Activity mini-stats. */}
      <div className="app-fd__stats">
        {[
          { l: 'Odesláno', v: c.total_sent ?? 0 },
          { l: 'Odpovědi', v: c.total_replied ?? 0, hot: (c.total_replied ?? 0) > 0 },
          { l: 'Otevřeno', v: c.total_opened ?? 0 },
          { l: 'Bounces', v: c.total_bounced ?? 0 },
        ].map((s) => (
          <div className="app-fd__stat" key={s.l}>
            <div className={`app-fd__statn${s.hot ? ' app-fd__statn--hot' : ''}`}>{fmt(s.v)}</div>
            <div className="app-fd__statl">{s.l}</div>
          </div>
        ))}
      </div>

      {/* Score: tier + ICP chip + 30d sparkline + components + recompute time. */}
      <div className="app-fd__section">
        <div className="app-fd__label">Skóre</div>
        <div className="app-fd__scorerow">
          <div className="app-fd__chips">
            {c.score_tier ? <span className="app-tag app-tag--muted">{c.score_tier}</span> : null}
            {icp ? <span className="app-tag" style={{ color: icp.fg, background: icp.bg }}>{icp.label}</span> : null}
          </div>
          {trendPts.length >= 2 ? <Sparkline points={trendPts} /> : <span className="app-fd__nodata">Bez historie</span>}
        </div>
        {c.score_components && typeof c.score_components === 'object' ? (
          <dl className="app-fd__components">
            {Object.entries(c.score_components)
              .filter(([, v]) => Number.isFinite(Number(v)))
              .slice(0, 8)
              .map(([k, v]) => (
                <div className="app-fd__row" key={k}><dt>{k}</dt><dd>{Math.round(Number(v))}</dd></div>
              ))}
          </dl>
        ) : null}
        {c.scored_at ? <div className="app-fd__hint">Přepočítáno {fmtDateCs(c.scored_at)}</div> : null}
      </div>

      {/* E-mail status + verification history. */}
      {c.email ? (
        <div className="app-fd__section">
          <div className="app-fd__label">E-mail</div>
          <div className="app-fd__email">
            <span className="app-fd__addr">{c.email}</span>
            <span className="app-tag" style={{ color: em.fg, background: em.bg }}>{em.label}</span>
            {typeof c.email_confidence === 'number' ? <span className="app-fd__conf">{c.email_confidence}%</span> : null}
          </div>
          <button type="button" className="app-fd__linkbtn" onClick={loadHistory} data-testid="app-firmy-history">
            {historyOpen ? 'Skrýt' : 'Zobrazit'} historii ověření
          </button>
          {historyOpen && history ? (
            <div className="app-fd__hist">
              {history.length === 0 ? <span className="app-fd__nodata">Žádná historie</span> : null}
              {history.map((h) => (
                <div className="app-fd__histrow" key={h.id}>
                  <span style={{ color: emailStatusMeta(h.new_status).fg, fontWeight: 600 }}>{emailStatusMeta(h.new_status).label}</span>
                  <span className="app-fd__hint">{fmtDateCs(h.created_at)} · {h.trigger}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Firmografie. */}
      <div className="app-fd__section">
        <div className="app-fd__label">Firma</div>
        <dl style={{ margin: 0 }}>{rows.map(([k, v]) => <div className="app-fd__row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        {c.website ? (
          <a className="app-fd__ext" href={c.website} target="_blank" rel="noopener noreferrer">
            <Globe size={13} /> {c.website.replace(/^https?:\/\//, '')} <ExternalLink size={11} />
          </a>
        ) : null}
        {c.telephone ? <div className="app-fd__ext"><Phone size={13} /> {c.telephone}</div> : null}
      </div>

      {/* Linked vehicles — the firma↔vozidlo interconnection (preserved). */}
      <div className="app-fd__section">
        <div className="app-fd__label">Vozidla ({vehicles.length})</div>
        {vehicles.length === 0
          ? <div className="app-fd__nodata">Žádná vozidla od této firmy.</div>
          : vehicles.map((v) => (
            <Link key={v.id} to={`/vozidla?id=${v.id}`} className="app-fd__veh" data-testid="app-company-vehicle">
              {vehicleTitle(v)} →
            </Link>
          ))}
      </div>

      {contacts.length > 0 ? (
        <div className="app-fd__section" data-testid="app-company-contacts">
          <div className="app-fd__label">Kontakty ({contacts.length})</div>
          {contacts.map((ct) => (
            <Link key={ct.id} to={`/kontakty?id=${ct.id}`} className="app-fd__veh" data-testid="app-company-contact">
              {contactName(ct)}{ct.phone ? <span className="app-fd__cphone"><Phone size={11} /> {ct.phone}</span> : ''} →
            </Link>
          ))}
        </div>
      ) : null}

      {Array.isArray(c.campaigns) && c.campaigns.length > 0 ? (
        <div className="app-fd__section" data-testid="app-company-campaigns">
          <div className="app-fd__label">Kampaně ({c.campaigns.length})</div>
          {c.campaigns.map((cm) => (
            <div className="app-fd__camp" key={cm.id}>
              <span>{cm.name}</span>
              <span className="app-fd__hint">{cm.status} · krok {cm.step ?? 0}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
