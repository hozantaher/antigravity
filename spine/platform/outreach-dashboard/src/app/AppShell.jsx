import { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Inbox, Truck, Building2, Users, Megaphone, BarChart3, IdCard, ShieldCheck, Sun, Moon, LogOut, ChevronDown, ChevronRight, Bell, FileText, Target, Layers, CopyX, Fingerprint, LineChart, Mailbox, Settings, PanelLeftClose, PanelLeftOpen, Maximize2, Minimize2 } from 'lucide-react'
import './styles/tokens.css'
import './styles/app-shared.css'
import {
  COMPACT_MEDIA_QUERY, DENSITY_AUTO, DENSITY_COMPACT, DENSITY_COMFORTABLE,
  resolveDensity, viewportIsCompact,
} from './lib/breakpoints.js'
import IngestFreshness from './components/IngestFreshness'
import { useAuthStore, signOut } from '../store/authStore.js'
import ShellBanners from './components/ShellBanners'
import PauseAll from './components/PauseAll'

// UX app shell — Claude.ai aesthetic, parallel to (mounted at /). Calm sidebar +
// minimal topbar + generous content area. Everything reads the --app-* tokens; is
// untouched. docs/initiatives/2026-05-31-ux-app-claude.md
//
// S0 (2026-06-24): the shell now drives two laptop-density levers via attributes:
//   data-density  — compact|comfortable, auto on laptop/short viewports + manual
//                   override (useDensity). Compresses spacing/chrome tokens.
//   data-sidebar  — collapsed|expanded, an icon-rail mode reclaiming ~128px.
// See docs/initiatives/2026-06-24-laptop-responsivity-density.md.

// Grouped, extensible nav (S2 unification). Primary surfaces have no header;
// labeled sections group the rest; `collapsible` sections remember their state
// in localStorage and force open when they contain the active route. New ported
// surfaces (Schránky, Šablony, Nastavení, Analytika, …) slot into a section.
const NAV_SECTIONS = [
  {
    key: 'main',
    items: [
      { to: '/', end: true, icon: BarChart3, label: 'Přehled', kbd: '1' },
      { to: '/odpovedi', icon: Inbox, label: 'Odpovědi', badge: 'unread', kbd: '2' },
      { to: '/vozidla', icon: Truck, label: 'Vozidla', kbd: '3' },
      { to: '/kampane', icon: Megaphone, label: 'Kampaně', kbd: '4' },
    ],
  },
  {
    key: 'data', label: 'Data',
    items: [
      { to: '/firmy', icon: Building2, label: 'Firmy' },
      { to: '/kontakty', icon: Users, label: 'Kontakty' },
      { to: '/crm', icon: IdCard, label: 'CRM' },
      { to: '/cile', icon: Target, label: 'Top cíle' },
      { to: '/segmenty', icon: Layers, label: 'Segmenty' },
    ],
  },
  {
    key: 'nastroje', label: 'Nástroje',
    items: [
      { to: '/sablony', icon: FileText, label: 'Šablony' },
      { to: '/analytika', icon: LineChart, label: 'Analytika' },
    ],
  },
  {
    key: 'provoz', label: 'Provoz', collapsible: true,
    items: [
      { to: '/schranky', icon: Mailbox, label: 'Schránky' },
      { to: '/kvalita', icon: ShieldCheck, label: 'Kvalita dat' },
      { to: '/upozorneni', icon: Bell, label: 'Upozornění' },
      { to: '/dedup', icon: CopyX, label: 'Duplicity' },
      { to: '/anonymita', icon: Fingerprint, label: 'Anonymita' },
      { to: '/nastaveni', icon: Settings, label: 'Nastavení' },
    ],
  },
]
const NAV_ITEMS = NAV_SECTIONS.flatMap((s) => s.items)

const THEME_KEY = 'uiTheme'
const NAV_COLLAPSE_KEY = 'navCollapsed'
const DENSITY_KEY = 'uiDensity'
const SIDEBAR_COLLAPSE_KEY = 'uiSidebarCollapsed'

// One sidebar nav row. Extracted so grouped sections render identical items.
// `collapsed` (icon-rail) drops the label + centers the icon and shows the
// unread count as a dot instead of a number.
function NavItem({ item, unhandled, collapsed }) {
  const { to, end, icon: Icon, label, badge, kbd } = item
  const showBadge = badge === 'unread' && unhandled > 0
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  return (
    <NavLink
      to={to}
      end={end}
      data-testid={`app-nav-${label}`}
      title={collapsed ? label : undefined}
      style={({ isActive }) => ({
        display: 'flex', alignItems: 'center', gap: collapsed ? 0 : 'var(--app-space-3)',
        justifyContent: collapsed ? 'center' : 'flex-start', position: 'relative',
        padding: collapsed ? '9px 0' : '9px var(--app-space-3)', borderRadius: 'var(--app-radius-sm)',
        color: isActive ? 'var(--app-accent-strong)' : 'var(--app-text-muted)',
        background: isActive ? 'var(--app-accent-soft)' : 'transparent',
        textDecoration: 'none', fontSize: 'var(--app-text-base)',
        fontWeight: isActive ? 600 : 500, transition: 'background var(--app-fast) var(--app-ease)',
      })}
    >
      <Icon size={18} strokeWidth={2} />
      {!collapsed && <span>{label}</span>}
      {!collapsed && kbd && (
        <span className="app-nav-kbd">
          {isMac ? '⌘' : 'Ctrl'}{kbd}
        </span>
      )}
      {showBadge && collapsed ? (
        <span
          data-testid="app-nav-unread-dot"
          aria-label={`${unhandled} nevyřízených odpovědí`}
          style={{
            position: 'absolute', top: 6, right: 6, width: 7, height: 7,
            borderRadius: '50%', background: 'var(--app-accent-strong)',
          }}
        />
      ) : null}
      {showBadge && !collapsed ? (
        <span
          data-testid="app-nav-unread-badge"
          aria-label={`${unhandled} nevyřízených odpovědí`}
          style={{
            marginLeft: 'auto', minWidth: 20, textAlign: 'center',
            fontSize: 'var(--app-text-xs)', fontWeight: 700, lineHeight: '18px',
            padding: '0 6px', borderRadius: 'var(--app-radius-pill)',
            background: 'var(--app-accent-strong)', color: 'var(--app-on-accent, #fff)',
          }}
        >
          {unhandled > 99 ? '99+' : unhandled}
        </span>
      ) : null}
    </NavLink>
  )
}

export default function AppShell() {
  const user = useAuthStore((s) => s.user)
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'light' } catch { return 'light' }
  })
  useEffect(() => { try { localStorage.setItem(THEME_KEY, theme) } catch {} }, [theme])
  const loc = useLocation()
  const navigate = useNavigate()

  // ── Density (S0) — auto-compact on laptop/short viewports + manual override.
  // densityPref persists; 'auto' derives from the COMPACT_MEDIA_QUERY live, an
  // explicit choice wins. Spacing/chrome compress via [data-density] in tokens.
  const [densityPref, setDensityPref] = useState(() => {
    try { return localStorage.getItem(DENSITY_KEY) || DENSITY_AUTO } catch { return DENSITY_AUTO }
  })
  const [vpCompact, setVpCompact] = useState(() => viewportIsCompact())
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(COMPACT_MEDIA_QUERY)
    const onChange = (e) => setVpCompact(e.matches)
    setVpCompact(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  useEffect(() => { try { localStorage.setItem(DENSITY_KEY, densityPref) } catch {} }, [densityPref])
  const density = resolveDensity(densityPref, vpCompact)
  const toggleDensity = () => setDensityPref(density === DENSITY_COMPACT ? DENSITY_COMFORTABLE : DENSITY_COMPACT)

  // ── Sidebar icon-collapse (S0) — reclaims ~128px horizontal on every surface.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1' } catch { return false }
  })
  useEffect(() => { try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, sidebarCollapsed ? '1' : '0') } catch {} }, [sidebarCollapsed])

  // /odpovedi* reuses this shell for the reply-triage redesign — map it onto the
  // Odpovědi nav item so the sidebar highlight + topbar title are correct
  // (otherwise no NAV.to matches and the title falls back to "Přehled").
  const activePath = loc.pathname.startsWith('/odpovedi') ? '/odpovedi' : loc.pathname
  const active = NAV_ITEMS.find(n => n.end ? activePath === n.to : activePath.startsWith(n.to))

  // Collapsible nav-section state (persisted). A section force-opens when it
  // contains the active route regardless of the stored collapsed flag.
  const [collapsed, setCollapsed] = useState(() => {
    try { return JSON.parse(localStorage.getItem(NAV_COLLAPSE_KEY) || '{}') } catch { return {} }
  })
  const toggleSection = (key) => setCollapsed((prev) => {
    const next = { ...prev, [key]: !prev[key] }
    try { localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify(next)) } catch {}
    return next
  })

  // Unread-replies badge on the Odpovědi nav item (#1019 [S5.1]). Own light
  // poll (60s) — a plain fetch, not useResource, so it never coalesces with
  // the Odpovědi page's own /api/replies/stats consumer.
  const [unhandled, setUnhandled] = useState(0)
  useEffect(() => {
    let live = true
    const pull = () => {
      if (document.hidden) return
      fetch('/api/replies/stats')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (live && d) setUnhandled(Number(d.nezpracovane ?? d.unhandled ?? 0) || 0) })
        .catch(() => {})
    }
    pull()
    const t = setInterval(pull, 60_000)
    return () => { live = false; clearInterval(t) }
  }, [])

  return (
    <div
      className="app-shell"
      data-theme={theme}
      data-density={density}
      data-sidebar={sidebarCollapsed ? 'collapsed' : 'expanded'}
      data-testid="app-shell"
      style={{ height: '100vh', overflow: 'hidden', display: 'flex' }}
    >
      {/* ── Sidebar — calm, minimal chrome ──────────────────────────────── */}
      <aside
        data-testid="app-sidebar"
        style={{
          width: 'var(--app-sidebar-w)', flexShrink: 0, borderRight: '1px solid var(--app-border)',
          background: 'var(--app-surface)', display: 'flex', flexDirection: 'column',
          padding: sidebarCollapsed ? 'var(--app-space-5) var(--app-space-2)' : 'var(--app-space-5) var(--app-space-3)',
          gap: 'var(--app-space-2)', overflow: 'hidden',
        }}
      >
        {/* Brand + collapse toggle */}
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center',
          justifyContent: sidebarCollapsed ? 'center' : 'space-between', gap: 7,
          padding: sidebarCollapsed ? '0 0 var(--app-space-3)' : '0 var(--app-space-3) var(--app-space-3)',
          marginBottom: 'var(--app-space-4)', borderBottom: '1px solid var(--app-border)',
        }}>
          {!sidebarCollapsed && (
            <div style={{
              fontFamily: 'var(--app-font-serif)', fontSize: 'var(--app-text-lg)', fontWeight: 500,
              color: 'var(--app-text)', display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: 'var(--app-accent-strong)', color: '#fff', fontSize: 11, fontFamily: 'var(--app-font-sans)', fontWeight: 800, letterSpacing: '0.05em' }}>HT</div>
              <span style={{ letterSpacing: '0.01em', transform: 'translateY(-1px)' }}>Hozan</span>
              <span style={{ fontFamily: 'var(--app-font-sans)', fontSize: 'var(--app-text-xs)', color: 'var(--app-text-soft)', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', transform: 'translateY(-1px)' }}>lab</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => setSidebarCollapsed((c) => !c)}
            data-testid="app-sidebar-toggle"
            aria-label={sidebarCollapsed ? 'Rozbalit boční panel' : 'Sbalit boční panel'}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? 'Rozbalit boční panel' : 'Sbalit boční panel'}
            style={{
              flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 'var(--app-radius-sm)',
              border: '1px solid var(--app-border)', background: 'transparent',
              color: 'var(--app-text-muted)', cursor: 'pointer',
            }}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        {!sidebarCollapsed && (
          <button className="app-cta-new" onClick={() => navigate('/kampane/nova')} style={{ margin: '0 var(--app-space-3) var(--app-space-2)' }}>
            <Megaphone size={16} />
            <span>Nová kampaň</span>
          </button>
        )}

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 'var(--app-space-2)', flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }} aria-label="Hlavní navigace">
          {NAV_SECTIONS.map((section) => {
            const sectionHasActive = section.items.some((it) => it.end ? activePath === it.to : activePath.startsWith(it.to))
            const isCollapsed = !!section.collapsible && !!collapsed[section.key] && !sectionHasActive
            // Icon-rail: never hide items behind a section toggle (no labels to click).
            const showItems = sidebarCollapsed ? true : !isCollapsed
            return (
              <div key={section.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {section.label && !sidebarCollapsed ? (
                  section.collapsible ? (
                    <button
                      type="button"
                      onClick={() => toggleSection(section.key)}
                      data-testid={`app-nav-section-${section.key}`}
                      aria-expanded={!isCollapsed}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, marginTop: 'var(--app-space-2)',
                        padding: '4px var(--app-space-3)', background: 'transparent', border: 'none',
                        cursor: 'pointer', color: 'var(--app-text-soft)', fontSize: 'var(--app-text-xs)',
                        fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                      }}
                    >
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <span>{section.label}</span>
                    </button>
                  ) : (
                    <div style={{
                      marginTop: 'var(--app-space-2)', padding: '4px var(--app-space-3)',
                      color: 'var(--app-text-soft)', fontSize: 'var(--app-text-xs)', fontWeight: 700,
                      letterSpacing: '0.06em', textTransform: 'uppercase',
                    }}>
                      {section.label}
                    </div>
                  )
                ) : null}
                {/* Icon-rail divider between sections (no labels to separate them). */}
                {section.label && sidebarCollapsed ? (
                  <div style={{ height: 1, background: 'var(--app-border-soft)', margin: '6px 4px' }} />
                ) : null}
                {showItems && section.items.map((item) => (
                  <NavItem key={item.to} item={item} unhandled={unhandled} collapsed={sidebarCollapsed} />
                ))}
              </div>
            )
          })}
        </nav>

        {/* User row + theme/density toggles — pinned to sidebar bottom */}
        <div style={{ flexShrink: 0, marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {user && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 'var(--app-space-2)',
              justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
              padding: '7px var(--app-space-3)',
              borderTop: '1px solid var(--app-border)',
              paddingTop: 10,
            }}>
              {!sidebarCollapsed && (
                <span style={{
                  flex: 1, fontSize: 'var(--app-text-xs)', color: 'var(--app-text-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {user.email}
                </span>
              )}
              <button
                type="button"
                onClick={() => signOut()}
                title="Odhlásit se"
                aria-label="Odhlásit se"
                style={{
                  flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 'var(--app-radius-sm)',
                  border: '1px solid var(--app-border)', background: 'transparent',
                  color: 'var(--app-text-muted)', cursor: 'pointer',
                  transition: 'color var(--app-fast), border-color var(--app-fast)',
                }}
              >
                <LogOut size={14} strokeWidth={2} />
              </button>
            </div>
          )}
          {/* Density toggle — compact ⇄ comfortable (label shows the ACTION). */}
          <button
            type="button"
            onClick={toggleDensity}
            data-testid="app-density-toggle"
            data-density-pref={densityPref}
            aria-label={density === DENSITY_COMPACT ? 'Přepnout na pohodlný režim' : 'Přepnout na kompaktní režim'}
            title={density === DENSITY_COMPACT ? 'Přepnout na pohodlný režim' : 'Přepnout na kompaktní režim (více dat na obrazovce)'}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--app-space-2)',
              justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
              padding: '9px var(--app-space-3)', borderRadius: 'var(--app-radius-sm)',
              border: '1px solid var(--app-border)', background: 'transparent',
              color: 'var(--app-text-muted)', cursor: 'pointer', fontSize: 'var(--app-text-sm)',
            }}
          >
            {density === DENSITY_COMPACT ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
            {!sidebarCollapsed && (density === DENSITY_COMPACT ? 'Pohodlný režim' : 'Kompaktní režim')}
          </button>
          <button
            type="button"
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            data-testid="app-theme-toggle"
            aria-label={theme === 'dark' ? 'Přepnout na světlý režim' : 'Přepnout na tmavý režim'}
            title={theme === 'dark' ? 'Přepnout na světlý režim' : 'Přepnout na tmavý režim'}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--app-space-2)',
              justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
              padding: '9px var(--app-space-3)', borderRadius: 'var(--app-radius-sm)',
              border: '1px solid var(--app-border)', background: 'transparent',
              color: 'var(--app-text-muted)', cursor: 'pointer', fontSize: 'var(--app-text-sm)',
            }}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            {!sidebarCollapsed && (theme === 'dark' ? 'Světlý režim' : 'Tmavý režim')}
          </button>
        </div>
      </aside>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ShellBanners />
        <header style={{
          height: 'var(--app-topbar-h)', flexShrink: 0, borderBottom: '1px solid var(--app-border-soft)',
          display: 'flex', alignItems: 'center', padding: '0 var(--app-pad-page)',
        }}>
          {/* Canonical page heading — the one <h1> per surface. Styled to match
              the prior topbar span (small sans), overriding the .app-shell h1
              serif/hero rule inline, so in-page label duplicates can be dropped. */}
          <h1 style={{
            margin: 0, fontFamily: 'var(--app-font-sans)', fontSize: 'var(--app-text-base)',
            fontWeight: 600, color: 'var(--app-text)', lineHeight: 1.2, letterSpacing: 0,
          }}>
            {active?.label || 'Přehled'}
          </h1>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--app-space-4)' }}>
          <PauseAll />
          <IngestFreshness />
          <form
            style={{ display: 'flex' }}
            onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get('q')?.toString().trim(); if (q) navigate(`/hledat?q=${encodeURIComponent(q)}`) }}
          >
            <input name="q" type="search" placeholder="Hledat vše…" aria-label="Hledat napříč systémem"
              data-testid="app-topbar-search"
              style={{
                font: 'inherit', fontSize: 'var(--app-text-sm)', color: 'var(--app-text)',
                background: 'var(--app-surface-sunk)', border: '1px solid var(--app-border)',
                borderRadius: 'var(--app-radius-pill)', padding: '5px 14px', width: 220,
              }} />
          </form>
          </div>
        </header>
        <div data-testid="app-content" style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: 'var(--app-pad-page)' }}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
