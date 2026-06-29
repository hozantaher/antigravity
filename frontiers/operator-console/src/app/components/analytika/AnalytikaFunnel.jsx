// Analytika — Funnel tab. Horizontal conversion funnel (with bottleneck peg)
// + per-template comparison + daily timeseries. SAME BFF endpoint as
// (/api/funnel/summary?days=N). Reuses the shared inline-SVG BarChart.

import { useState, useMemo } from 'react'
import { TrendingUp, ArrowDown } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { BarChart, Card, Chips, Async, fmt, POLL_MS } from './Charts'

const DEFAULT_DAYS = 14
const DAY_OPTIONS = [7, 14, 30, 60, 90].map((d) => ({ value: d, label: `${d} d` }))

// Open-pixel tracking is DISABLED by design (Seznam anti-spam fingerprint, AR2):
// opens are structurally 0 and the server returns pct 0 for sent→opened, so the
// "Otevřeno" stage would always (falsely) win the bottleneck peg + render a dead
// 0-row. Exclude the opened transition + stage while tracking is off.
const OPEN_TRACKING_ENABLED = false

// Drop-off retention thresholds (% of upstream stage kept) — named, not magic.
const DROPOFF_HEALTHY = 30, DROPOFF_WARN = 10
function dropTone(pct) { return pct >= DROPOFF_HEALTHY ? 'ok' : pct >= DROPOFF_WARN ? 'warn' : 'err' }

// Stage fill tone — cobalt entry → amber ambiguous → green realised value.
const STAGE_TONE = { sent: 'accent', opened: 'accent', replied: 'warn', engaged: 'ok', leads: 'ok', won: 'ok' }

const SERIES_OPTIONS = [
  { value: 'sent', label: 'Odesláno', color: 'var(--app-accent)' },
  { value: 'replied', label: 'Odpovědi', color: 'var(--app-warning)' },
  { value: 'lead_created', label: 'Leady', color: 'var(--app-positive)' },
]

// Bottleneck: the transition with the LOWEST retention — its destination stage
// is the peg. Data-driven from `dropoffs`, never hardcoded.
const TRANSITIONS = [
  { to: 'opened', key: 'sent_to_opened' }, { to: 'replied', key: 'sent_to_replied' },
  { to: 'engaged', key: 'replied_to_engaged' }, { to: 'leads', key: 'engaged_to_lead' },
  { to: 'won', key: 'lead_to_won' },
].filter((t) => OPEN_TRACKING_ENABLED || t.to !== 'opened')
function findBottleneck(dropoffs) {
  if (!dropoffs) return null
  let worst = null
  for (const { to, key } of TRANSITIONS) {
    const pct = dropoffs[key]
    if (pct == null) continue
    if (worst === null || pct < worst.pct) worst = { stage: to, pct }
  }
  return worst?.stage ?? null
}

function FunnelBar({ label, value, pct, tone, sub, peg }) {
  return (
    <div className="app-anl-fbar">
      <div className="app-anl-fbar__head">
        <span className={`app-anl-fbar__label${peg ? ' app-anl-fbar__label--peg' : ''}`}>
          {label}
          {peg ? <span className="app-anl-peg" title="Nejprudší propad v trychtýři — sem nejvíc kontaktů vypadne.">úzké hrdlo</span> : null}
        </span>
        <span className="app-anl-fbar__val">{fmt(value)}{sub ? <span className="app-anl-muted"> {sub}</span> : null}</span>
      </div>
      <div className="app-anl-fbar__track">
        <div className={`app-anl-fbar__fill app-anl-fbar__fill--${tone}`} style={{ width: `${Math.max(2, pct ?? 100)}%` }} />
      </div>
    </div>
  )
}

function DropOff({ pct }) {
  if (pct == null) return <div className="app-anl-drop app-anl-drop--spacer" />
  return (
    <div className={`app-anl-drop app-anl-drop--${dropTone(pct)}`}>
      <ArrowDown size={11} className="app-ico" /> {pct} %
    </div>
  )
}

export default function AnalytikaFunnel() {
  const [days, setDays] = useState(DEFAULT_DAYS)
  const [series, setSeries] = useState('sent')

  const res = useResource(`/api/funnel/summary?days=${days}`, { pollMs: POLL_MS, pauseHidden: true })
  const data = res.status === 'ok' ? res.data : null
  const funnel = data?.funnel || null
  const templates = data?.templates || []
  const timeline = data?.timeline || []

  const sent = funnel?.sent ?? 0
  const d = funnel?.dropoffs ?? {}
  const bottleneck = useMemo(() => findBottleneck(funnel?.dropoffs), [funnel])
  const relPct = (n) => (sent > 0 ? Math.round((n / sent) * 100) : 0)
  const activeSeries = SERIES_OPTIONS.find((o) => o.value === series) || SERIES_OPTIONS[0]

  const stages = (funnel ? [
    { id: 'sent', label: 'Odesláno', value: funnel.sent ?? 0, pct: 100, drop: null },
    { id: 'opened', label: 'Otevřeno', value: funnel.opened ?? 0, pct: relPct(funnel.opened ?? 0), drop: d.sent_to_opened, sub: d.sent_to_opened != null ? `(${d.sent_to_opened} % z ods.)` : '' },
    { id: 'replied', label: 'Odpovězeno', value: funnel.replied ?? 0, pct: relPct(funnel.replied ?? 0), drop: d.sent_to_replied, sub: d.sent_to_replied != null ? `(${d.sent_to_replied} % z ods.)` : '' },
    { id: 'engaged', label: 'Zapojeni', value: funnel.classified_engagement ?? 0, pct: relPct(funnel.classified_engagement ?? 0), drop: d.replied_to_engaged, sub: d.replied_to_engaged != null ? `(${d.replied_to_engaged} % z odpov.)` : '' },
    { id: 'leads', label: 'Lead vytvořen', value: funnel.lead_created ?? 0, pct: relPct(funnel.lead_created ?? 0), drop: d.engaged_to_lead, sub: d.engaged_to_lead != null ? `(${d.engaged_to_lead} % ze zap.)` : '' },
    { id: 'won', label: 'Vyhráno', value: funnel.lead_won ?? 0, pct: relPct(funnel.lead_won ?? 0), drop: d.lead_to_won, sub: d.lead_to_won != null ? `(${d.lead_to_won} % z leadů)` : '' },
  ] : []).filter((s) => OPEN_TRACKING_ENABLED || s.id !== 'opened')

  return (
    <div className="app-anl-panel app-anl-panel--stack" role="tabpanel" data-testid="app-analytika-panel-funnel">
      <div className="app-anl-bar">
        <span className="app-anl-bar__title"><TrendingUp size={15} className="app-ico" /> Konverzní trychtýř</span>
        <Chips value={days} onChange={setDays} options={DAY_OPTIONS} label="Časové okno" testidPrefix="app-analytika-funnel-d" />
      </div>

      <Async res={res} hasData={!!funnel}>
        {funnel ? (
          <>
            <div className="app-anl-fgrid">
              <Card title="Konverzní trychtýř" testid="app-analytika-funnel-bars">
                {stages.map((s, i) => (
                  <div key={s.id}>
                    {i > 0 ? <DropOff pct={s.drop} /> : null}
                    <FunnelBar label={s.label} value={s.value} pct={s.pct} tone={STAGE_TONE[s.id]} sub={s.sub} peg={bottleneck === s.id} />
                  </div>
                ))}
                <div className="app-anl-fextra">
                  {[
                    { l: 'Negativní', v: funnel.classified_negative },
                    { l: 'Bounce', v: funnel.classified_bounce },
                    { l: 'Potlačeno', v: funnel.suppressed },
                    { l: 'Prohráno', v: funnel.lead_lost },
                  ].map((x) => (
                    <div key={x.l} className="app-anl-muted">{x.l}: <strong className="app-anl-fextra__v">{fmt(x.v)}</strong></div>
                  ))}
                </div>
              </Card>

              <Card title="Šablony — posledních 30 dní" testid="app-analytika-funnel-templates">
                {templates.length === 0 ? (
                  <div className="app-anl-msg">Žádné šablony.</div>
                ) : (
                  <div className="app-anl-tablewrap">
                    <table className="app-anl-table">
                      <thead>
                        <tr>
                          <th>Šablona</th>
                          <th className="app-anl-table__num">Odesláno</th>
                          <th className="app-anl-table__num">Odpovědi</th>
                          <th className="app-anl-table__num">Reply %</th>
                          <th className="app-anl-table__num">Zapojeni</th>
                        </tr>
                      </thead>
                      <tbody>
                        {templates.map((t) => (
                          <tr key={t.template_name}>
                            <td className="app-anl-table__name">{t.template_name}</td>
                            <td className="app-anl-table__num">{fmt(t.sent)}</td>
                            <td className="app-anl-table__num">{fmt(t.replied)}</td>
                            <td className={`app-anl-table__num app-anl-rr--${t.reply_rate_pct >= 5 ? 'ok' : t.reply_rate_pct >= 2 ? 'warn' : 'neutral'}`}>
                              {t.reply_rate_pct != null ? `${t.reply_rate_pct} %` : '—'}
                            </td>
                            <td className="app-anl-table__num">{fmt(t.engaged)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>

            <Card title={`Denní vývoj — posledních ${days} dní`} testid="app-analytika-funnel-timeline"
              tools={<Chips value={series} onChange={setSeries} options={SERIES_OPTIONS} label="Série" />}>
              <div className="app-anl-chart">
                <BarChart data={timeline} valueKey={activeSeries.value} color={activeSeries.color} testid="app-analytika-funnel-chart" />
              </div>
            </Card>
          </>
        ) : null}
      </Async>
    </div>
  )
}
