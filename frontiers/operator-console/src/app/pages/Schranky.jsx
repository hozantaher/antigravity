import { useEffect, useMemo, useRef, useState } from 'react'
import { Inbox, RefreshCw, Search, FilterX } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { relativeCs } from '../lib/replyMeta'
import { useToast } from '../../components/Toast'
import Empty from '../components/Empty'
import HealthBar from '../components/schranky/HealthBar'
import BulkBar from '../components/schranky/BulkBar'
import SchrankaRow from '../components/schranky/SchrankaRow'
import SchrankaDetail from '../components/schranky/SchrankaDetail'
import ConfirmDialog from '../components/schranky/ConfirmDialog'
import AuthLockDialog from '../components/schranky/AuthLockDialog'
import { healthBand, fmtNum } from '../components/schranky/schrankyLib'
import { PHASE_ORDER, PHASE_THRESHOLD_DAYS, resolveEffectiveCap } from '../../lib/lifecyclePhaseCaps'
import './app-schranky.css'

// Schránky (Mailboxes) — clean rebuild of the Mailboxes page on the
// Antique-Alchemist frame against the SAME /api/mailboxes/* BFF endpoints.
// Largest + most safety-critical surface: it fronts anti-trace egress, warmup
// caps, AP6 auth-lock quarantine and bulk pause/resume. Part of the dashboard
// FE unification. Behaviour ported verbatim; safety controls (the
// X-Confirm-Send gate on every state change, the read-only cap display, the
// auth-lock 24h cooldown) are NOT reinterpreted.
//
// HEALTH STREAM — choice: EventSource (mirrors /api/mailboxes/health-stream).
// It is simple (one named `mailbox` event + reconnect backoff), so we replicate
// it as a PUSH channel layered on a 30s /health-summary poll which stays the
// first-paint + reconnect-gap source of truth. SSE failures are swallowed
// (onerror → backoff); no console noise, no stuck state.

const STATUS_FILTERS = [
  { v: '', label: 'Všechny stavy' },
  { v: 'active', label: 'Aktivní' },
  { v: 'paused', label: 'Pozastavené' },
  { v: 'auth_locked', label: 'Zamčené (auth)' },
  { v: 'bounce_hold', label: 'Bounce hold' },
  { v: 'retired', label: 'Vyřazené' },
]
const HEALTH_CHIPS = [
  { k: 'crit', label: 'Poškozené' },
  { k: 'warn', label: 'Rizikové' },
  { k: 'ok', label: 'V pořádku' },
]
const HEALTH_UNHEALTHY_MAX = 50 // score < this counts toward the "needs attention" alert

// Lifecycle phase from mailbox age (days since created_at), mirroring the DB
// advance_lifecycle_phase() schedule (PHASE_THRESHOLD_DAYS). The /api/mailboxes
// list doesn't return lifecycle_phase, but the phase IS defined by
// NOW()-created_at, so we derive it to read the phase-effective daily cap.
function phaseForCreatedAt(createdAt) {
  if (!createdAt) return PHASE_ORDER[0]
  const created = new Date(createdAt).getTime()
  if (Number.isNaN(created)) return PHASE_ORDER[0]
  const days = Math.floor((Date.now() - created) / 86_400_000)
  let phase = PHASE_ORDER[0]
  for (const p of PHASE_ORDER) { if (days >= PHASE_THRESHOLD_DAYS[p]) phase = p }
  return phase
}

export default function Schranky() {
  const toast = useToast()

  const list = useResource('/api/mailboxes')
  const healthSummary = useResource('/api/mailboxes/health-summary', { pollMs: 30_000, pauseHidden: true })
  const antiTraceRes = useResource('/api/anti-trace/health', { pollMs: 60_000 })
  const proxyPool = useResource('/api/proxy-pool', { pollMs: 60_000 })
  const watchdog = useResource('/api/health/watchdog', { pollMs: 30_000 })

  // A failed health fetch is NOT a deliberate "off" state — give it a distinct
  // reason so the HealthBar pill reads as a problem (not the benign "Vypnuto"
  // bucket reserved for not_configured).
  const antiTrace = antiTraceRes.status === 'error' ? { ok: false, reason: 'unknown' } : antiTraceRes.data

  const [liveScores, setLiveScores] = useState({}) // String(id) -> score | null
  const [now, setNow] = useState(Date.now())
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [healthFilter, setHealthFilter] = useState('all')
  const [selected, setSelected] = useState(new Set()) // String(id)
  const [openId, setOpenId] = useState(null)

  // Mutation dialogs (all state changes are confirm-gated + carry X-Confirm-Send).
  const [confirm, setConfirm] = useState(null) // { kind:'bulk'|'single', next, mb?, count? }
  const [confirmReason, setConfirmReason] = useState('')
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [confirmError, setConfirmError] = useState(null)
  const [authlockMb, setAuthlockMb] = useState(null)

  const mailboxes = Array.isArray(list.data) ? list.data : []

  // ── liveScores: seed/refresh from the 30s health-summary poll ──────────────
  useEffect(() => {
    const arr = healthSummary.data?.mailboxes
    if (!Array.isArray(arr)) return
    // Rebuild from the feed (NOT a merge into prev) so ids that have LEFT it —
    // retired / auth_locked are excluded server-side — don't linger as stale
    // "healthy" scores that inflate "potřebuje pozornost" + the band counts.
    setLiveScores(() => {
      const next = {}
      for (const m of arr) next[String(m.id)] = m.score
      return next
    })
  }, [healthSummary.data])

  // ── liveScores: PUSH updates via EventSource (with reconnect backoff) ───────
  useEffect(() => {
    let es = null
    let backoff = 1000
    let cancelled = false
    const open = () => {
      if (cancelled) return
      try { es = new EventSource('/api/mailboxes/health-stream') } catch { return }
      es.addEventListener('mailbox', (ev) => {
        try {
          const m = JSON.parse(ev.data)
          if (!m || m.id == null) return
          setLiveScores((prev) => ({ ...prev, [String(m.id)]: m.score }))
        } catch { /* ignore malformed frame */ }
      })
      es.onopen = () => { backoff = 1000 }
      es.onerror = () => {
        try { es?.close() } catch { /* noop */ }
        es = null
        const wait = Math.min(backoff, 30_000)
        backoff = Math.min(backoff * 2, 30_000)
        if (!cancelled) setTimeout(open, wait)
      }
    }
    open()
    return () => { cancelled = true; try { es?.close() } catch { /* noop */ } }
  }, [])

  // Tick for relative-age labels.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])

  // The selection is filter-scoped: reset it whenever the visible set changes
  // (search / status / health). Otherwise a bulk pause/resume reads the global
  // [...selected] and would act on mailboxes hidden by the current filters.
  useEffect(() => { setSelected(new Set()) }, [search, statusFilter, healthFilter])

  // ── Derived counts + filtering ─────────────────────────────────────────────
  const active = mailboxes.filter((m) => m.status === 'active').length
  const paused = mailboxes.filter((m) => m.status === 'paused').length
  const authLocked = mailboxes.filter((m) => m.status === 'auth_locked').length
  const bounceHold = mailboxes.filter((m) => m.status === 'bounce_hold').length
  // Fleet daily capacity = Σ phase-effective cap of active mailboxes
  // (COALESCE(daily_cap_override, phase_cap); the override may only LOWER the
  // cap, never raise it). Summing daily_limit (= daily_cap_override, null for
  // most) showed ~0 and perversely ROSE when an operator lowered a cap.
  const dailyCap = mailboxes
    .filter((m) => m.status === 'active')
    .reduce((s, m) => s + resolveEffectiveCap(phaseForCreatedAt(m.created_at), m.daily_limit).effective_cap, 0)
  const unhealthy = Object.values(liveScores).filter((s) => s != null && s < HEALTH_UNHEALTHY_MAX).length

  const statusCounts = useMemo(() => {
    const c = {}
    for (const m of mailboxes) c[m.status] = (c[m.status] || 0) + 1
    return c
  }, [mailboxes])
  const bandCounts = useMemo(() => {
    const c = { ok: 0, warn: 0, crit: 0 }
    for (const m of mailboxes) { const b = healthBand(liveScores[String(m.id)]); if (c[b] != null) c[b]++ }
    return c
  }, [mailboxes, liveScores])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return mailboxes.filter((m) => {
      if (q && !`${m.email || ''} ${m.display_name || ''}`.toLowerCase().includes(q)) return false
      if (statusFilter && m.status !== statusFilter) return false
      if (healthFilter !== 'all' && healthBand(liveScores[String(m.id)]) !== healthFilter) return false
      return true
    })
  }, [mailboxes, search, statusFilter, healthFilter, liveScores])

  const hasFilters = !!search || !!statusFilter || healthFilter !== 'all'
  const resetFilters = () => { setSearch(''); setStatusFilter(''); setHealthFilter('all') }

  // ── Selection ──────────────────────────────────────────────────────────────
  const allChecked = filtered.length > 0 && filtered.every((m) => selected.has(String(m.id)))
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(filtered.map((m) => String(m.id))))
  const toggleOne = (id, e) => {
    e?.stopPropagation?.()
    setSelected((prev) => { const n = new Set(prev); const k = String(id); n.has(k) ? n.delete(k) : n.add(k); return n })
  }

  // ── Mutations ───────────────────────────────────────────────────────────────
  const reloadAll = () => { list.refresh?.(); healthSummary.refresh?.() }

  const requestSingleToggle = (mb) => {
    setConfirmReason(''); setConfirmError(null)
    setConfirm({ kind: 'single', mb, next: mb.status === 'active' ? 'paused' : 'active' })
  }
  const requestBulk = (next) => {
    if (selected.size === 0) return
    setConfirmReason(''); setConfirmError(null)
    setConfirm({ kind: 'bulk', next, count: selected.size })
  }

  const runConfirm = async () => {
    if (!confirm) return
    setConfirmBusy(true); setConfirmError(null)
    try {
      if (confirm.kind === 'bulk') {
        const ids = [...selected]
        const endpoint = confirm.next === 'paused' ? '/api/mailboxes/bulk-pause' : '/api/mailboxes/bulk-resume'
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
          body: JSON.stringify({ ids }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d.ok === false) { setConfirmError(d.detail || d.error || `HTTP ${r.status}`); return }
        const cnt = confirm.next === 'paused' ? d.paused : d.resumed
        const skipped = d.skipped > 0 ? ` (${d.skipped} přeskočeno)` : ''
        toast(`${confirm.next === 'paused' ? 'Pozastaveno' : 'Aktivováno'} ${cnt} schránek${skipped}`, 'ok')
        setSelected(new Set())
      } else {
        const mb = confirm.mb
        const reason = confirmReason.trim() || (confirm.next === 'paused' ? 'operator_manual_pause' : '')
        const r = await fetch(`/api/mailboxes/${mb.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
          body: JSON.stringify({ status: confirm.next, reason, confirm: true }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d.ok === false) { setConfirmError(d.error || `HTTP ${r.status}`); return }
        toast(confirm.next === 'paused' ? 'Schránka pozastavena' : 'Schránka aktivována', 'ok')
      }
      setConfirm(null)
      reloadAll()
    } catch (e) {
      setConfirmError(e?.message || 'Síťová chyba')
    } finally {
      setConfirmBusy(false)
    }
  }

  const bulkCheck = async () => {
    const ids = [...selected]
    if (ids.length === 0) return
    try {
      await fetch('/api/mailboxes/bulk-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      toast(`Full-check spuštěn pro ${ids.length} schránek (výsledky za ~10 s)`, 'ok')
      setSelected(new Set())
      ;[3000, 6000, 12000].forEach((ms) => setTimeout(() => healthSummary.refresh?.(), ms))
    } catch {
      toast('Chyba při spuštění full-checku', 'err')
    }
  }

  const openMb = openId ? mailboxes.find((m) => String(m.id) === String(openId)) : null
  const listLoading = (list.status === 'loading' || list.status === 'idle') && mailboxes.length === 0

  // Confirm dialog copy.
  const needReason = confirm?.kind === 'single' && confirm?.next === 'active'
  const confirmTitle = !confirm ? '' :
    confirm.kind === 'bulk'
      ? (confirm.next === 'paused' ? `Pozastavit ${confirm.count} schránek?` : `Aktivovat ${confirm.count} schránek?`)
      : (confirm.next === 'paused' ? 'Pozastavit schránku?' : 'Aktivovat schránku?')
  const confirmBody = !confirm ? null :
    confirm.kind === 'bulk'
      ? (confirm.next === 'paused'
          ? 'Zastaví odesílání z vybraných schránek. Probíhající kampaně z nich přestanou odesílat.'
          : 'Obnoví odesílání z vybraných pozastavených schránek.')
      : <span className="app-sb-mono">{confirm.mb?.email}</span>

  return (
    <div className="app-schranky" data-testid="app-schranky">
      <div className="app-schranky__head">
        <div>
          {/* Title lives in the topbar (<h1>); this keeps only the useful sub. */}
          {list.loadedAt
            ? <span className="app-schranky__sub">Aktualizováno {relativeCs(list.loadedAt)}</span>
            : <span className="app-schranky__sub">Send fleet — egress, warmup capy, auth-lock a hromadné pauzy</span>}
        </div>
        <button type="button" className="app-sb-btn" onClick={reloadAll}
          disabled={list.status === 'loading'} data-testid="app-schranky-refresh" title="Obnovit">
          <RefreshCw size={14} strokeWidth={1.8} /> Obnovit
        </button>
      </div>

      {/* Stat strip */}
      <div className="app-schranky__stats" data-testid="app-schranky-stats">
        {[
          { l: 'Aktivní', v: active, tone: 'ok' },
          { l: 'Pozastavené', v: paused, tone: paused > 0 ? 'warn' : null },
          { l: 'Zamčené (auth)', v: authLocked, tone: authLocked > 0 ? 'err' : null },
          { l: 'Celkem', v: mailboxes.length },
          { l: 'E-mailů/den', v: dailyCap },
        ].map((c) => (
          <div className={`app-sb-stat${c.tone ? ' app-sb-stat--' + c.tone : ''}`} key={c.l}>
            <div className="app-sb-stat__n">{list.status === 'ok' ? fmtNum(c.v) : '—'}</div>
            <div className="app-sb-stat__l">{c.l}</div>
          </div>
        ))}
      </div>

      {/* Anti-trace / egress / watchdog / bounce-guard */}
      <HealthBar
        antiTrace={antiTrace}
        proxyPool={proxyPool.data}
        watchdog={watchdog.data}
        bounceHold={bounceHold}
        total={mailboxes.length}
        unhealthy={unhealthy}
        now={now}
      />

      {/* Filters */}
      <div className="app-schranky__filters" data-testid="app-schranky-filters">
        <div className="app-sb-search">
          <Search size={14} strokeWidth={1.8} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Hledat schránku…"
            aria-label="Hledat schránku"
            data-testid="app-schranky-search"
          />
        </div>
        <select
          className="app-sb-select"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filtrovat podle stavu"
          data-testid="app-schranky-status-filter"
        >
          {STATUS_FILTERS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}{o.v ? ` (${statusCounts[o.v] || 0})` : ` (${mailboxes.length})`}
            </option>
          ))}
        </select>
        <div className="app-sb-chips" role="group" aria-label="Filtrovat podle zdraví">
          {HEALTH_CHIPS.map(({ k, label }) => {
            const count = bandCounts[k] || 0
            if (count === 0) return null
            const isActive = healthFilter === k
            return (
              <button key={k} type="button" className="app-chip-toggle" aria-pressed={isActive}
                data-testid={`app-schranky-health-chip-${k}`}
                onClick={() => setHealthFilter(isActive ? 'all' : k)}>
                {label} · {count}
              </button>
            )
          })}
        </div>
        {hasFilters ? (
          <button type="button" className="app-sb-btn app-sb-btn--ghost" onClick={resetFilters}
            data-testid="app-schranky-reset-filters" title="Zrušit filtry">
            <FilterX size={14} strokeWidth={1.8} /> {filtered.length}/{mailboxes.length}
          </button>
        ) : null}
      </div>

      <BulkBar
        count={selected.size}
        onPause={() => requestBulk('paused')}
        onResume={() => requestBulk('active')}
        onCheck={bulkCheck}
        onClear={() => setSelected(new Set())}
      />

      {/* List — 4-state */}
      {list.status === 'error' ? (
        <div className="app-sb-msg" data-testid="app-schranky-error">
          <div className="app-sb-msg__title">Nepodařilo se načíst schránky</div>
          <div className="app-sb-msg__body">{list.error}</div>
        </div>
      ) : listLoading ? (
        <div className="app-schranky__list" data-testid="app-schranky-loading">
          {[0, 1, 2, 3, 4].map((i) => <div className="app-sb-skel app-sb-skel--row" key={i} />)}
        </div>
      ) : mailboxes.length === 0 ? (
        <Empty icon={Inbox} testid="app-schranky-empty"
          title="Žádné schránky" hint="Nejsou nakonfigurovány žádné odesílací schránky." />
      ) : filtered.length === 0 ? (
        <Empty icon={FilterX} testid="app-schranky-filtered-empty"
          title="Žádné výsledky"
          hint={`Zvoleným filtrům neodpovídá žádná z ${mailboxes.length} schránek.`}
          action={{ label: 'Zrušit filtry', onClick: resetFilters }} />
      ) : (
        <div className="app-schranky__list" data-testid="app-schranky-list">
          {/* Visual column header — plain div (no role="row"; an ARIA row needs a
              table/grid parent, and the clickable rows below are role="button"). */}
          <div className="app-sb-row app-sb-row--head">
            <label className="app-sb-row__check">
              <input type="checkbox" checked={allChecked} onChange={toggleAll}
                aria-label="Vybrat všechny" data-testid="app-schranky-select-all" />
            </label>
            <span className="app-sb-row__identity app-sb-head__cell">Schránka</span>
            <span className="app-sb-head__cell app-sb-head__cell--center">Zdraví</span>
            <span className="app-sb-head__cell">Limit</span>
            <span className="app-sb-head__cell">Delivery</span>
            <span className="app-sb-head__cell" />
          </div>
          {filtered.map((mb) => (
            <SchrankaRow
              key={mb.id}
              mb={mb}
              selected={selected.has(String(mb.id))}
              isOpen={String(openId) === String(mb.id)}
              score={liveScores[String(mb.id)]}
              onToggleSelect={toggleOne}
              onOpen={setOpenId}
              onTogglePause={requestSingleToggle}
            />
          ))}
        </div>
      )}

      {openMb ? (
        <SchrankaDetail
          mb={openMb}
          score={liveScores[String(openMb.id)]}
          onClose={() => setOpenId(null)}
          onRequestPauseResume={requestSingleToggle}
          onRequestClearAuthLock={(mb) => setAuthlockMb(mb)}
        />
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirmTitle}
          body={confirmBody}
          danger={confirm.next === 'paused'}
          confirmLabel={confirm.next === 'paused' ? 'Pozastavit' : 'Aktivovat'}
          busy={confirmBusy}
          error={confirmError}
          reasonLabel={needReason ? 'Důvod aktivace' : null}
          reasonValue={confirmReason}
          onReasonChange={setConfirmReason}
          reasonRequired={needReason}
          onConfirm={runConfirm}
          onCancel={() => { if (!confirmBusy) setConfirm(null) }}
        />
      ) : null}

      {authlockMb ? (
        <AuthLockDialog
          mb={authlockMb}
          toast={toast}
          onClose={() => setAuthlockMb(null)}
          onDone={reloadAll}
        />
      ) : null}
    </div>
  )
}
