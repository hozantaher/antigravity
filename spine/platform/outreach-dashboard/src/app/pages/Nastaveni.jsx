import { useSearchParams } from 'react-router-dom'
import { Building2, Target, SlidersHorizontal } from 'lucide-react'
import BrandingTab from '../components/nastaveni/BrandingTab'
import IcpTab from '../components/nastaveni/IcpTab'
import ThresholdsTab from '../components/nastaveni/ThresholdsTab'
import './app-nastaveni.css'

// Nastavení — operator config on the Antique Alchemist frame. Clean rebuild
// of the Settings surface (src/pages/Settings.jsx + src/components/settings/*).
// One URL-driven tab layout, replicating the /settings,{/branding,/icp,
// /thresholds} routes via a single ?tab= query param under /nastaveni:
//   ?tab=branding (default) → Entita & brand   (operator_settings, 9 keys)
//   ?tab=icp                → ICP sektory       (/api/icp-sectors CRUD)
//   ?tab=thresholds         → Provozní pravidla (operator_settings thresholds)
// Each tab owns its own 4-state fetch (useResource) + Save flow (toast). No
// imports — the only shared module is the thresholdDefaults spec (a lib, not UI).
// docs/initiatives — dashboard FE unification.

const TABS = [
  { key: 'branding', label: 'Entita & brand', icon: Building2 },
  { key: 'icp', label: 'ICP sektory', icon: Target },
  { key: 'thresholds', label: 'Provozní pravidla', icon: SlidersHorizontal },
]
const TAB_KEYS = new Set(TABS.map((t) => t.key))

export default function Nastaveni() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const active = TAB_KEYS.has(raw) ? raw : 'branding'

  const setTab = (key) => {
    const next = new URLSearchParams(params)
    if (key === 'branding') next.delete('tab') // keep the default URL clean
    else next.set('tab', key)
    setParams(next, { replace: true })
  }

  return (
    <div className="app-nastaveni" data-testid="app-nastaveni">
      <div className="app-nast__head">
        <div>
          <h1 className="app-nast__title">Nastavení</h1>
          <span className="app-nast__sub">
            Identita správce, cílové sektory pro ICP scoring a provozní prahy. Změny se propisují do pipeline bez restartu.
          </span>
        </div>
      </div>

      <div className="app-nast-tabs" role="tablist" aria-label="Sekce nastavení" data-testid="app-nastaveni-tabs">
        {TABS.map((t) => {
          const Icon = t.icon
          const isActive = active === t.key
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`app-nast-tab${isActive ? ' app-nast-tab--active' : ''}`}
              data-testid={`app-nastaveni-tab-${t.key}`}
              onClick={() => setTab(t.key)}
            >
              <Icon size={15} strokeWidth={1.9} /> {t.label}
            </button>
          )
        })}
      </div>

      {active === 'branding' && <BrandingTab />}
      {active === 'icp' && <IcpTab />}
      {active === 'thresholds' && <ThresholdsTab />}
    </div>
  )
}
