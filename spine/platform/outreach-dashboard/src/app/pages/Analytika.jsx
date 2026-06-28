import { useSearchParams } from 'react-router-dom'
import AnalytikaKpi from '../components/analytika/AnalytikaKpi'
import AnalytikaTrendy from '../components/analytika/AnalytikaTrendy'
import AnalytikaCrony from '../components/analytika/AnalytikaCrony'
import AnalytikaFunnel from '../components/analytika/AnalytikaFunnel'
import './app-analytika.css'

// Analytika — operator metrics hub on the Antique-Alchemist frame. Clean
// rebuild of the Analytics page (4 tabs: KPI / Trendy / Crony / Funnel)
// against the SAME BFF endpoints. Tab bodies live in
// src/app/components/analytika/* so this orchestrator stays small; charts reuse
// the inline-SVG approach (no chart library added) re-tokened to --app-*.
// The active tab is persisted in ?tab= so deep-links + the redirect
// (/observability → ?tab=crony) survive the port. Part of the FE unification.

const TABS = [
  { key: 'kpi', label: 'KPI' },
  { key: 'trendy', label: 'Trendy' },
  { key: 'crony', label: 'Crony' },
  { key: 'funnel', label: 'Funnel' },
]
const VALID = new Set(TABS.map((t) => t.key))

export default function Analytika() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const active = VALID.has(raw) ? raw : 'kpi'

  const setActive = (key) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (!key || key === 'kpi') next.delete('tab')
      else next.set('tab', key)
      return next
    }, { replace: true })
  }

  return (
    <div className="app-analytika" data-testid="app-analytika">
      <div className="app-anl__head">
        <h1 className="app-anl__title">Analytika</h1>
        <span className="app-anl__sub">Doručitelnost, výkon kampaní, konverzní trychtýř a provoz</span>
      </div>

      <div className="app-anl__tabs" role="tablist" aria-label="Analytika — sekce" data-testid="app-analytika-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active === t.key}
            className="app-anl__tab"
            data-testid={`app-analytika-tab-${t.key}`}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {active === 'kpi' ? <AnalytikaKpi /> : null}
      {active === 'trendy' ? <AnalytikaTrendy /> : null}
      {active === 'crony' ? <AnalytikaCrony /> : null}
      {active === 'funnel' ? <AnalytikaFunnel /> : null}
    </div>
  )
}
