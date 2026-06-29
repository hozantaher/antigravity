// Analytika — Crony tab. Folded observability: synthetic-smoke stats, SLO
// burn-rate, hallucination score, daemon heartbeats, status grid + recent
// failures, external diagnostic links. SAME BFF endpoints as v1. The
// /observability route redirects here via ?tab=crony.

import { useMemo } from 'react'
import { CheckCircle2, XCircle, ExternalLink, Clock, AlertTriangle } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { relativeCs } from '../../lib/replyMeta'
import { Card, Pill, fmt, POLL_MS } from './Charts'

// SLO burn-rate — named thresholds, no magic numbers.
const SLO_TARGET = 0.999
const BURN_WINDOW_MS = 7 * 24 * 3600 * 1000
const BURN_PAGE = 14.4, BURN_WARN = 6, BURN_CAUTION = 1
const STATUS_GRID_LIMIT = 60
const RECENT_FAIL_LIMIT = 5

const BURN_TONE = { ok: 'ok', caution: 'warn', warn: 'err', page: 'err' }
const HS_TONE = { green: 'ok', yellow: 'warn', orange: 'err', red: 'err' }
const HS_LABEL = {
  mutation: 'Mutation kill rate', linkage: 'Linkage (1−orphan%)', assertion: 'Assertion density',
  fixtureDrift: 'Fixture reachable', noSignal: 'No-signal absence', flaky: 'Flaky inverse',
}
const CRON_LABEL = {
  runImapPollCron: 'IMAP poll', runWarmupAdvanceCron: 'Warmup advance', runDailyReportCron: 'Daily report',
  runMailboxHealthCycleCron: 'Mailbox health cycle', runCampaignWatchdogCron: 'Campaign watchdog',
  runBounceFlipCron: 'Bounce flip', runMailboxBounceThrottleCron: 'Bounce throttle',
  runMailboxHealingCron: 'Mailbox healing', runSyntheticSmokeCron: 'Synthetic smoke', runGreylistRetryCron: 'Greylist retry',
}

function fmtAge(ms) {
  if (ms == null) return '?'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m} m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

function StatusCell({ ok, title }) {
  return ok
    ? <span className="app-anl-sc app-anl-sc--pass" title={title} data-testid="app-analytika-status-pass"><CheckCircle2 size={14} /></span>
    : <span className="app-anl-sc app-anl-sc--fail" title={title} data-testid="app-analytika-status-fail"><XCircle size={14} /></span>
}

export default function AnalytikaCrony() {
  const syntheticRes = useResource('/api/synthetic-runs?limit=100', { initialData: { runs: [], stats: {} }, pollMs: POLL_MS, pauseHidden: true })
  const invariantsRes = useResource('/api/health/invariants', { initialData: null })
  const tqRes = useResource('/api/health/test-quality', { initialData: null })
  const hbRes = useResource('/api/health/cron-heartbeats', { pollMs: POLL_MS, pauseHidden: true })

  const runs = syntheticRes.data?.runs || []
  const stats = syntheticRes.data?.stats || {}
  const tq = tqRes.data
  const inv = invariantsRes.data
  const hb = hbRes.data

  const burn = useMemo(() => {
    if (runs.length === 0) return null
    const cutoff = Date.now() - BURN_WINDOW_MS
    const win = runs.filter((r) => new Date(r.ran_at).getTime() >= cutoff)
    if (win.length === 0) return null
    const fail = win.filter((r) => r.fail_count > 0).length
    const rate = (fail / win.length) / (1 - SLO_TARGET)
    let severity = 'ok'
    if (rate >= BURN_PAGE) severity = 'page'
    else if (rate >= BURN_WARN) severity = 'warn'
    else if (rate >= BURN_CAUTION) severity = 'caution'
    return { rate: rate.toFixed(2), severity }
  }, [runs])

  const failures = runs.filter((r) => r.fail_count > 0).slice(0, RECENT_FAIL_LIMIT)

  const statCells = [
    { l: 'Spuštění · 100', v: stats.total ?? 0, tone: (stats.fail_runs ?? 0) === 0 ? 'ok' : 'err' },
    { l: 'Pass', v: stats.pass_runs ?? 0, tone: 'ok' },
    { l: 'Fail', v: stats.fail_runs ?? 0, tone: (stats.fail_runs ?? 0) > 0 ? 'err' : null },
    { l: 'Avg duration', v: stats.avg_duration_ms != null ? `${stats.avg_duration_ms} ms` : '—' },
  ]

  return (
    <div className="app-anl-panel app-anl-panel--stack" role="tabpanel" data-testid="app-analytika-panel-crony">
      <div className="app-anl-stats" data-testid="app-analytika-crony-stats">
        {statCells.map((c) => (
          <div className={`app-anl-stat${c.tone ? ' app-anl-stat--' + c.tone : ''}`} key={c.l}>
            <div className="app-anl-stat__n">{c.v}</div>
            <div className="app-anl-stat__l">{c.l}</div>
          </div>
        ))}
      </div>

      <Card title="Hallucination Score" testid="app-analytika-hs"
        tools={tq?.ok ? <Pill tone={HS_TONE[tq.severity] || 'warn'}>{tq.score} / 100</Pill> : null}>
        {!tq?.ok ? (
          <div className="app-anl-msg">Skóre ještě nebylo vygenerováno. Spusť: <code>node scripts/hallucination-score.mjs</code></div>
        ) : (
          <div className="app-anl-hsgrid">
            {Object.entries(tq.components || {}).map(([k, val]) => (
              <div key={k} className="app-anl-hscell">
                <div className="app-anl-hscell__l">{HS_LABEL[k] || k}</div>
                <div className="app-anl-hscell__v">{val.value === null ? '—' : `${val.value} × ${val.weight}`}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {hb?.heartbeats?.length ? (
        <Card title="Daemon heartbeats" testid="app-analytika-heartbeats"
          note={hb.stale_crons?.length ? `${hb.stale_crons.length} stale` : null}>
          <div className="app-anl-hbgrid">
            {hb.heartbeats.map((h) => (
              <div key={h.cron_name} className={`app-anl-hb${h.stale ? ' app-anl-hb--stale' : ''}`} data-testid={`app-analytika-hb-${h.cron_name}`}>
                <Clock size={13} className="app-anl-hb__ico" />
                <div className="app-anl-hb__body">
                  <div className="app-anl-hb__l">{CRON_LABEL[h.cron_name] || h.cron_name}</div>
                  <div className="app-anl-hb__age">
                    {h.last_run_at ? `${fmtAge(h.age_ms)} zpět` : 'nikdy'}
                    {h.stale ? <AlertTriangle size={11} className="app-ico app-anl-warn-ico" /> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {inv?.synthetic ? (
        <Card title="Poslední synthetic-smoke" testid="app-analytika-latest-synthetic">
          <div className="app-anl-fleet">
            Spuštěno před {inv.synthetic_age_min ?? '?'} min
            {inv.stale ? <span className="app-anl-rr--err"> <AlertTriangle size={12} className="app-ico" /> stale</span> : null}
          </div>
        </Card>
      ) : null}

      <Card title="Nástroje pro diagnostiku" testid="app-analytika-links">
        <div className="app-anl-links">
          <a href="https://sentry.io" target="_blank" rel="noopener noreferrer" className="app-anl-link" data-testid="app-analytika-sentry-link">
            <ExternalLink size={13} /> Sentry (chyby + release)
          </a>
          <a href="https://railway.app" target="_blank" rel="noopener noreferrer" className="app-anl-link" data-testid="app-analytika-railway-link">
            <ExternalLink size={13} /> Railway (logy + deploy)
          </a>
        </div>
      </Card>

      <Card title={`Mřížka stavu (posledních ${Math.min(runs.length, STATUS_GRID_LIMIT)})`}
        testid="app-analytika-status-grid"
        tools={burn ? <Pill tone={BURN_TONE[burn.severity] || 'ok'} title="SLO error-budget burn rate">Burn {burn.rate}× ({burn.severity})</Pill> : null}>
        {runs.length === 0 ? (
          <div className={`app-anl-msg${syntheticRes.status === 'error' ? ' app-anl-msg--err' : ''}`}>
            {syntheticRes.status === 'error' ? `Nepodařilo se načíst: ${syntheticRes.error}`
              : syntheticRes.status === 'ok' ? 'Žádná spuštění.' : 'Načítám…'}
          </div>
        ) : (
          <div className="app-anl-grid-cells" data-testid="app-analytika-grid-cells">
            {runs.slice(0, STATUS_GRID_LIMIT).reverse().map((r) => (
              <StatusCell key={r.id} ok={r.fail_count === 0}
                title={`${r.ran_at}: ${r.pass_count}/${(r.pass_count || 0) + (r.fail_count || 0)}`} />
            ))}
          </div>
        )}
      </Card>

      {failures.length > 0 ? (
        <Card title="Poslední selhání" testid="app-analytika-failures">
          <ul className="app-anl-fails">
            {failures.map((r) => (
              <li key={r.id} data-testid={`app-analytika-fail-${r.id}`}>
                <strong>{new Date(r.ran_at).toLocaleString('cs-CZ')}</strong> — {r.fail_count} selhání
                {r.pass_count != null ? <span className="app-anl-muted"> ({r.pass_count} pass)</span> : null}
                <span className="app-anl-muted"> · {relativeCs(r.ran_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}
