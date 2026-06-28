import { useMemo, useState } from 'react'
import {
  ShieldCheck, ShieldAlert, ShieldX, ShieldOff,
  RefreshCw, PlayCircle, AlertTriangle,
} from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import { relativeCs } from '../lib/replyMeta'
import Empty from '../components/Empty'
import './app-anonymita.css'

// Diagnostika anonymity — operator anonymity probe matrix on the Claude
// frame. One row per active mailbox, two probes per row (anonymita +
// human-like), each a status chip: připraveno / drobné nedostatky /
// nepřipraveno / netestováno. A 30s poll keeps the matrix live; "Spustit test"
// fires the slow 4-binary probe chain and surfaces the result via a toast.
// Clean rebuild of the DiagnostikaAnonymita page against the SAME BFF
// endpoints (GET /api/anonymity/all + POST /api/anonymity/run). Part of the
// dashboard FE unification.

// Poll cadence — matches POLL_INTERVAL_MS (30s). Probes take ~10 min, so a
// calm 30s refresh surfaces fresh scores without hammering the BFF.
const POLL_MS = 30_000

// Critical-score threshold — a mailbox below this on either probe is surfaced
// in the alert banner as "fix before sending" (mirrors ALERT_THRESHOLD).
// Named constant, not a magic number (feedback_no_magic_thresholds).
const ALERT_THRESHOLD = 40

// Score → readiness tier. Thresholds mirror badgeColor() + the server's
// recommendation(): >=85 ready · >=70 minor · <70 not ready · null untested.
function tierFor(score) {
  if (score === null || score === undefined) return 'pending'
  if (score >= 85) return 'ok'
  if (score >= 70) return 'warn'
  return 'fail'
}

// Tier presentation — chip tone (semantic --app-* token) + icon + Czech label.
// ok=positive · warn=warning · fail=negative · pending=muted (per spec).
const TIER = {
  ok:      { label: 'Připraveno', tone: 'ok', Icon: ShieldCheck },
  warn:    { label: 'Drobné nedostatky', tone: 'warn', Icon: ShieldAlert },
  fail:    { label: 'Nepřipraveno', tone: 'fail', Icon: ShieldX },
  pending: { label: 'Netestováno', tone: 'pending', Icon: ShieldOff },
}

// Worst of the two probe tiers — drives per-mailbox overall + the stat counts.
// `pending` (untested) ranks BELOW `fail` so a failing+untested mailbox buckets
// as the real problem (Nepřipraveno), not the benign "Netestováno".
const TIER_RANK = { ok: 0, warn: 1, pending: 2, fail: 3 }
function overallTier(anonScore, humanScore) {
  const a = tierFor(anonScore)
  const h = tierFor(humanScore)
  return TIER_RANK[a] >= TIER_RANK[h] ? a : h
}

// A mailbox is critical when either probe average sits below ALERT_THRESHOLD.
function isCriticalMb(mb) {
  const a = mb.anonymity?.avg_score
  const h = mb.humanlike?.avg_score
  return (a != null && a < ALERT_THRESHOLD) || (h != null && h < ALERT_THRESHOLD)
}

function ProbeChip({ score }) {
  const t = TIER[tierFor(score)]
  const Icon = t.Icon
  return (
    <span className={`app-achip app-achip--${t.tone}`} title={t.label} data-tier={t.tone}>
      <Icon size={13} strokeWidth={1.9} />
      <span className="app-achip__n">{score === null || score === undefined ? '—' : score}</span>
    </span>
  )
}

export default function Anonymita() {
  const toast = useToast()
  const feed = useResource('/api/anonymity/all', { pollMs: POLL_MS, pauseHidden: true })
  const [running, setRunning] = useState(false)

  const mailboxes = feed.data?.mailboxes || []

  const stats = useMemo(() => {
    const s = { total: mailboxes.length, ok: 0, warn: 0, fail: 0, pending: 0 }
    for (const mb of mailboxes) {
      s[overallTier(mb.anonymity?.avg_score ?? null, mb.humanlike?.avg_score ?? null)]++
    }
    return s
  }, [mailboxes])

  const critical = useMemo(() => mailboxes.filter(isCriticalMb), [mailboxes])

  const runTest = async () => {
    if (running) return
    setRunning(true)
    try {
      const r = await fetch('/api/anonymity/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
      })
      const body = await r.json().catch(() => ({}))
      if (r.status === 429) {
        // Rate-limited (1 run/hour, server-side guard) — calm info, not an error.
        toast(body.message || 'Test byl spuštěn nedávno. Zkus to za chvíli.', 'info')
        return
      }
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`)
      toast('Test spuštěn — výsledky se načtou automaticky (~10 min).', 'ok')
      feed.refresh?.()
    } catch (e) {
      toast(`Chyba: ${e.message || 'zkus to znovu'}`, 'err')
    } finally {
      setRunning(false)
    }
  }

  const statCells = [
    { l: 'Schránky', v: stats.total },
    { l: 'Připraveno', v: stats.ok, tone: stats.ok > 0 ? 'ok' : null },
    { l: 'Nedostatky', v: stats.warn, tone: stats.warn > 0 ? 'warn' : null },
    { l: 'Nepřipraveno', v: stats.fail, tone: stats.fail > 0 ? 'err' : null },
    { l: 'Netestováno', v: stats.pending },
  ]

  return (
    <div className="app-anonymita" data-testid="app-anonymita">
      <div className="app-anonymita__head">
        <div>
          <h1 className="app-anonymita__title">Diagnostika anonymity</h1>
          {feed.loadedAt ? (
            <span className="app-anonymita__sub">Aktualizováno {relativeCs(feed.loadedAt)}</span>
          ) : null}
        </div>
        <div className="app-anonymita__actions">
          <button type="button" className="app-anonymita__btn" onClick={() => feed.refresh?.()}
            disabled={feed.status === 'loading'} data-testid="app-anonymita-refresh" title="Obnovit">
            <RefreshCw size={15} /> Obnovit
          </button>
          <button type="button" className="app-anonymita__btn app-anonymita__btn--primary" onClick={runTest}
            disabled={running} data-testid="app-anonymita-run">
            <PlayCircle size={15} /> {running ? 'Spouštím…' : 'Spustit test'}
          </button>
        </div>
      </div>

      <div className="app-anonymita__stats" data-testid="app-anonymita-stats">
        {statCells.map((c) => (
          <div className={`app-astat${c.tone ? ' app-astat--' + c.tone : ''}`} key={c.l}>
            <div className="app-astat__n">{feed.status === 'ok' ? c.v : '—'}</div>
            <div className="app-astat__l">{c.l}</div>
          </div>
        ))}
      </div>

      {critical.length > 0 ? (
        <div className="app-anonymita__alert" data-testid="app-anonymita-alert" role="alert">
          <AlertTriangle size={15} strokeWidth={1.9} />
          <div>
            <strong>Kritické skóre anonymity</strong> — {critical.length}{' '}
            {critical.length === 1 ? 'schránka' : critical.length < 5 ? 'schránky' : 'schránek'}{' '}
            pod prahem {ALERT_THRESHOLD}. Před odesláním kampaní je nutné je opravit:{' '}
            {critical.map((mb) => mb.email).join(', ')}.
          </div>
        </div>
      ) : null}

      {feed.status === 'error' ? (
        <div className="app-empty" data-testid="app-anonymita-error">
          <div className="app-empty__title">Nepodařilo se načíst</div>
          <div>{feed.error}</div>
        </div>
      ) : (feed.status === 'loading' || feed.status === 'idle') && mailboxes.length === 0 ? (
        <div className="app-anonymita__rows">{[0, 1, 2].map((i) => <div className="app-skel-row" key={i} />)}</div>
      ) : mailboxes.length === 0 ? (
        <Empty icon={ShieldOff} testid="app-anonymita-empty"
          title="Žádné aktivní schránky"
          hint="Aktivuj schránky a spusť test pro změření anonymity a lidskosti odesílaných zpráv." />
      ) : (
        <div className="app-anonymita__matrix" data-testid="app-anonymita-matrix"
          role="table" aria-label="Matice anonymity schránek">
          <div className="app-amx__head" role="row">
            <span role="columnheader">Schránka</span>
            <span role="columnheader">Anonymita</span>
            <span role="columnheader">Human-like</span>
            <span role="columnheader">Posledně</span>
          </div>
          {mailboxes.map((mb) => {
            const crit = isCriticalMb(mb)
            return (
              <div key={mb.mailbox_id} className={`app-amx__row${crit ? ' app-amx__row--crit' : ''}`}
                role="row" data-testid="app-anonymita-row" data-critical={crit ? 'true' : undefined}>
                <span className="app-amx__mb" role="cell" title={mb.email}>
                  {crit ? <AlertTriangle size={12} className="app-amx__crit" strokeWidth={2} /> : null}
                  {mb.email}
                </span>
                <span role="cell"><ProbeChip score={mb.anonymity?.avg_score ?? null} /></span>
                <span role="cell"><ProbeChip score={mb.humanlike?.avg_score ?? null} /></span>
                <span className="app-amx__when" role="cell">
                  {mb.last_run_at ? relativeCs(mb.last_run_at) : '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
