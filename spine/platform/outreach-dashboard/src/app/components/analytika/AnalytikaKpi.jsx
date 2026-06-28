// Analytika — KPI tab. Overview stat strip + timeline bar chart + sortable
// campaign-performance table. Clean rebuild of AnalyticsKpiTab against the
// SAME BFF endpoints (/api/analytics/{overview,campaigns,timeline}).

import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Send, MessageSquare, Eye, AlertTriangle, Activity, RefreshCw, ArrowUp, ArrowDown } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { relativeCs } from '../../lib/replyMeta'
import { BarChart, Chips, Card, fmt, POLL_MS } from './Charts'

// Open-pixel tracking is DISABLED by design (Seznam anti-spam fingerprint, AR2):
// {{.OpenPixel}} renders empty and there is no opened_at column, so total_opened
// is structurally 0. We show the honest "sledování vypnuto" instead of a false 0.
const OPEN_TRACKING_ENABLED = false

const STATUS_LABEL = {
  active: 'Aktivní', running: 'Spuštěna', paused: 'Pozastavena',
  draft: 'Koncept', completed: 'Dokončena', archived: 'Archivována',
}
const STATUS_TONE = {
  active: 'ok', running: 'ok', paused: 'warn',
  draft: 'neutral', completed: 'info', archived: 'neutral',
}

const DAY_OPTIONS = [
  { value: 7, label: '7 dní' }, { value: 14, label: '14 dní' },
  { value: 30, label: '30 dní' }, { value: 90, label: '90 dní' },
]
const SERIES_OPTIONS = [
  { value: 'sent', label: 'Odesláno', color: 'var(--app-accent)' },
  { value: 'replied', label: 'Odpovědi', color: 'var(--app-positive)' },
]

// Reply-rate semantic tone — named thresholds, no magic numbers.
const RR_GOOD_PCT = 5
const RR_OK_PCT = 2
const BOUNCE_ALERT_PCT = 5
function rrTone(rr) { return rr >= RR_GOOD_PCT ? 'ok' : rr >= RR_OK_PCT ? 'warn' : 'err' }

export default function AnalytikaKpi() {
  const navigate = useNavigate()
  const [days, setDays] = useState(30)
  const [series, setSeries] = useState('sent')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('desc')

  const dateRangeError = from && to && from > to ? "Datum „od“ musí být před datem „do“." : null

  const overviewRes = useResource('/api/analytics/overview', { pollMs: POLL_MS, pauseHidden: true })
  const campaignsRes = useResource('/api/analytics/campaigns', { pollMs: POLL_MS, pauseHidden: true })
  const timelineUrl = useMemo(() => {
    const valid = from && to && from <= to
    return `/api/analytics/timeline?days=${days}` + (valid ? `&from=${from}&to=${to}` : '')
  }, [days, from, to])
  const timelineRes = useResource(timelineUrl, { pollMs: POLL_MS, pauseHidden: true })

  const overview = overviewRes.status === 'ok' ? overviewRes.data : null
  const timeline = timelineRes.status === 'ok' && Array.isArray(timelineRes.data) ? timelineRes.data : []
  const campaigns = campaignsRes.status === 'ok' && Array.isArray(campaignsRes.data) ? campaignsRes.data : []
  const ready = overviewRes.status === 'ok'

  const totalSent = overview?.total_sent || 0
  const totalReplied = overview?.total_replied || 0
  const totalBounced = overview?.total_bounced || 0
  const replyRate = totalSent > 0 ? (totalReplied / totalSent) * 100 : 0
  const bounceRate = totalSent > 0 ? (totalBounced / totalSent) * 100 : 0

  const activeSeries = SERIES_OPTIONS.find((o) => o.value === series) || SERIES_OPTIONS[0]

  const sorted = useMemo(() => {
    if (!sortKey) return campaigns
    // The "Reply rate" header sorts by 'replied', but the cell shows the DERIVED
    // replied/sent %. Sort by that ratio so the column orders by what's shown,
    // not the raw reply COUNT. Other columns sort by their raw numeric value.
    const valOf = (c) => {
      if (sortKey === 'replied') {
        const s = Number(c.sent) || 0
        return s > 0 ? (Number(c.replied) || 0) / s : 0
      }
      return Number(c[sortKey]) || 0
    }
    return [...campaigns].sort((a, b) => {
      const va = valOf(a), vb = valOf(b)
      return sortDir === 'desc' ? vb - va : va - vb
    })
  }, [campaigns, sortKey, sortDir])

  const handleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else { setSortKey(key); setSortDir('desc') }
  }
  const SortIco = ({ k }) => sortKey !== k ? null
    : sortDir === 'desc' ? <ArrowDown size={11} className="app-ico" /> : <ArrowUp size={11} className="app-ico" />

  const loadedAt = timelineRes.loadedAt || overviewRes.loadedAt
  const refreshAll = () => { overviewRes.refresh?.(); campaignsRes.refresh?.(); timelineRes.refresh?.() }
  const anyError = overviewRes.status === 'error' || campaignsRes.status === 'error' || timelineRes.status === 'error'

  const statCells = [
    { l: 'Celkem odesláno', v: ready ? fmt(totalSent) : '—', sub: overview ? `${fmt(overview.sent_7d || 0)} za 7 dní` : null },
    { l: 'Reply rate', v: ready ? `${replyRate.toFixed(1)} %` : '—', sub: `${fmt(totalReplied)} odpovědí`, tone: ready ? rrTone(replyRate) : null },
    { l: 'Open rate', v: '—', sub: 'sledování vypnuto', title: 'Open-pixel je vypnutý kvůli doručitelnosti (anti-spam) — otevření se záměrně neměří.' },
    { l: 'Bounce rate', v: ready ? `${bounceRate.toFixed(1)} %` : '—', sub: `${fmt(totalBounced)} odraženo`, tone: ready && bounceRate > BOUNCE_ALERT_PCT ? 'err' : null },
    { l: 'Aktivní kampaně', v: overview?.active_campaigns ?? '—', tone: overview?.active_campaigns > 0 ? 'ok' : null },
  ]

  return (
    <div className="app-anl-panel" role="tabpanel" data-testid="app-analytika-panel-kpi">
      <div className="app-anl-bar">
        <span className="app-anl-bar__fresh">{loadedAt ? `Aktualizováno ${relativeCs(loadedAt)}` : ' '}</span>
        <button type="button" className="app-anl-refresh" onClick={refreshAll}
          disabled={timelineRes.status === 'loading'} data-testid="app-analytika-refresh" title="Obnovit">
          <RefreshCw size={14} /> Obnovit
        </button>
      </div>

      {anyError ? (
        <div className="app-anl-msg app-anl-msg--err" data-testid="app-analytika-kpi-error">
          <AlertTriangle size={14} className="app-ico" /> Některá data se nepodařilo načíst.
          {overviewRes.error ? ` Přehled: ${overviewRes.error}.` : ''}
          {campaignsRes.error ? ` Kampaně: ${campaignsRes.error}.` : ''}
          {timelineRes.error ? ` Vývoj: ${timelineRes.error}.` : ''}
        </div>
      ) : null}

      <div className="app-anl-stats app-anl-stats--5" data-testid="app-analytika-kpi-stats">
        {statCells.map((c) => (
          <div className={`app-anl-stat${c.tone ? ' app-anl-stat--' + c.tone : ''}`} key={c.l} title={c.title}>
            <div className="app-anl-stat__n">{c.v}</div>
            <div className="app-anl-stat__l">{c.l}</div>
            {c.sub ? <div className="app-anl-stat__sub">{c.sub}</div> : null}
          </div>
        ))}
      </div>

      <Card
        title="Vývoj v čase"
        tools={
          <div className="app-anl-card__toolrow">
            <Chips value={series} onChange={setSeries} options={SERIES_OPTIONS} label="Série" />
            <Chips value={days} onChange={(d) => { setDays(d); setFrom(''); setTo('') }} options={DAY_OPTIONS} label="Časové okno" />
            <input type="date" className={`app-anl-date${dateRangeError ? ' app-anl-date--err' : ''}`} value={from}
              onChange={(e) => setFrom(e.target.value)} aria-label="Datum od" data-testid="app-analytika-date-from" />
            <input type="date" className={`app-anl-date${dateRangeError ? ' app-anl-date--err' : ''}`} value={to}
              onChange={(e) => setTo(e.target.value)} aria-label="Datum do" data-testid="app-analytika-date-to" />
          </div>
        }
      >
        {dateRangeError ? <div className="app-anl-msg app-anl-msg--err" role="alert" data-testid="app-analytika-date-error">{dateRangeError}</div> : null}
        <div className="app-anl-chart">
          <BarChart data={timeline} valueKey={activeSeries.value} color={activeSeries.color} />
        </div>
      </Card>

      <Card title="Výkonnost kampaní" testid="app-analytika-campaigns">
        {campaigns.length === 0 ? (
          <div className="app-anl-msg">{campaignsRes.status === 'ok' ? 'Žádné kampaně.' : 'Načítám…'}</div>
        ) : (
          <div className="app-anl-tablewrap">
            <table className="app-anl-table">
              <thead>
                <tr>
                  <th>Kampaň</th>
                  <th className="app-anl-table__num app-anl-table__sort" onClick={() => handleSort('sent')}>
                    Odesláno <SortIco k="sent" />
                  </th>
                  <th className="app-anl-table__num app-anl-table__sort" onClick={() => handleSort('replied')}>
                    Reply rate <SortIco k="replied" />
                  </th>
                  <th className="app-anl-table__num">Open rate</th>
                  <th className="app-anl-table__num">Bounce</th>
                  <th>Stav</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((c) => {
                  const sent = Number(c.sent) || 0, replied = Number(c.replied) || 0, bounced = Number(c.bounced) || 0
                  const rr = sent > 0 ? (replied / sent) * 100 : 0
                  return (
                    <tr key={c.id} className="app-anl-table__rowlink" data-testid="app-analytika-campaign-row"
                      onClick={() => navigate(`/kampane/${c.id}`)}>
                      <td className="app-anl-table__name">{c.name}</td>
                      <td className="app-anl-table__num">{fmt(sent)}</td>
                      <td className={`app-anl-table__num app-anl-rr app-anl-rr--${rrTone(rr)}`}>{rr.toFixed(1)} %</td>
                      <td className="app-anl-table__num app-anl-muted">—</td>
                      <td className={`app-anl-table__num${bounced > 0 ? ' app-anl-rr--err' : ' app-anl-muted'}`}>{bounced > 0 ? fmt(bounced) : '—'}</td>
                      <td><span className={`app-anl-pill app-anl-pill--${STATUS_TONE[c.status] || 'neutral'}`}>{STATUS_LABEL[c.status] || c.status}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
