import { Globe, Wifi, Activity, Shield, ShieldAlert } from 'lucide-react'

// HealthBar — compact anti-trace / egress / watchdog / bounce-guard status pills.
// Condensed port of AnonymizationBar (deep widgets — LaunchStatsRow,
// PoolHealthWidget, ProxyExhaustBanner — intentionally dropped; see report).
// Pure presentational; all data is fetched by the page via useResource.
function relAge(ms) {
  if (ms == null) return '—'
  if (ms < 5000) return 'teď'
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`
  return `${Math.floor(ms / 3_600_000)} h`
}

function Pill({ Icon, label, value, tone }) {
  return (
    <div className={`app-sb-pill app-sb-pill--${tone}`} data-testid="app-schranky-health-pill">
      <Icon size={14} strokeWidth={1.8} className="app-sb-pill__ico" />
      <div className="app-sb-pill__body">
        <div className="app-sb-pill__label">{label}</div>
        <div className="app-sb-pill__val">{value}</div>
      </div>
    </div>
  )
}

export default function HealthBar({ antiTrace, proxyPool, watchdog, bounceHold, total, unhealthy, now }) {
  // Anti-trace egress relay liveness.
  const atLoading = antiTrace == null
  const atOk = antiTrace?.ok
  const atNotConf = antiTrace?.reason === 'not_configured' || antiTrace?.reason === 'fetch_error'
  const atTone = atLoading ? 'muted' : atOk ? 'ok' : atNotConf ? 'muted' : 'crit'
  const atVal = atLoading ? 'Načítám…' : atOk ? `OK · ${antiTrace.ms ?? '?'}ms` : atNotConf ? 'Vypnuto' : 'DOWN'

  // Egress pool (mode-aware, mirrors v1's branch labels at a high level).
  const ppLoading = proxyPool == null
  const ppMode = proxyPool?.mode || 'unknown'
  const ppActive = proxyPool?.active_endpoints ?? proxyPool?.working?.length ?? 0
  const ppSize = proxyPool?.pool_size ?? proxyPool?.total_candidates ?? proxyPool?.endpoints?.length ?? 0
  let ppTone = 'muted'
  let ppVal = 'Načítám…'
  let ppLabel = 'Egress'
  if (!ppLoading) {
    if (ppMode === 'mullvad') {
      ppLabel = 'Egress'; ppTone = proxyPool?.error ? 'crit' : 'ok'
      ppVal = proxyPool?.error ? 'Mullvad nedostupný' : 'Mullvad CZ'
    } else if (ppMode === 'wg-pool' || ppMode === 'wgpool') {
      ppLabel = 'Mullvad pool'; ppTone = ppActive === 0 ? 'crit' : ppActive < ppSize ? 'warn' : 'ok'
      ppVal = ppActive === 0 ? 'Vše quarantined' : `${ppActive}/${ppSize} aktivní`
    } else if (ppMode === 'rotating-pool') {
      ppLabel = 'Proxy pool'; ppTone = ppActive === 0 ? 'crit' : ppActive < 5 ? 'warn' : 'ok'
      ppVal = `${ppActive}/${ppSize} funkčních`
    } else {
      ppLabel = 'Egress'; ppTone = 'muted'; ppVal = 'Nenakonfigurováno'
    }
  }

  // Self-healing watchdog heartbeat.
  const wdLoading = watchdog == null
  const wdStale = watchdog?.stale === true
  const wdTone = wdLoading ? 'muted' : wdStale ? 'crit' : 'ok'
  const wdAge = watchdog?.last_event_at ? relAge(now - new Date(watchdog.last_event_at).getTime()) : '—'
  const wdVal = wdLoading ? 'Načítám…' : wdStale ? `Tiché · ${wdAge}` : `Aktivní · ${wdAge}`

  // Bounce-guard — mailboxes held after a bounce spike.
  const bhTone = total === 0 ? 'muted' : bounceHold === 0 ? 'ok' : bounceHold < 2 ? 'warn' : 'crit'
  const bhVal = total === 0 ? 'Načítám…' : `${bounceHold}/${total} v hold`

  return (
    <>
      <div className="app-sb-healthbar" data-testid="app-schranky-health">
        <Pill Icon={Globe} label="Anti-trace" value={atVal} tone={atTone} />
        <Pill Icon={Wifi} label={ppLabel} value={ppVal} tone={ppTone} />
        <Pill Icon={Activity} label="Watchdog" value={wdVal} tone={wdTone} />
        <Pill Icon={Shield} label="Bounce guard" value={bhVal} tone={bhTone} />
      </div>
      {unhealthy > 0 ? (
        <div className="app-sb-alert" role="alert" data-testid="app-schranky-unhealthy">
          <ShieldAlert size={14} strokeWidth={1.8} />
          <span><strong>{unhealthy}</strong> {unhealthy === 1 ? 'schránka potřebuje' : 'schránek potřebuje'} pozornost</span>
        </div>
      ) : null}
    </>
  )
}
