import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useResource } from '../../hooks/useResource'
import { relativeCs } from '../lib/replyMeta'
import './app-kvalita.css'

// Kvalita dat — the operator's data-driven TASK LIST (operator 2026-06-01:
// "kvalita dat pro nás bude fungovat jako úkolovník"). Polls /api/data-quality.
// Each open check (count > 0) is a task ranked by urgency, with a one-click
// action where one exists. Tasks AUTO-COMPLETE: when the underlying data is
// fixed the count drops to 0 and the task moves into the collapsed "hotovo"
// footer — no manual checking off. Healthy checks aren't noise but aren't tasks
// either, so they live quietly at the bottom as integrity proof.

const SEV = {
  error: { label: 'Teď hned', dot: 'var(--app-negative)', tone: 'err', weight: 3 },
  warn:  { label: 'K vyřízení', dot: 'var(--app-warning)', tone: 'warn', weight: 2 },
  info:  { label: 'Příležitosti', dot: 'var(--app-accent)', tone: 'info', weight: 1 },
}

// Where each task sends the operator to act. Diagnostic-only checks (dangling
// FKs, ingest-stalled → needs runner logs / SQL, not an in-app surface) have no
// link and read as informational.
const ACTION = {
  hot_leads:             { to: '/odpovedi?mode=hot', label: 'Odpovědět' },
  manual_reply_stuck:    { to: '/odpovedi', label: 'Otevřít odpovědi' },
  pipeline_send_stuck:   { to: '/kampane', label: 'Otevřít kampaně' },
  reply_mime_subject:    { to: '/odpovedi?vse=1', label: 'Projít odpovědi' },
  reply_unclassified:    { to: '/odpovedi?vse=1', label: 'Projít odpovědi' },
  vehicle_sparse_info:   { to: '/vozidla', label: 'Otevřít vozidla' },
  crm_no_ico:            { to: '/crm', label: 'Otevřít CRM' },
  positive_reply_no_vehicle: { to: '/odpovedi?mode=hot', label: 'Zachytit vozidla' },
  positive_reply_no_crm: { to: '/odpovedi?mode=hot', label: 'Projít zájem' },
  hot_reply_phone_unsaved: { to: '/odpovedi?mode=phone', label: 'K zavolání' },
}
const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(n)

// Checks with a safe, deterministic one-click fix (makes the úkolovník resolve
// tasks in place, not just report them). The server applies it + audit-logs.
const FIX = {
  reply_mime_subject: { endpoint: '/api/data-quality/fix/reply-mime-subject', label: 'Opravit' },
}

function FixButton({ cfg, onFixed }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)
  const run = async () => {
    setBusy(true); setErr(false)
    try {
      const r = await fetch(cfg.endpoint, { method: 'POST' })
      if (!r.ok) throw new Error(`fix ${r.status}`)
      await onFixed?.()
    } catch { setErr(true) } finally { setBusy(false) }
  }
  return (
    <button type="button" className="app-dq-check__fix" disabled={busy} onClick={run} data-testid="app-dq-fix">
      {busy ? 'Opravuji…' : err ? 'Zkus znovu' : cfg.label}
    </button>
  )
}

// Hot leads aging past this many days escalate the task to the top "Teď hned"
// tier (relative urgency, not a flat absolute — feedback_relative_not_absolute).
const HOT_LEAD_STALE_DAYS = 7
const daysSince = (iso) => {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000)
}

// Synthesize the hot-lead backlog (unhandled "zájem" replies) as a first-class
// task so the board is the ONE place that answers "co dělat teď" — not just data
// hygiene. Sourced from /api/replies/stats; it's data-derived like every other
// task, and auto-clears when the operator answers the replies.
function hotLeadTask(stats) {
  const n = stats?.hot_unhandled
  if (!n || n <= 0) return null
  const age = daysSince(stats.oldest_hot_unhandled_at)
  const stale = age != null && age >= HOT_LEAD_STALE_DAYS
  return {
    key: 'hot_leads',
    severity: stale ? 'error' : 'warn',
    count: n,
    label: 'Zájemci čekají na odpověď',
    hint: stale
      ? `Lidé, kteří odpověděli se zájmem a ještě jsme jim neodpověděli. Nejstarší čeká ${age} dní — stydne. Odpověz, ať lead nevychladne.`
      : 'Lidé, kteří odpověděli se zájmem a čekají na naši odpověď. Vyřiď je od nejstaršího.',
  }
}

function Task({ c, onFixed }) {
  const action = ACTION[c.key]
  const fix = FIX[c.key]
  return (
    <div className={`app-dq-check app-dq-check--${SEV[c.severity]?.tone || 'info'}`} data-testid="app-dq-check">
      <div className="app-dq-check__count">{fmt(c.count)}</div>
      <div className="app-dq-check__body">
        <div className="app-dq-check__label">{c.label}</div>
        <div className="app-dq-check__hint">{c.hint}</div>
      </div>
      {fix ? <FixButton cfg={fix} onFixed={onFixed} /> : null}
      {action ? <Link to={action.to} className="app-dq-check__action">{action.label} →</Link> : null}
    </div>
  )
}

export default function Kvalita() {
  const dq = useResource('/api/data-quality', { pollMs: 60_000, pauseHidden: true })
  const stats = useResource('/api/replies/stats', { pollMs: 30_000, pauseHidden: true })
  const d = dq.data
  const checks = d?.checks || []

  // Open tasks = data-quality checks with something to do + the synthesized
  // hot-lead backlog, ranked by urgency: severity tier first, then count.
  // Healthy checks (count 0) are done — collapsed below.
  const hot = hotLeadTask(stats.data)
  const tasks = [...(hot ? [hot] : []), ...checks.filter((c) => c.count > 0)]
    .sort((a, b) => (SEV[b.severity]?.weight || 0) - (SEV[a.severity]?.weight || 0) || b.count - a.count)
  const healthy = checks.filter((c) => c.count === 0)
  const order = ['error', 'warn', 'info']
  // Urgency for the hero = error-severity TASKS (incl. the synthesized hot-lead
  // task once it escalates to 'error'), NOT d.errors (which counts only DB
  // checks and misses the hot-lead task) — otherwise the hero understates and
  // contradicts the red "Teď hned" group rendered right below it.
  const urgentCount = tasks.filter((t) => t.severity === 'error').length

  return (
    <div className="app-kvalita" data-testid="app-kvalita">
      <p className="app-kvalita__eyebrow">Hozan · alchymistická laboratoř</p>
      <h1>Kvalita dat.</h1>

      {dq.status === 'error' ? (
        <div className="app-kvalita__hero app-kvalita__hero--err">Kontrolu se nepodařilo načíst.</div>
      ) : dq.status !== 'ok' && !d ? (
        <div className="app-kvalita__hero">Kontroluji…</div>
      ) : (
        <>
          <div className={`app-kvalita__hero ${urgentCount > 0 ? 'app-kvalita__hero--err' : tasks.length > 0 ? 'app-kvalita__hero--warn' : 'app-kvalita__hero--ok'}`} data-testid="app-kvalita-hero">
            <div className="app-kvalita__herobig">
              {tasks.length === 0 ? 'Hotovo — nic nečeká' : `${tasks.length} ${tasks.length < 5 ? 'úkoly' : 'úkolů'} k vyřízení`}
            </div>
            <div className="app-kvalita__herosub">
              {urgentCount > 0 ? `${urgentCount} naléhavých · ` : ''}{`co data říkají, že je potřeba · poslední kontrola ${relativeCs(d?.checked_at)}`}
            </div>
          </div>

          {tasks.length > 0 ? (
            order.map((sev) => {
              const group = tasks.filter((c) => c.severity === sev)
              if (group.length === 0) return null
              return (
                <section className="app-kvalita__group" key={sev}>
                  <div className="app-kvalita__grouphead"><span className="app-dq-dot" style={{ background: SEV[sev].dot }} /> {SEV[sev].label}</div>
                  {group.map((c) => <Task key={c.key} c={c} onFixed={dq.refresh} />)}
                </section>
              )
            })
          ) : (
            <div className="app-kvalita__allclear" data-testid="app-kvalita-allclear">
              Žádné otevřené úkoly. Data jsou v pořádku.
            </div>
          )}

          {healthy.length > 0 ? (
            <details className="app-kvalita__healthy" data-testid="app-kvalita-healthy">
              <summary>{healthy.length} {healthy.length < 5 ? 'kontroly' : 'kontrol'} v pořádku ✓</summary>
              <ul>
                {healthy.map((c) => <li key={c.key}>{c.label}</li>)}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </div>
  )
}
