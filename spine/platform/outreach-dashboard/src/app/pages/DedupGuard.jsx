import { useState } from 'react'
import { ShieldCheck, RefreshCw, AlertTriangle, TrendingDown, CheckCircle2, Search } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { relativeCs } from '../lib/replyMeta'
import Empty from '../components/Empty'
import './app-dedup.css'

// Ochrana proti duplicitám (Dedup Guard) — operator view of the contact
// block-axes + segment eligibility funnel. Clean rebuild of the DedupGuard
// page on the Antique-Alchemist frame against the SAME BFF endpoints
// (/api/dedup-guard/{stats,recent-skips,segment-funnel,contact-block-reason}).
// Part of the dashboard FE unification.

// ── Named thresholds — no magic numbers (feedback_no_magic_thresholds T0). ────
const CRITICAL_AXIS_THRESHOLD = 100 // an axis blocking > this many = critical tone
const FUNNEL_PCT_HEALTHY = 50       // funnel bar >= this % survives -> positive tone
const FUNNEL_PCT_WARN = 25          // funnel bar >= this % -> warning tone, else negative
const RECENT_SKIPS_LIMIT = 100      // how many recent skip events to pull
const LOOKUP_SKIP_PREVIEW = 5       // how many skip-history rows to show in lookup

// Per-axis semantic labels + descriptions (Czech), in display order.
const AXIS_INFO = {
  dnt: { label: 'Do Not Track', desc: 'Kontakty na seznamech „nezapisovat".' },
  lifetime_exhausted: { label: 'Životnost vyčerpána', desc: 'Reagovali / zapojili se, znovu oslovit nelze.' },
  cross_campaign_cooldown: { label: 'Cooldown mezi kampaněmi', desc: 'Osloveni v jiné kampani < 7 dní.' },
  per_domain_cooldown: { label: 'Cooldown domény', desc: 'Stejná doména oslovena < 2 dny.' },
  bounce_cluster: { label: 'Bounce cluster', desc: 'V clusteru opakovaných bounců.' },
  region_rate_limit: { label: 'Limit regionu', desc: 'Egress z regionu pro dnešek vyčerpán.' },
  engagement_decay: { label: 'Pokles zapojení', desc: 'Nízké skóre zapojení nebo opt-out.' },
  crm_active_client: { label: 'CRM aktivní klient', desc: 'Blokace / suprese z CRM.' },
}
const AXES_ORDER = [
  'dnt', 'lifetime_exhausted', 'cross_campaign_cooldown', 'per_domain_cooldown',
  'bounce_cluster', 'region_rate_limit', 'engagement_decay', 'crm_active_client',
]

const WINDOW_OPTIONS = [
  { value: 'all', label: 'Vše' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 dní' },
  { value: '30d', label: '30 dní' },
]

const fmt = (n) => Number(n || 0).toLocaleString('cs-CZ')

// Per-axis tone + icon derived from the block count. Mirrors severity:
// critical (red) -> some (ochre) -> clear (calm muted check).
function axisTone(count) {
  if (count > CRITICAL_AXIS_THRESHOLD) return { tone: 'crit', Icon: AlertTriangle }
  if (count > 0) return { tone: 'warn', Icon: TrendingDown }
  return { tone: 'ok', Icon: CheckCircle2 }
}

// ── Segment eligibility funnel (block-axes waterfall) ─────────────────────────
function FunnelWaterfall({ data }) {
  if (!data) return null
  const total = data.total || 1 // guard divide-by-zero
  const steps = [
    { label: 'Celkem v segmentu', value: data.total },
    { label: 'Po filtru DNT', value: data.after_dnt_filter },
    { label: 'Po filtru životnosti', value: data.after_lifetime_filter },
    { label: 'Po cooldown filtrech', value: data.after_cooldown_filters },
    { label: 'Po CRM filtrech', value: data.after_crm_filters },
  ]
  return (
    <div className="app-dfunnel" data-testid="app-dedup-funnel-chart">
      {steps.map((step, i) => {
        const val = step.value || 0
        const pct = val > 0 ? Math.round((val / total) * 100) : 0
        const drop = i === 0 ? 0 : (steps[i - 1].value || 0) - val
        const fillTone = pct >= FUNNEL_PCT_HEALTHY ? 'ok' : pct >= FUNNEL_PCT_WARN ? 'warn' : 'crit'
        return (
          <div className="app-dfunnel__row" key={step.label}>
            <div className="app-dfunnel__rowhead">
              <span className="app-dfunnel__label">{step.label}</span>
              <span className="app-dfunnel__val">
                {fmt(val)}
                {drop > 0 ? <span className="app-dfunnel__drop">−{fmt(drop)}</span> : null}
              </span>
            </div>
            <div className="app-dfunnel__bar">
              <div className={`app-dfunnel__fill app-dfunnel__fill--${fillTone}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
      <div className="app-dfunnel__foot">
        Segment #{data.segment_id} · způsobilých: <strong>{fmt(data.eligible)}</strong>
      </div>
    </div>
  )
}

// ── "Proč byl kontakt blokován?" lookup ───────────────────────────────────────
function ContactBlockLookup() {
  const [contactId, setContactId] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  async function onSubmit(e) {
    e.preventDefault()
    const id = parseInt(contactId, 10)
    if (!Number.isFinite(id) || id <= 0) {
      setError('Zadejte platné ID kontaktu (kladné celé číslo).')
      setResult(null)
      return
    }
    setLoading(true); setError(null); setResult(null)
    try {
      const res = await fetch(`/api/dedup-guard/contact-block-reason?id=${id}`)
      const body = await res.json()
      if (!res.ok) setError(body.error || `Chyba ${res.status}`)
      else setResult(body)
    } catch (err) {
      setError(err.message || 'Neznámá chyba')
    } finally {
      setLoading(false)
    }
  }

  const supps = result?.active_suppressions || []
  const skips = result?.skip_history || []

  return (
    <div className="app-dcard app-dlookup" data-testid="app-dedup-lookup">
      <div className="app-dcard__title">Proč byl kontakt blokován?</div>
      <form className="app-dlookup__form" onSubmit={onSubmit}>
        <label className="app-dedup__sr" htmlFor="app-dedup-contact">ID kontaktu</label>
        <input
          id="app-dedup-contact"
          className="app-dedup__field"
          type="number" min="1" inputMode="numeric"
          placeholder="ID kontaktu…"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          data-testid="app-dedup-contact-input"
        />
        <button type="submit" className="app-dlookup__btn" disabled={loading} data-testid="app-dedup-lookup-btn">
          <Search size={14} /> {loading ? 'Hledám…' : 'Hledat'}
        </button>
      </form>

      {error ? (
        <div className="app-dlookup__err" data-testid="app-dedup-lookup-error">{error}</div>
      ) : null}

      {result ? (
        <div className="app-dlookup__result" data-testid="app-dedup-lookup-result">
          <div className="app-dlookup__who">
            Kontakt #{result.contact_id}
            {result.company_name ? ` · ${result.company_name}` : ''}
            {result.domain ? ` (${result.domain})` : ''}
          </div>

          {supps.length > 0 ? (
            <div className="app-dlookup__group">
              <div className="app-dlookup__grouphead">Aktivní blokace ({supps.length})</div>
              {supps.map((s, i) => (
                <div className="app-dlookup__line" key={`s-${i}`}>
                  <span className="app-dlookup__type">{s.type}</span>
                  <span className="app-dlookup__when">
                    {s.expires_at ? `vyprší ${new Date(s.expires_at).toLocaleDateString('cs-CZ')}` : 'trvalé'}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {skips.length > 0 ? (
            <div className="app-dlookup__group">
              <div className="app-dlookup__grouphead">Poslední blokování ({skips.length})</div>
              {skips.slice(0, LOOKUP_SKIP_PREVIEW).map((s, i) => (
                <div className="app-dlookup__line" key={`h-${i}`}>
                  <span className="app-dlookup__type">#{s.campaign_id} · {s.reason}</span>
                  <span className="app-dlookup__when">{relativeCs(s.skipped_at)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {supps.length === 0 && skips.length === 0 ? (
            <div className="app-dlookup__none">Žádné blokování pro tento kontakt.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function DedupGuard() {
  const [statsWindow, setStatsWindow] = useState('all')
  const [segmentId, setSegmentId] = useState('')

  const statsRes = useResource(`/api/dedup-guard/stats?window=${statsWindow}`)
  const skipsRes = useResource(`/api/dedup-guard/recent-skips?limit=${RECENT_SKIPS_LIMIT}`)

  const trimmedSegment = segmentId.trim()
  const funnelRes = useResource(
    `/api/dedup-guard/segment-funnel?id=${encodeURIComponent(trimmedSegment)}`,
    { enabled: trimmedSegment.length > 0 },
  )

  const stats = statsRes.data
  const axes = stats?.axes || {}
  const totalSkipped = stats?.total_skipped ?? 0
  const activeAxes = AXES_ORDER.filter((a) => (axes[a] || 0) > 0).length
  const criticalAxes = AXES_ORDER.filter((a) => (axes[a] || 0) > CRITICAL_AXIS_THRESHOLD).length
  const maxAxis = AXES_ORDER.reduce((m, a) => Math.max(m, axes[a] || 0), 0)
  const statsReady = statsRes.status === 'ok'
  const statsLoadingFirst = (statsRes.status === 'loading' || statsRes.status === 'idle') && !stats
  const statsEmpty = statsReady && totalSkipped === 0

  const skips = skipsRes.data?.skips || []
  const skipsLoadingFirst = (skipsRes.status === 'loading' || skipsRes.status === 'idle') && !skipsRes.data

  const statCells = [
    { l: 'Celkem přeskočeno', v: totalSkipped },
    { l: 'Aktivní osy', v: activeAxes },
    { l: 'Kritické osy', v: criticalAxes, tone: criticalAxes > 0 ? 'err' : null },
    { l: 'Nejvyšší osa', v: maxAxis, tone: maxAxis > CRITICAL_AXIS_THRESHOLD ? 'err' : maxAxis > 0 ? 'warn' : null },
  ]

  return (
    <div className="app-dedup" data-testid="app-dedup">
      <div className="app-dedup__head">
        <div>
          <h1 className="app-dedup__title" data-testid="app-dedup-title">Ochrana proti duplicitám</h1>
          {statsRes.loadedAt ? (
            <span className="app-dedup__sub">Aktualizováno {relativeCs(statsRes.loadedAt)}</span>
          ) : (
            <span className="app-dedup__sub">Bloky kontaktů po osách a trychtýř způsobilosti segmentu</span>
          )}
        </div>
        <button
          type="button" className="app-dedup__refresh" data-testid="app-dedup-refresh" title="Obnovit"
          onClick={() => { statsRes.refresh?.(); skipsRes.refresh?.() }}
          disabled={statsRes.status === 'loading'}
        >
          <RefreshCw size={15} /> Obnovit
        </button>
      </div>

      {/* Stat strip — mirrors Upozorneni's stat-cell pattern. */}
      <div className="app-dedup__stats" data-testid="app-dedup-stats">
        {statCells.map((c) => (
          <div className={`app-dstat${c.tone ? ' app-dstat--' + c.tone : ''}`} key={c.l}>
            <div className="app-dstat__n">{statsReady ? fmt(c.v) : '—'}</div>
            <div className="app-dstat__l">{c.l}</div>
          </div>
        ))}
      </div>

      <div className="app-dedup__grid">
        {/* Block-axes breakdown */}
        <section className="app-dedup__col" aria-label="Bloky po osách">
          <div className="app-dedup__sectionhead">
            <h2 className="app-dedup__sectiontitle">Bloky po osách</h2>
            <div className="app-dedup__windows" role="group" aria-label="Časové okno">
              {WINDOW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className="app-chip-toggle"
                  aria-pressed={statsWindow === opt.value}
                  data-testid={`app-dedup-window-${opt.value}`}
                  onClick={() => setStatsWindow(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {statsRes.status === 'error' ? (
            <div className="app-dcard app-dedup__msg" data-testid="app-dedup-axes-error">
              <div className="app-dcard__title">Nepodařilo se načíst</div>
              <div className="app-dedup__msgbody">{statsRes.error}</div>
            </div>
          ) : statsLoadingFirst ? (
            <div className="app-daxes">{[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <div className="app-dskel app-dskel--tile" key={i} />)}</div>
          ) : statsEmpty ? (
            <Empty icon={ShieldCheck} testid="app-dedup-axes-empty"
              title="Žádné bloky" hint="V tomto okně nebyl přeskočen žádný kontakt — vše prochází." />
          ) : (
            <div className="app-daxes" data-testid="app-dedup-axes">
              {AXES_ORDER.map((axis) => {
                const count = axes[axis] || 0
                const { tone, Icon } = axisTone(count)
                const info = AXIS_INFO[axis]
                return (
                  <div className={`app-daxis app-daxis--${tone}`} key={axis} data-testid={`app-dedup-axis-${axis}`}>
                    <div className="app-daxis__icon"><Icon size={16} strokeWidth={1.7} /></div>
                    <div className="app-daxis__body">
                      <div className="app-daxis__label">{info.label}</div>
                      <div className="app-daxis__n">{fmt(count)}</div>
                      <div className="app-daxis__desc">{info.desc}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Funnel + lookup column */}
        <section className="app-dedup__col" aria-label="Trychtýř způsobilosti">
          <div className="app-dcard" data-testid="app-dedup-funnel">
            <div className="app-dcard__title">Trychtýř způsobilosti segmentu</div>
            <label className="app-dedup__sr" htmlFor="app-dedup-segment">ID segmentu</label>
            <input
              id="app-dedup-segment"
              className="app-dedup__field app-dedup__field--wide"
              type="number" min="1" inputMode="numeric"
              placeholder="ID segmentu…"
              value={segmentId}
              onChange={(e) => setSegmentId(e.target.value)}
              data-testid="app-dedup-segment-input"
            />
            {!trimmedSegment ? (
              <div className="app-dedup__hint">Zadejte ID segmentu pro zobrazení trychtýře.</div>
            ) : funnelRes.status === 'error' ? (
              <div className="app-dlookup__err">{funnelRes.error}</div>
            ) : (funnelRes.status === 'loading' || funnelRes.status === 'idle') && !funnelRes.data ? (
              <div className="app-dskel app-dskel--block" />
            ) : funnelRes.data ? (
              <FunnelWaterfall data={funnelRes.data} />
            ) : null}
          </div>

          <ContactBlockLookup />
        </section>
      </div>

      {/* Recent skip events */}
      <section className="app-dedup__col" aria-label="Poslední skip akce">
        <h2 className="app-dedup__sectiontitle">Poslední skip akce</h2>
        <div className="app-dcard app-dskips" data-testid="app-dedup-skips">
          <div className="app-dskips__row app-dskips__row--head">
            <span>Kontakt</span><span>Kampaň</span><span>Důvod</span><span className="app-dskips__t">Čas</span>
          </div>
          {skipsRes.status === 'error' ? (
            <div className="app-dskips__msg">{skipsRes.error}</div>
          ) : skipsLoadingFirst ? (
            [0, 1, 2].map((i) => <div className="app-dskel app-dskel--row" key={i} />)
          ) : skips.length === 0 ? (
            <div className="app-dskips__msg">Žádné skip akce.</div>
          ) : (
            skips.map((s) => (
              <div className="app-dskips__row" key={s.id} data-testid="app-dedup-skip-row">
                <span className="app-dskips__mono">#{s.contact_id}</span>
                <span className="app-dskips__mono">#{s.campaign_id}</span>
                <span className="app-dskips__reason">{s.reason || 'unknown'}</span>
                <span className="app-dskips__t app-dskips__when">{relativeCs(s.skipped_at)}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
