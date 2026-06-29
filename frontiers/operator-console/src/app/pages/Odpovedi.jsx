import { useState, useEffect, useRef, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Phone, Clock, Flame, Truck, Star, Check, Archive, User, Inbox, Mails, Search, X, ArrowUp, Loader2, Share2, Forward } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useInfiniteReplies, REPLIES_PAGE_SIZE } from '../../hooks/useInfiniteReplies'
import { useEventStream } from '../../hooks/useEventStream'
import { useToast } from '../../components/Toast'
import { classificationMeta, relativeCs, displayName, decodeMimeWords } from '../lib/replyMeta'
import { useReplyBulk } from '../components/odpovedi/useReplyBulk'
import ReplyBulkBar from '../components/odpovedi/ReplyBulkBar'
import ReplyForwardDialog from '../components/odpovedi/ReplyForwardDialog'
import ForwardComposer from '../components/odpovedi/ForwardComposer'
import ReplyConfirmDialog from '../components/odpovedi/ReplyConfirmDialog'
import ActionRail from './ActionRail'
import ChatThread from './ChatThread'
import AttachmentStrip from './AttachmentStrip'
import ReplyComposer from './ReplyComposer'
import ClassificationControl from './ClassificationControl'
import VehicleCapturePanel from './VehicleCapturePanel'
import FactsRow from './FactsRow'
import './app-odpovedi-base.css' // shared .app-actionrail/.app-tag/.app-row/composer classes
import './app-odpovedi.css'

// Odpovědi — single-screen reply triage, restructured (2026-06-24) into a
// full three-pane email client: folder/account rail · list · reading pane.
//
//   - PANE 1 (folder rail): the old 4 filter chips became vertical folders,
//     plus Označené (flagged) + Vyřízené (handled). Live counts from /stats.
//   - PANE 2 (list): fulltext search ('/' focuses) over /api/replies?q=, INFINITE
//     scroll (offset paging via useInfiniteReplies), real-time "new replies" pill
//     fed by /api/replies/stream — no scroll-yank. Optimistic flag/handle flips.
//   - PANE 3 (reading): compact header → ActionRail (phone = hero) → merged Fakta
//     strip → AI disclosure → ChatThread → sticky composer (with attachments).
//
// Keyboard triage loop: j/k move · c call · r reply · e archive+advance · / search.
// Reuses the working components verbatim (ActionRail / ChatThread /
// ReplyComposer / ClassificationControl / AttachmentStrip / VehicleCapturePanel /
// FactsRow) + the existing BFF /api/replies surface. No backend change.

// No magic numbers (feedback_no_magic_thresholds T0):
const MIN_QUERY = 3            // mirror backend GET /api/replies (q.length >= 3)
const SEARCH_DEBOUNCE_MS = 250
const TOAST_MS = 4200
// Stable array identity so useEventStream doesn't re-subscribe each render.
const REPLY_STREAM_EVENTS = ['reply_inserted']

// Folder set. Each maps to the SAME /api/replies query params Odpovedi uses so
// the BFF contract is unchanged. count(stats) returns a live badge number, or
// null when the stats endpoint exposes none (flagged/handled have no counter —
// we do NOT fabricate one; feedback_no_fabricated_test_data).
const FOLDERS = [
  { key: 'unhandled', label: 'Nevyřízené', Icon: Inbox, count: (s) => s?.unhandled ?? s?.nezpracovane ?? null },
  { key: 'hot',       label: 'Zájem',      Icon: Flame, count: (s) => s?.hot_unhandled ?? null },
  { key: 'phone',     label: 'Volat',      Icon: Phone, count: (s) => s?.phone_unhandled ?? null },
  { key: 'flagged',   label: 'Označené',   Icon: Star,  count: () => null },
  { key: 'handled',   label: 'Vyřízené',   Icon: Check, count: () => null },
  { key: 'all',       label: 'Vše',        Icon: Mails, count: (s) => s?.total ?? null },
]
const FOLDER_KEYS = FOLDERS.map((f) => f.key)

// Mode → /api/replies query. Now offset/limit-aware (infinite scroll) and
// q-aware (fulltext). Kept exported so owns its query shape.
export function listUrlFor(mode, { q = '', limit = REPLIES_PAGE_SIZE, offset = 0 } = {}) {
  const p = new URLSearchParams()
  p.set('limit', String(limit))
  p.set('offset', String(offset))
  if (mode === 'hot') { p.set('handled', 'false'); p.set('classification', 'positive'); p.set('sort', 'received'); p.set('dir', 'asc') }
  else if (mode === 'phone') { p.set('handled', 'false'); p.set('has_phone', 'true'); p.set('sort', 'received'); p.set('dir', 'asc') }
  else if (mode === 'flagged') { p.set('flagged', 'true'); p.set('sort', 'received'); p.set('dir', 'desc') }
  else if (mode === 'handled') { p.set('handled', 'true'); p.set('sort', 'received'); p.set('dir', 'desc') }
  else if (mode === 'all') { /* no extra filter */ }
  else { p.set('handled', 'false') } // unhandled (default)
  const qq = (q || '').trim()
  if (qq.length >= MIN_QUERY) p.set('q', qq)
  return `/api/replies?${p.toString()}`
}

function useDebounced(value, ms) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function Tag({ classification }) {
  const m = classificationMeta(classification)
  return <span className="app-tag" style={{ color: m.fg, background: m.bg }}>{m.label}</span>
}

function snippetOf(reply) {
  const raw = reply.body_text_preview || reply.body_preview || ''
  return String(raw).replace(/\s+/g, ' ').trim()
}

function ReplyRow({ reply, active, onOpen, selected, onToggleSelect }) {
  const snippet = snippetOf(reply)
  const phone = reply.mined?.phones?.[0]
  // The row is a <button> (opens the conversation), so the bulk-select checkbox
  // is a SIBLING inside a wrapper — never nested in the button (invalid HTML +
  // would swallow row clicks). Reuses .app-row-wrap/.app-row__check (app-odpovedi.css).
  return (
    <div className={`app-row-wrap${selected ? ' app-row-wrap--selected' : ''}`}>
      <input
        type="checkbox"
        className="app-row__check"
        checked={selected}
        onChange={() => onToggleSelect(reply.id)}
        aria-label={`Vybrat odpověď od ${displayName(reply)}`}
        data-testid="app-reply-select"
      />
      <button
        type="button"
        className={`app-row app-row${reply.handled ? '' : ' app-row--unread'}${active ? ' app-row--active' : ''}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => onOpen(reply.id)}
        data-testid="app-reply-row"
      >
      <div className="app-row__top">
        {reply.flagged ? <span className="app-row__star" title="Označeno" aria-label="Označeno"><Star size={13} fill="currentColor" /></span> : null}
        <span className={`app-row__name${reply.handled ? '' : ' app-row__name--unread'}`}>{displayName(reply)}</span>
        <span className="app-row__time">{relativeCs(reply.received_at)}</span>
      </div>
      <div className="app-row__subj">{decodeMimeWords(reply.subject) || '(bez předmětu)'}</div>
      {snippet ? <div className="app-row__snippet" data-testid="app-row-snippet">{snippet}</div> : null}
      <div className="app-row__tags">
        <Tag classification={reply.classification} />
        {phone ? <span className="app-tag app-tag--phone" title={`Telefon: ${phone.display}`}><Phone size={12} className="app-ico" aria-hidden="true" /> {phone.display}</span> : null}
        {reply.mined?.callback ? <span className="app-tag app-tag--call" title="Chce zavolat" aria-label="Chce zavolat"><Clock size={12} /></span> : null}
        {reply.mined?.urgent ? <span className="app-tag app-tag--urgent" title="Spěchá" aria-label="Spěchá"><Flame size={12} /></span> : null}
        {reply.has_vehicle ? <span className="app-tag app-tag--veh" title="Už má zachycené vozidlo" aria-label="Už má zachycené vozidlo"><Truck size={12} /></span> : null}
      </div>
      </button>
    </div>
  )
}

// AI classification disclosure — collapsed by default (matched replies only).
function AiDisclosure({ reply, onReclassified }) {
  if (!reply?.id || reply.id < 0) return null
  const pc = reply.pre_classification
  const hasVerdict = pc && typeof pc.confidence === 'number'
  const pct = hasVerdict ? Math.round(pc.confidence * 100) : null
  const intentLabel = hasVerdict ? classificationMeta(pc.intent).label : null
  return (
    <details className="app-ai" data-testid="app-ai-disclosure">
      <summary className="app-ai__summary">
        <span>Klasifikace{intentLabel ? <> · AI: <strong>{intentLabel}</strong></> : null}</span>
        {pct != null ? <span className="app-ai__conf">{pct} %</span> : null}
      </summary>
      <div className="app-ai__body">
        <ClassificationControl reply={reply} onReclassified={onReclassified} />
      </div>
    </details>
  )
}

// PANE 1 — folder / account rail. Keeps role=tab + data-testid="app-chip-<key>"
// for the original 4 keys (smoke contract) while adding flagged + handled.
function FolderRail({ mode, stats, onSelect }) {
  return (
    <nav className="app-folders" aria-label="Složky odpovědí">
      {/* Folder-rail title removed — the topbar <h1> already names the surface (S2). */}
      <div className="app-folders__list" role="tablist" aria-orientation="vertical" aria-label="Filtr odpovědí">
        {FOLDERS.map((f) => {
          const n = f.count(stats)
          const on = mode === f.key
          const Icon = f.Icon
          return (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={on}
              aria-current={on ? 'page' : undefined}
              className={`app-folder${on ? ' app-folder--on' : ''}`}
              onClick={() => onSelect(f.key)}
              data-testid={`app-chip-${f.key}`}
            >
              <span className="app-folder__ico" aria-hidden="true"><Icon size={16} /></span>
              <span className="app-folder__label">{f.label}</span>
              {n != null ? <span className="app-folder__count">{n}</span> : null}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function SearchBox({ value, onChange, inputRef }) {
  return (
    <div className="app-search" data-testid="app-search">
      <span className="app-search__ico" aria-hidden="true"><Search size={15} /></span>
      <input
        ref={inputRef}
        type="search"
        className="app-search__input"
        placeholder="Hledat jméno nebo předmět…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Hledat v odpovědích"
        data-testid="app-search-input"
      />
      {value ? (
        <button type="button" className="app-search__clear" onClick={() => onChange('')} aria-label="Vymazat hledání" data-testid="app-search-clear">
          <X size={14} />
        </button>
      ) : null}
    </div>
  )
}

function ConversationPane({ activeId, detail, patch, onFlag, onArchive, onSent, onReclassified, onForwardCrm }) {
  const [vehOpen, setVehOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [threadNonce, setThreadNonce] = useState(0)
  const [fwdOpen, setFwdOpen] = useState(false)
  const composerRef = useRef(null)

  const focusComposer = () => {
    const el = composerRef.current?.querySelector('[data-testid="app-compose-text"]')
    if (el) el.focus()
  }
  const doArchive = async (id) => {
    setArchiving(true)
    try { await onArchive(id) } finally { setArchiving(false) }
  }
  // Bump the thread so the operator's own freshly-sent reply appears at once
  // (otherwise it waits for ChatThread's 15s poll).
  const handleSent = () => { setThreadNonce((n) => n + 1); onSent?.() }

  if (!activeId) {
    return (
      <div className="app-empty" data-testid="app-pane-empty">
        <div className="app-empty__title">Vyber odpověď</div>
        <div>Zvol konverzaci vlevo — jeden lead, jedno rozhodnutí.</div>
      </div>
    )
  }
  if (detail.status === 'error') {
    const notFound = /(^|\D)404(\D|$)/.test(detail.error || '')
    return (
      <div className="app-empty">
        <div className="app-empty__title">{notFound ? 'Odpověď nenalezena' : 'Nepodařilo se načíst'}</div>
        <div>{notFound ? 'Tato odpověď už neexistuje.' : (detail.error || 'Zkus to prosím znovu.')}</div>
      </div>
    )
  }
  // Gate on identity, not just status: useResource keeps the previous reply's
  // data while the next loads, so without the id match the pane would render
  // reply A under selected reply B.
  if (detail.status !== 'ok' || String(detail.data?.reply?.id) !== String(activeId)) {
    return <div className="app-empty"><div className="app-empty__title">Načítám…</div></div>
  }

  const base = detail.data.reply
  const r = patch ? { ...base, ...patch } : base
  const who = displayName(r)

  return (
    <div className="app-pane" data-testid="app-pane-detail">
      <header className="app-head">
        <div className="app-head__title">
          <h2 className="app-head__name">{who}</h2>
          <span className="app-head__subject">{decodeMimeWords(r.subject) || '(bez předmětu)'}</span>
        </div>
        <div className="app-head__meta">
          <Tag classification={r.classification} />
          <span className="app-head__time">{relativeCs(r.received_at)}</span>
          <button
            type="button"
            className={`app-flag-btn${r.flagged ? ' app-flag-btn--on' : ''}`}
            onClick={() => onFlag(r.id, !r.flagged)}
            aria-pressed={r.flagged ? 'true' : 'false'}
            data-testid="app-flag"
            title={r.flagged ? 'Odznačit' : 'Označit hvězdičkou'}
          >
            <Star size={15} fill={r.flagged ? 'currentColor' : 'none'} />
          </button>
          {r.handled ? (
            <span className="app-handled" data-testid="app-handled"><Check size={14} className="app-ico" aria-hidden="true" /> Vyřízeno</span>
          ) : (
            <button type="button" className="app-archive" disabled={archiving}
              onClick={() => doArchive(r.id)} data-testid="app-archive-btn">
              {archiving ? 'Archivuji…' : <><Archive size={14} className="app-ico" aria-hidden="true" /> Vyřídit</>}
            </button>
          )}
          <button
            type="button"
            className="app-crm-btn"
            onClick={() => onForwardCrm?.(r.id)}
            data-testid="app-detail-crm"
            title="Předat do CRM (white-label handoff)"
          >
            <Share2 size={14} className="app-ico" aria-hidden="true" /> Do CRM
          </button>
          <button
            type="button"
            className="app-crm-btn"
            onClick={() => setFwdOpen(true)}
            data-testid="app-detail-forward"
            title="Přeposlat e-mail na jinou adresu (přes relay)"
          >
            <Forward size={14} className="app-ico" aria-hidden="true" /> Přeposlat
          </button>
          {r.contact_id ? (
            <Link to={`/kontakty?id=${r.contact_id}`} className="app-contact-link" data-testid="app-contact-link" title="Otevřít kontakt" aria-label="Otevřít kontakt"><User size={15} /></Link>
          ) : null}
        </div>
      </header>

      <ActionRail reply={r} onReply={focusComposer} />
      <FactsRow reply={r} />
      <AiDisclosure reply={r} onReclassified={onReclassified} />

      <div className="app-thread" data-testid="app-thread">
        <ChatThread replyId={r.id} nonce={threadNonce} />
        <AttachmentStrip replyId={r.id} />
        <VehicleCapturePanel reply={r} open={vehOpen} />
      </div>

      <footer className="app-composer" ref={composerRef} data-testid="app-composer">
        <ReplyComposer
          reply={r}
          onSent={handleSent}
          onToggleVehicle={() => setVehOpen((o) => !o)}
          vehicleOpen={vehOpen}
        />
      </footer>

      <ForwardComposer
        reply={r}
        open={fwdOpen}
        onClose={() => setFwdOpen(false)}
      />
    </div>
  )
}

export default function Odpovedi() {
  const [params, setParams] = useSearchParams()
  const mode = FOLDER_KEYS.includes(params.get('mode')) ? params.get('mode') : 'unhandled'
  const activeId = params.get('id')

  const [qInput, setQInput] = useState('')
  const qDebounced = useDebounced(qInput, SEARCH_DEBOUNCE_MS)
  const effectiveQ = qDebounced.trim().length >= MIN_QUERY ? qDebounced.trim() : ''

  const stats = useResource('/api/replies/stats', { pollMs: 30_000, pauseHidden: true })
  const detail = useResource(activeId ? `/api/replies/${activeId}` : null, { enabled: !!activeId, silentStatuses: [] })

  const urlForOffset = useCallback(
    (offset) => listUrlFor(mode, { q: effectiveQ, limit: REPLIES_PAGE_SIZE, offset }),
    [mode, effectiveQ],
  )
  const listKey = `${mode}::${effectiveQ}`
  const list = useInfiniteReplies(urlForOffset, { key: listKey })
  const rows = list.rows

  // Optimistic overlay for the OPEN reply's flag/handled, keyed by id so the
  // pane header flips instantly alongside the list row.
  const [detailPatch, setDetailPatch] = useState({})
  const [toast, setToast] = useState(null)
  const [hasNew, setHasNew] = useState(false)

  const rowsRef = useRef(null)
  const sentinelRef = useRef(null)
  const searchRef = useRef(null)

  const showToast = useCallback((text, kind = 'err') => {
    setToast({ text, kind })
    setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  // Light reconcile: refresh counts + the open reply, but NOT the whole list
  // (that would reset infinite scroll). The optimistic patch already moved the UI.
  const reconcile = useCallback(() => { stats.refresh?.(); detail.refresh?.() }, [stats, detail])

  // ── Bulk triage (feature parity with pages/Replies.jsx) ─────────────────
  // A completed batch refetches the list from the top (handled rows drop out of
  // the unhandled/hot/phone folders) + refreshes the counts + the open reply.
  // Undo (POST /api/replies/bulk-revert) rides the global toast's secondaryAction.
  const notify = useToast()
  const onBulkChanged = useCallback(() => { list.refresh(); stats.refresh?.(); detail.refresh?.() }, [list, stats, detail])
  const bulk = useReplyBulk({ rows, resetKey: listKey, toast: notify, onChanged: onBulkChanged })
  // Forward-to-CRM dialog target: null | { ids:number[], clearAfter:bool }.
  // clearAfter=true for the bulk selection, false for a single open reply.
  const [forwardState, setForwardState] = useState(null)
  const [hideOpen, setHideOpen] = useState(false)
  const openBulkForward = () => setForwardState({ ids: Array.from(bulk.selectedIds).map(Number), clearAfter: true })
  const openSingleForward = (id) => setForwardState({ ids: [Number(id)], clearAfter: false })
  const confirmForward = async ({ notes, crm_url }) => {
    const st = forwardState
    if (!st) return
    await bulk.forwardCrm({ ids: st.ids, notes, crm_url, clearAfter: st.clearAfter })
    setForwardState(null)
  }
  const confirmHide = async () => { await bulk.hide(); setHideOpen(false) }

  const patchBoth = useCallback((id, patch) => {
    list.patchRow(id, patch)
    setDetailPatch((p) => ({ ...p, [id]: { ...(p[id] || {}), ...patch } }))
  }, [list])

  const optimisticFlag = useCallback(async (id, next) => {
    patchBoth(id, { flagged: next })
    try {
      const r = await fetch(`/api/replies/${id}/flag`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flagged: next }),
      })
      if (!r.ok) throw new Error(String(r.status))
      reconcile()
    } catch {
      patchBoth(id, { flagged: !next })
      showToast('Nepodařilo se uložit hvězdičku')
    }
  }, [patchBoth, reconcile, showToast])

  const optimisticArchive = useCallback(async (id) => {
    patchBoth(id, { handled: true })
    try {
      const r = await fetch(`/api/replies/${id}/handled`, { method: 'PATCH' })
      if (!r.ok) throw new Error(String(r.status))
      reconcile()
      return true
    } catch {
      patchBoth(id, { handled: false })
      showToast('Nepodařilo se vyřídit odpověď')
      return false
    }
  }, [patchBoth, reconcile, showToast])

  // After a reply is SENT the backend marks the row handled — reflect it at once.
  const onComposerSent = useCallback(() => {
    if (activeId) patchBoth(activeId, { handled: true })
    reconcile()
  }, [activeId, patchBoth, reconcile])

  const open = (id, { replace = false } = {}) => {
    const next = new URLSearchParams(params)
    next.set('id', String(id))
    setParams(next, { replace })
  }
  const setMode = (m) => {
    const next = new URLSearchParams(params)
    if (m === 'unhandled') next.delete('mode'); else next.set('mode', m)
    setParams(next, { replace: true })
  }

  // Real-time: a new inbound reply → show a non-disruptive pill + refresh counts.
  useEventStream('/api/replies/stream', {
    events: REPLY_STREAM_EVENTS,
    onEvent: () => { setHasNew(true); stats.refresh?.() },
  })
  const showNew = () => {
    setHasNew(false)
    list.refresh()
    if (rowsRef.current) rowsRef.current.scrollTop = 0
  }

  // Auto-open the first reply on initial load so the reading pane is never a
  // blank void (email-client convention). Once only — the operator's later
  // navigation owns the selection from there.
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current || activeId || rows.length === 0) return
    autoSelectedRef.current = true
    open(rows[0].id, { replace: true })
  }, [activeId, rows]) // eslint-disable-line react-hooks/exhaustive-deps

  // Infinite scroll — observe a sentinel at the bottom of the rows scroll area.
  // list.loadMore is referentially stable; re-run when rows first appear so the
  // observer attaches to the freshly-rendered sentinel.
  const hasRows = rows.length > 0
  useEffect(() => {
    const el = sentinelRef.current
    const root = rowsRef.current
    if (!el || !root) return undefined
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) list.loadMore()
    }, { root, rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [list.loadMore, hasRows])

  // Keyboard triage loop. Handler lives in a ref refreshed every render so it
  // always reads the latest rows/activeId/params (listener binds once).
  const onKeyRef = useRef(null)
  onKeyRef.current = (e) => {
    const t = e.target
    const tag = (t?.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) {
      if (e.key === 'Escape') t.blur()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return }
    const ids = rows.map((r) => String(r.id))
    if (!ids.length && e.key !== 'r') return
    const idx = ids.indexOf(activeId)
    const focusComposer = () => {
      const el = document.querySelector('[data-testid="app-compose-text"]')
      if (el) el.focus()
    }
    if (e.key === 'j') {
      e.preventDefault(); open(idx < 0 ? ids[0] : ids[Math.min(idx + 1, ids.length - 1)], { replace: true })
    } else if (e.key === 'k') {
      e.preventDefault(); open(idx <= 0 ? ids[0] : ids[idx - 1], { replace: true })
    } else if (e.key === 'r' && activeId) {
      e.preventDefault(); focusComposer()
    } else if (e.key === 'c' && activeId) {
      e.preventDefault()
      const call = document.querySelector('[data-testid="app-actionrail-call"]')
      if (call instanceof HTMLAnchorElement) call.click()
    } else if (e.key === 'e' && activeId) {
      e.preventDefault()
      const nextId = idx >= 0 ? (ids[idx + 1] || ids[idx - 1] || null) : null
      optimisticArchive(activeId).then((ok) => { if (ok && nextId) open(nextId, { replace: true }) })
    }
  }
  useEffect(() => {
    const handler = (e) => onKeyRef.current?.(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const emptyCopy = mode === 'hot'
    ? { title: 'Žádný čekající zájem', hint: 'Všechny hot leady vyřízené.' }
    : mode === 'phone'
      ? { title: 'Nikdo k zavolání', hint: 'Žádné nevyřízené s telefonem.' }
      : mode === 'flagged'
        ? { title: 'Nic označeného', hint: 'Hvězdičkou si označíš, k čemu se vrátit.' }
        : mode === 'handled'
          ? { title: 'Zatím nic vyřízeného', hint: 'Vyřízené odpovědi se objeví tady.' }
          : mode === 'all'
            ? { title: 'Žádné odpovědi', hint: 'Zatím tu nic není.' }
            : { title: 'Vše vyřízeno', hint: 'Žádné nevyřízené odpovědi — klid.' }

  return (
    <div className="app-odpovedi" data-testid="app-odpovedi">
      <FolderRail mode={mode} stats={stats.data} onSelect={setMode} />

      <aside className="app-list" aria-label="Seznam odpovědí">
        <div className="app-list__head">
          <SearchBox value={qInput} onChange={setQInput} inputRef={searchRef} />
        </div>
        <div className="app-kbd-hint" data-testid="app-kbd-hint">
          <kbd>j</kbd><kbd>k</kbd> pohyb · <kbd>c</kbd> volat · <kbd>r</kbd> odpověď · <kbd>e</kbd> hotovo · <kbd>/</kbd> hledat
        </div>
        <ReplyBulkBar
          total={rows.length}
          selectedCount={bulk.selectedCount}
          allSelected={bulk.allVisibleSelected}
          indeterminate={bulk.indeterminate}
          progress={bulk.progress}
          onToggleAll={bulk.toggleAllVisible}
          onHandle={bulk.markHandled}
          onForward={openBulkForward}
          onHide={() => setHideOpen(true)}
          onClear={bulk.clear}
        />
        <div className="app-rows" data-testid="app-list-rows" ref={rowsRef}>
          {hasNew ? (
            <button type="button" className="app-newpill" onClick={showNew} data-testid="app-newpill">
              <ArrowUp size={13} /> Nové odpovědi
            </button>
          ) : null}

          {list.status === 'loading' && rows.length === 0 ? (
            <>{[0, 1, 2, 3, 4].map((i) => <div className="app-skeleton-row" key={i} />)}</>
          ) : list.status === 'error' && rows.length === 0 ? (
            <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{list.error}</div></div>
          ) : rows.length === 0 ? (
            <div className="app-empty" data-testid="app-list-empty">
              <div className="app-empty__title">{emptyCopy.title}</div>
              <div>{emptyCopy.hint}</div>
            </div>
          ) : (
            <>
              {rows.map((r) => (
                <ReplyRow
                  key={r.id}
                  reply={r}
                  active={String(r.id) === activeId}
                  onOpen={open}
                  selected={bulk.selectedIds.has(String(r.id))}
                  onToggleSelect={bulk.toggle}
                />
              ))}
              <div ref={sentinelRef} className="app-sentinel" aria-hidden="true" />
              {list.status === 'loadingMore' ? (
                <div className="app-more" data-testid="app-loading-more"><Loader2 size={14} className="app-spin" aria-hidden="true" /> Načítám…</div>
              ) : list.done ? (
                <div className="app-more app-more--end">— konec —</div>
              ) : null}
            </>
          )}
        </div>
      </aside>

      <ConversationPane
        key={activeId}
        activeId={activeId}
        detail={detail}
        patch={detailPatch[activeId]}
        onFlag={optimisticFlag}
        onArchive={optimisticArchive}
        onSent={onComposerSent}
        onReclassified={reconcile}
        onForwardCrm={openSingleForward}
      />

      <ReplyForwardDialog
        open={!!forwardState}
        count={forwardState?.ids.length || 0}
        busy={!!bulk.progress}
        onConfirm={confirmForward}
        onClose={() => setForwardState(null)}
      />
      <ReplyConfirmDialog
        open={hideOpen}
        title={`Skrýt ${bulk.selectedCount} ${bulk.selectedCount === 1 ? 'odpověď' : bulk.selectedCount < 5 ? 'odpovědi' : 'odpovědí'}?`}
        body="Vybrané odpovědi budou označeny jako vyřízené a zmizí z přehledu nevyřízených. Akce je auditována; reálné smazání není podporováno (zachová se audit). Lze vrátit zpět."
        confirmLabel={`Skrýt ${bulk.selectedCount}`}
        danger
        busy={!!bulk.progress}
        onConfirm={confirmHide}
        onClose={() => setHideOpen(false)}
      />

      {toast ? (
        <div className={`app-toast${toast.kind === 'err' ? ' app-toast--err' : ''}`} role="status" data-testid="app-toast">{toast.text}</div>
      ) : null}
    </div>
  )
}
