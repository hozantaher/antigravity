import './sentryInit.js'
import { Sentry } from './sentryInit.js'
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import './index.css'
// Brand tokens — MUST follow index.css so the bridge rule that re-points
// --accent/--bg/--surface/--text/--muted/--border/--font-* to the warm palette
// wins specificity.
import './styles/tokens-claude.css'
import { ToastProvider } from './components/Toast'
import { RouteErrorBoundary } from './components/RouteErrorBoundary'
import RequireAuth from './components/RequireAuth'
import SentryRouteTracker from './components/SentryRouteTracker'
import { AlertToastListener } from './components/AlertToastListener'

// The single dashboard shell + its surfaces (code-split). Surfaces live in
// src/app/pages and slot into the shell's <Outlet/>.
const AppShell = lazy(() => import('./app/AppShell'))
const LoginPage = lazy(() => import('./app/pages/LoginPage'))
const Home = lazy(() => import('./app/pages/Home'))
const Odpovedi = lazy(() => import('./app/pages/Odpovedi'))
const Vozidla = lazy(() => import('./app/pages/Vozidla'))
const Kontakty = lazy(() => import('./app/pages/Kontakty'))
const Firmy = lazy(() => import('./app/pages/Firmy'))
const Kampane = lazy(() => import('./app/pages/Kampane'))
const KampanDetail = lazy(() => import('./app/pages/KampanDetail'))
const KampanCreate = lazy(() => import('./app/pages/KampanCreate'))
const Crm = lazy(() => import('./app/pages/Crm'))
const Hledat = lazy(() => import('./app/pages/Hledat'))
const Kvalita = lazy(() => import('./app/pages/Kvalita'))
const Upozorneni = lazy(() => import('./app/pages/Upozorneni'))
const Sablony = lazy(() => import('./app/pages/Sablony'))
const TopTargets = lazy(() => import('./app/pages/TopTargets'))
const Segmenty = lazy(() => import('./app/pages/Segmenty'))
const SegmentBuilder = lazy(() => import('./app/pages/SegmentBuilder'))
const DedupGuard = lazy(() => import('./app/pages/DedupGuard'))
const Anonymita = lazy(() => import('./app/pages/Anonymita'))
const Analytika = lazy(() => import('./app/pages/Analytika'))
const Nastaveni = lazy(() => import('./app/pages/Nastaveni'))
const Schranky = lazy(() => import('./app/pages/Schranky'))
const MissionControl = lazy(() => import('./MissionControl'))
// Param- + query-preserving redirect for legacy deep links (e.g. /campaigns/:id).
function ParamRedirect({ to }) {
  const params = useParams()
  const { search } = useLocation()
  let target = to
  for (const [k, v] of Object.entries(params)) {
    if (v != null) target = target.replace(`:${k}`, encodeURIComponent(v))
  }
  return <Navigate to={`${target}${search}`} replace />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<div style={{ padding: 32, color: 'var(--red)' }}>Nastala neočekávaná chyba. Zkuste obnovit stránku.</div>}>
    <ToastProvider>
      <BrowserRouter>
        <SentryRouteTracker />
        <AlertToastListener />
        <Suspense fallback={<div style={{ padding: 32, color: 'var(--muted)' }}>Načítám…</div>}>
          <Routes>
            {/* Public route — outside the auth guard. */}
            <Route path="/login" element={<LoginPage />} />

            {/* Everything else requires login. */}
            <Route element={<RequireAuth />}>

              {/* The dashboard shell. Each child is wrapped in its own
                  RouteErrorBoundary so one page crash is isolated to the content
                  area (sidebar + topbar survive). */}
              <Route element={<RouteErrorBoundary><AppShell /></RouteErrorBoundary>}>
                <Route index element={<RouteErrorBoundary><Home /></RouteErrorBoundary>} />
                <Route path="odpovedi" element={<RouteErrorBoundary><Odpovedi /></RouteErrorBoundary>} />
                <Route path="vozidla" element={<RouteErrorBoundary><Vozidla /></RouteErrorBoundary>} />
                <Route path="firmy" element={<RouteErrorBoundary><Firmy /></RouteErrorBoundary>} />
                <Route path="kontakty" element={<RouteErrorBoundary><Kontakty /></RouteErrorBoundary>} />
                <Route path="kampane" element={<RouteErrorBoundary><Kampane /></RouteErrorBoundary>} />
                {/* Static 'nova' before dynamic ':id' so it isn't captured as an id. */}
                <Route path="kampane/nova" element={<RouteErrorBoundary><KampanCreate /></RouteErrorBoundary>} />
                <Route path="kampane/:id" element={<RouteErrorBoundary><KampanDetail /></RouteErrorBoundary>} />
                <Route path="crm" element={<RouteErrorBoundary><Crm /></RouteErrorBoundary>} />
                <Route path="hledat" element={<RouteErrorBoundary><Hledat /></RouteErrorBoundary>} />
                <Route path="kvalita" element={<RouteErrorBoundary><Kvalita /></RouteErrorBoundary>} />
                <Route path="upozorneni" element={<RouteErrorBoundary><Upozorneni /></RouteErrorBoundary>} />
                <Route path="sablony" element={<RouteErrorBoundary><Sablony /></RouteErrorBoundary>} />
                <Route path="cile" element={<RouteErrorBoundary><TopTargets /></RouteErrorBoundary>} />
                {/* Static 'segmenty/novy' before any future dynamic segmenty/:id. */}
                <Route path="segmenty/novy" element={<RouteErrorBoundary><SegmentBuilder /></RouteErrorBoundary>} />
                <Route path="segmenty" element={<RouteErrorBoundary><Segmenty /></RouteErrorBoundary>} />
                <Route path="dedup" element={<RouteErrorBoundary><DedupGuard /></RouteErrorBoundary>} />
                <Route path="anonymita" element={<RouteErrorBoundary><Anonymita /></RouteErrorBoundary>} />
                <Route path="analytika" element={<RouteErrorBoundary><Analytika /></RouteErrorBoundary>} />
                <Route path="nastaveni" element={<RouteErrorBoundary><Nastaveni /></RouteErrorBoundary>} />
                <Route path="schranky" element={<RouteErrorBoundary><Schranky /></RouteErrorBoundary>} />
                <Route path="mission-control" element={<RouteErrorBoundary><MissionControl /></RouteErrorBoundary>} />
              </Route>

              {/* Legacy deep-link redirects (old route names → current surfaces). */}
              <Route path="companies" element={<Navigate to="/firmy" replace />} />
              <Route path="campaigns" element={<Navigate to="/kampane" replace />} />
              <Route path="campaigns/:id/segment" element={<ParamRedirect to="/kampane/:id" />} />
              <Route path="campaigns/:id" element={<ParamRedirect to="/kampane/:id" />} />
              <Route path="templates" element={<Navigate to="/sablony" replace />} />
              <Route path="mailboxes" element={<Navigate to="/schranky" replace />} />
              <Route path="contacts" element={<Navigate to="/kontakty" replace />} />
              <Route path="segments/builder" element={<Navigate to="/segmenty/novy" replace />} />
              <Route path="segments" element={<Navigate to="/segmenty" replace />} />
              <Route path="top-targets" element={<Navigate to="/cile" replace />} />
              <Route path="priprava/top-targets" element={<Navigate to="/cile" replace />} />
              <Route path="priprava/hesla" element={<Navigate to="/schranky" replace />} />
              <Route path="priprava" element={<Navigate to="/" replace />} />
              <Route path="replies/chat" element={<Navigate to="/odpovedi" replace />} />
              <Route path="replies/:id" element={<Navigate to="/odpovedi" replace />} />
              <Route path="replies" element={<Navigate to="/odpovedi" replace />} />
              <Route path="analytics" element={<Navigate to="/analytika" replace />} />
              <Route path="scoring" element={<Navigate to="/nastaveni?tab=thresholds" replace />} />
              <Route path="watchdog" element={<Navigate to="/schranky" replace />} />
              <Route path="leads" element={<Navigate to="/kontakty" replace />} />
              <Route path="observability" element={<Navigate to="/analytika?tab=crony" replace />} />
              <Route path="notifications" element={<Navigate to="/upozorneni" replace />} />
              <Route path="diagnostika/anonymita" element={<Navigate to="/anonymita" replace />} />
              <Route path="dedup-guard" element={<Navigate to="/dedup" replace />} />
              <Route path="crm/clients" element={<Navigate to="/crm" replace />} />
              <Route path="vehicles/:id" element={<ParamRedirect to="/vozidla" />} />
              <Route path="vehicles" element={<Navigate to="/vozidla" replace />} />
              <Route path="settings/branding" element={<Navigate to="/nastaveni?tab=branding" replace />} />
              <Route path="settings/icp" element={<Navigate to="/nastaveni?tab=icp" replace />} />
              <Route path="settings/thresholds" element={<Navigate to="/nastaveni?tab=thresholds" replace />} />
              <Route path="settings" element={<Navigate to="/nastaveni" replace />} />
              <Route path="*" element={<Navigate to="/" replace />} />

            </Route>{/* end RequireAuth */}
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>
)
