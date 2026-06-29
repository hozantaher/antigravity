import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Target, RefreshCw, Search, Mail, X, Rocket, ChevronDown } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { relativeCs } from '../lib/replyMeta'
import { useToast } from '../../components/Toast'
import Empty from '../components/Empty'
import './app-toptargets.css'

// Top cíle — the scored-prospect pool on the Antique Alchemist frame. Clean
// rebuild of the /top-targets page (src/pages/TopTargets.jsx) against the
// SAME BFF endpoints (/api/prospects/top + /api/prospects/stats). Operator picks
// a score tier / sector / kraj, selects prospects, and launches a campaign
// (carries the selected contact ids to /kampane/nova as ?prefilled_contacts).
// Part of the  dashboard unification. UI-only; no new endpoints.

// ── Named constants — no magic numbers (feedback_no_magic_thresholds T0). ──
const POLL_MS = 60_000
const DEFAULT_PAGE_SIZE = 30
const PAGE_SIZE_OPTIONS = [30, 50, 100]
const SEARCH_MIN_CHARS = 2
// Score-tier boundaries — verbatim from the BFF /api/prospects/stats buckets
// + the useTopTargetsUrlState hook (single source of truth there).
const SCORE_TIER_IDEAL_MIN = 85
const SCORE_TIER_HIGH_MIN = 70
const SCORE_TIER_MEDIUM_MIN = 50
const SCORE_MIN = 0

// Stat-strip tiers — key matches the /api/prospects/stats response shape
// ({ idealni, vysoky, stredni, nizky }); min drives ?min_score=.
const TIERS = [
  { key: 'idealni', label: 'Ideální', hint: `≥ ${SCORE_TIER_IDEAL_MIN}`, min: SCORE_TIER_IDEAL_MIN },
  { key: 'vysoky', label: 'Vysoký', hint: `${SCORE_TIER_HIGH_MIN}–${SCORE_TIER_IDEAL_MIN - 1}`, min: SCORE_TIER_HIGH_MIN },
  { key: 'stredni', label: 'Střední', hint: `${SCORE_TIER_MEDIUM_MIN}–${SCORE_TIER_HIGH_MIN - 1}`, min: SCORE_TIER_MEDIUM_MIN },
  { key: 'nizky', label: 'Nízký', hint: `< ${SCORE_TIER_MEDIUM_MIN}`, min: SCORE_MIN },
]

// Sector + kraj quick-pick options — mirror the TopTargetsFilterPopover
// (companies.sector_primary distinct values + the 14 Czech kraje). Operators can
// still deep-link arbitrary values; these are the curated chips.
const SECTOR_OPTIONS = [
  { value: 'machinery', label: 'Strojírenství' },
  { value: 'construction', label: 'Stavebnictví' },
  { value: 'agriculture', label: 'Zemědělství' },
  { value: 'transport', label: 'Doprava' },
  { value: 'mining', label: 'Těžba' },
  { value: 'forestry', label: 'Lesnictví' },
  { value: 'manufacturing', label: 'Výroba' },
  { value: 'services', label: 'Služby' },
]
const REGION_OPTIONS = [
  { value: 'Hlavní město Praha', label: 'Praha' },
  { value: 'Jihočeský', label: 'Jihočeský' },
  { value: 'Jihomoravský', label: 'Jihomoravský' },
  { value: 'Karlovarský', label: 'Karlovarský' },
  { value: 'Královéhradecký', label: 'Královéhradecký' },
  { value: 'Liberecký', label: 'Liberecký' },
  { value: 'Moravskoslezský', label: 'Moravskoslezský' },
  { value: 'Olomoucký', label: 'Olomoucký' },
  { value: 'Pardubický', label: 'Pardubický' },
  { value: 'Plzeňský', label: 'Plzeňský' },
  { value: 'Středočeský', label: 'Středočeský' },
  { value: 'Ústecký', label: 'Ústecký' },
  { value: 'Vysočina', label: 'Vysočina' },
  { value: 'Zlínský', label: 'Zlínský' },
]

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0)

// Numeric score → semantic tone. Tier boundaries shared with the BFF.
function scoreTone(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { fg: 'var(--app-text-soft)', bg: 'var(--app-surface-sunk)' }
  }
  if (score >= SCORE_TIER_IDEAL_MIN) return { fg: 'var(--app-accent-strong)', bg: 'var(--app-accent-soft)' }
  if (score >= SCORE_TIER_HIGH_MIN) return { fg: 'var(--app-positive)', bg: 'var(--app-positive-soft)' }
  if (score >= SCORE_TIER_MEDIUM_MIN) return { fg: 'var(--app-warning)', bg: 'var(--app-warning-soft)' }
  return { fg: 'var(--app-text-muted)', bg: 'var(--app-surface-sunk)' }
}

export default function TopTargets() {
  const toast = useToast()
  const navigate = useNavigate()

  // ── Filter + paging state (local; the page kept it in the URL, the
  //    port keeps the surface self-contained). ──
  const [minScore, setMinScore] = useState(SCORE_MIN)
  const [sectors, setSectors] = useState([])
  const [regions, setRegions] = useState([])
  // Emailable-by-default: a "top target" with no address is not actionable for
  // outreach, and the unfiltered full scan is the single heaviest query on the
  // pool (parallel-worker shared-memory pressure on the prod DB). Operator can
  // clear the toggle to see the full scored set.
  const [withEmail, setWithEmail] = useState(true)
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(1)
  const [showFilters, setShowFilters] = useState(false)  // S3: filter card collapsed by default
  // Force the card open only for ITS OWN filters (sector/region chips) — not the
  // toolbar "Pouze s e-mailem" toggle, which is on by default and lives outside.
  const inCardFilterCount = sectors.length + regions.length
  const filtersOpen = showFilters || inCardFilterCount > 0
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE)
  const [selected, setSelected] = useState(() => new Set())

  // Any filter change resets paging + clears selection (the row set changed).
  const afterFilterChange = useCallback(() => {
    setPage(1)
    setSelected(new Set())
  }, [])

  // Build the list URL from filter state. Memoised on primitives/arrays so the
  // string identity only flips on a real filter change — passing an inline
  // function to useResource would re-fetch every render (the 429-storm bug).
  const topUrl = useMemo(() => {
    const p = new URLSearchParams()
    p.set('page', String(page))
    p.set('size', String(size))
    if (minScore > SCORE_MIN) p.set('min_score', String(minScore))
    if (sectors.length) p.set('sector', sectors.join(','))
    if (regions.length) p.set('region', regions.join(','))
    if (withEmail) p.set('with_email', 'true')
    return `/api/prospects/top?${p.toString()}`
  }, [page, size, minScore, sectors, regions, withEmail])

  const statsUrl = useMemo(() => {
    const p = new URLSearchParams()
    if (sectors.length) p.set('sector', sectors.join(','))
    if (regions.length) p.set('region', regions.join(','))
    if (withEmail) p.set('with_email', 'true')
    const qs = p.toString()
    return `/api/prospects/stats${qs ? `?${qs}` : ''}`
  }, [sectors, regions, withEmail])

  const feed = useResource(topUrl, { pollMs: POLL_MS, pauseHidden: true })
  const stats = useResource(statsUrl, { pollMs: POLL_MS, pauseHidden: true })

  const rows = Array.isArray(feed.data?.rows) ? feed.data.rows : []
  const total = Number(feed.data?.total) || 0
  const sc = stats.data || {}
  const highCount = (Number(sc.idealni) || 0) + (Number(sc.vysoky) || 0)

  // Client-side text filter over the loaded page — the BFF /top endpoint has no
  // free-text param, so (like v1) we filter the visible rows in place.
  const q = searchInput.trim().toLowerCase()
  const visibleRows = useMemo(() => {
    if (q.length < SEARCH_MIN_CHARS) return rows
    return rows.filter((r) => {
      const c = r.contact || {}
      const co = r.company || {}
      return [co.name, c.company_name, c.ico, co.ico, c.first_name, c.last_name, c.email]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    })
  }, [rows, q])

  // ── Filter setters ──
  const applyTier = useCallback((min) => {
    setMinScore((prev) => (prev === min ? SCORE_MIN : min))
    afterFilterChange()
  }, [afterFilterChange])
  const toggleSector = useCallback((v) => {
    setSectors((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))
    afterFilterChange()
  }, [afterFilterChange])
  const toggleRegion = useCallback((v) => {
    setRegions((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]))
    afterFilterChange()
  }, [afterFilterChange])
  const toggleEmail = useCallback(() => {
    setWithEmail((prev) => !prev)
    afterFilterChange()
  }, [afterFilterChange])
  const resetFilters = useCallback(() => {
    setMinScore(SCORE_MIN)
    setSectors([])
    setRegions([])
    setWithEmail(false)
    setSearchInput('')
    afterFilterChange()
  }, [afterFilterChange])

  const refresh = useCallback(() => {
    feed.refresh?.()
    stats.refresh?.()
  }, [feed, stats])

  // ── Paging ──
  const goPage = useCallback((n) => {
    setPage(Math.max(1, n))
    setSelected(new Set())
  }, [])
  const changeSize = useCallback((s) => {
    setSize(s)
    setPage(1)
    setSelected(new Set())
  }, [])

  // ── Selection ──
  const toggleRow = useCallback((id) => {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }, [])
  const visibleIds = visibleRows.map((r) => r.contact?.id).filter((id) => id != null)
  const allSel = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const someSel = visibleIds.some((id) => selected.has(id))
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const n = new Set(prev)
      const everySel = visibleIds.length > 0 && visibleIds.every((id) => n.has(id))
      if (everySel) visibleIds.forEach((id) => n.delete(id))
      else visibleIds.forEach((id) => n.add(id))
      return n
    })
  }, [visibleIds])
  const clearSel = useCallback(() => setSelected(new Set()), [])

  // "Spustit kampaň" — copy the selected contact ids to the clipboard (so the
  // operator can paste if needed) and route to the create flow carrying
  // ?prefilled_contacts=<csv>. This mirrors the action's contract; the
  // create page does not yet consume the param (deferred), but the link carries
  // it so the wiring is forward-compatible.
  const onLaunch = useCallback(async () => {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    const csv = ids.join(',')
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(csv)
        toast?.(`${fmt(ids.length)} ID zkopírováno do schránky`, 'ok')
      } else {
        toast?.(`Vybráno ${fmt(ids.length)} prospektů`, 'ok')
      }
    } catch {
      toast?.(`Vybráno ${fmt(ids.length)} prospektů`, 'ok')
    }
    navigate(`/kampane/nova?prefilled_contacts=${encodeURIComponent(csv)}`)
  }, [selected, toast, navigate])

  const activeFilterCount =
    (minScore > SCORE_MIN ? 1 : 0) +
    (sectors.length ? 1 : 0) +
    (regions.length ? 1 : 0) +
    (withEmail ? 1 : 0) +
    (q.length >= SEARCH_MIN_CHARS ? 1 : 0)

  const rangeStart = total === 0 ? 0 : (page - 1) * size + 1
  const rangeEnd = Math.min(total, page * size)
  const totalPages = Math.max(1, Math.ceil(total / size))
  const tierCount = (key) => (stats.status === 'ok' ? fmt(sc[key] ?? 0) : '—')

  return (
    <div className="app-toptargets" data-testid="app-toptargets">
      {/* Head */}
      <div className="app-tt__head">
        <div>
          {/* Title lives in the topbar (<h1>); this keeps only the useful sub. */}
          <span className="app-tt__sub">
            {feed.loadedAt ? `Aktualizováno ${relativeCs(feed.loadedAt)}` : 'Skórovaný pool prospektů'}
            {stats.status === 'ok' ? ` · ${fmt(highCount)} nad skóre ${SCORE_TIER_HIGH_MIN}` : ''}
          </span>
        </div>
        <button type="button" className="app-tt__refresh" onClick={refresh}
          disabled={feed.status === 'loading'} data-testid="app-toptargets-refresh" title="Obnovit">
          <RefreshCw size={15} /> Obnovit
        </button>
      </div>

      {/* Stat strip — clickable score tiers */}
      <div className="app-tt__stats" data-testid="app-toptargets-stats">
        {TIERS.map((t) => (
          <button type="button" key={t.key} className="app-ttstat"
            data-testid={`app-toptargets-tier-${t.key}`}
            aria-pressed={minScore === t.min && t.min > SCORE_MIN}
            onClick={() => applyTier(t.min)}>
            <div className="app-ttstat__n">{tierCount(t.key)}</div>
            <div className="app-ttstat__l">
              <span className="app-ttstat__label">{t.label}</span>
              <span className="app-ttstat__hint">{t.hint}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Toolbar — search + email toggle + reset */}
      <div className="app-tt__toolbar">
        <span className="app-tt__search">
          <Search size={15} />
          <input type="search" data-testid="app-toptargets-search"
            placeholder="Hledat firmu, IČO, jméno…"
            value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Hledat v cílech" />
        </span>
        <button type="button" className="app-chip-toggle" data-testid="app-toptargets-email-toggle"
          aria-pressed={withEmail} onClick={toggleEmail}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Mail size={13} /> Pouze s e-mailem
        </button>
        <button type="button" className="app-tt__btn" data-testid="app-toptargets-filter-toggle"
          aria-expanded={filtersOpen}
          onClick={() => setShowFilters((v) => !v)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <ChevronDown size={13} style={{ transform: filtersOpen ? 'rotate(180deg)' : 'none', transition: 'transform var(--app-fast)' }} />
          Filtry{inCardFilterCount > 0 ? ` · ${inCardFilterCount}` : ''}
        </button>
        {activeFilterCount > 0 ? (
          <button type="button" className="app-tt__btn" data-testid="app-toptargets-reset" onClick={resetFilters}>
            <X size={13} /> Zrušit filtry · {activeFilterCount}
          </button>
        ) : null}
      </div>

      {/* Sector + kraj filter chips — collapsed by default; force-open when a
          filter is active (S3 — reclaims ~90px above the table on a laptop). */}
      {filtersOpen && (
      <div className="app-tt__filters" data-testid="app-toptargets-filters">
        <div className="app-tt__fgroup">
          <span className="app-tt__flabel">Sektor</span>
          <div className="app-tt__chips">
            {SECTOR_OPTIONS.map((o) => (
              <button type="button" key={o.value} className="app-chip-toggle"
                data-testid={`app-toptargets-sector-${o.value}`}
                aria-pressed={sectors.includes(o.value)}
                onClick={() => toggleSector(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="app-tt__fgroup">
          <span className="app-tt__flabel">Kraj</span>
          <div className="app-tt__chips">
            {REGION_OPTIONS.map((o) => (
              <button type="button" key={o.value} className="app-chip-toggle"
                data-testid={`app-toptargets-region-${o.value}`}
                aria-pressed={regions.includes(o.value)}
                onClick={() => toggleRegion(o.value)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      )}

      {/* List area — 4 states (mirrors Upozorneni) */}
      {feed.status === 'error' ? (
        <div className="app-empty" data-testid="app-toptargets-error">
          <div className="app-empty__title">Nepodařilo se načíst</div>
          <div>{feed.error}</div>
        </div>
      ) : (feed.status === 'loading' || feed.status === 'idle') && rows.length === 0 ? (
        <div className="app-tt__list" data-testid="app-toptargets-loading">
          {[0, 1, 2, 3, 4].map((i) => <div className="app-skeleton-row" key={i} />)}
        </div>
      ) : visibleRows.length === 0 ? (
        <Empty icon={Target} testid="app-toptargets-empty"
          title="Žádní prospekti"
          hint="Pro zvolený filtr nejsou žádné cíle. Zkus uvolnit filtry nebo hledaný výraz."
          action={activeFilterCount > 0 ? { label: 'Resetovat filtry', onClick: resetFilters } : undefined} />
      ) : (
        <>
          <div className="app-tt__bar" data-testid="app-toptargets-actionbar" role="toolbar" aria-label="Hromadné akce">
            <input type="checkbox" data-testid="app-toptargets-master" aria-label="Vybrat vše viditelné"
              checked={allSel}
              ref={(el) => { if (el) el.indeterminate = !allSel && someSel }}
              onChange={toggleAll} />
            <span className="app-tt__count" data-testid="app-toptargets-count">
              {selected.size > 0 ? `${fmt(selected.size)} vybráno` : 'Nic vybráno'}
            </span>
            <button type="button" className="app-tt__launch" data-testid="app-toptargets-launch"
              disabled={selected.size === 0} onClick={onLaunch}
              title={selected.size === 0 ? 'Vyber prospekty pro novou kampaň' : 'Spustit novou kampaň s výběrem'}>
              <Rocket size={14} /> Spustit kampaň
            </button>
            <button type="button" className="app-tt__btn" data-testid="app-toptargets-clear"
              disabled={selected.size === 0} onClick={clearSel}>
              <X size={13} /> Zrušit výběr
            </button>
            <span className="app-tt__range" data-testid="app-toptargets-range">
              {total > 0 ? `${fmt(rangeStart)}–${fmt(rangeEnd)} z ${fmt(total)}` : 'Bez výsledků'}
            </span>
          </div>

          <div className="app-tt__tablewrap" data-testid="app-toptargets-tablewrap">
            <table className="app-tt__table" data-testid="app-toptargets-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }} aria-label="Výběr" />
                  <th>Firma</th>
                  <th>Kontakt</th>
                  <th>Sektor</th>
                  <th>ICP</th>
                  <th className="app-tt__th-right">Skóre</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => {
                  const c = r.contact || {}
                  const co = r.company || {}
                  const id = c.id
                  const ico = (c.ico || co.ico || '').trim()
                  const companyName = (co.name || c.company_name || '—') || '—'
                  const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '—'
                  const showEmail = c.email && c.email !== name
                  const tone = scoreTone(r.prospect_score)
                  const scoreLabel = Number.isFinite(r.prospect_score) ? Math.round(r.prospect_score) : '—'
                  return (
                    <tr key={id} data-testid="app-toptargets-row">
                      <td>
                        <input type="checkbox"
                          data-testid={`app-toptargets-select-${id}`}
                          aria-label={`Vybrat ${companyName}`}
                          checked={selected.has(id)}
                          onChange={() => toggleRow(id)} />
                      </td>
                      <td>
                        {ico ? (
                          <Link className="app-tt__cell-firma" to={`/firmy?ico=${encodeURIComponent(ico)}`}
                            data-testid={`app-toptargets-open-${id}`} title={`${companyName} · IČO ${ico}`}>
                            {companyName}
                          </Link>
                        ) : (
                          <span className="app-tt__cell-firma">{companyName}</span>
                        )}
                        {ico ? <div className="app-tt__sub2">IČO {ico}</div> : null}
                      </td>
                      <td>
                        <div>{name}</div>
                        {showEmail ? <div className="app-tt__sub2">{c.email}</div> : null}
                      </td>
                      <td className="app-tt__muted">{co.sector_primary || '—'}</td>
                      <td className="app-tt__muted">{co.icp_tier || '—'}</td>
                      <td className="app-tt__td-right">
                        <span className="app-tt__score" style={{ color: tone.fg, background: tone.bg }}>
                          {scoreLabel}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="app-tt__pager" data-testid="app-toptargets-pager">
            <button type="button" className="app-tt__btn" data-testid="app-toptargets-prev"
              disabled={page <= 1} onClick={() => goPage(page - 1)}>
              Předchozí
            </button>
            <span data-testid="app-toptargets-pageinfo">Strana {fmt(page)} z {fmt(totalPages)}</span>
            <button type="button" className="app-tt__btn" data-testid="app-toptargets-next"
              disabled={page >= totalPages} onClick={() => goPage(page + 1)}>
              Další
            </button>
            <span className="app-tt__pager-spacer" />
            <label>
              Na stránku{' '}
              <select data-testid="app-toptargets-size" value={size}
                onChange={(e) => changeSize(Number(e.target.value))} aria-label="Počet na stránku">
                {PAGE_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  )
}
