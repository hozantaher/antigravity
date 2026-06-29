import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, X } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import { STAGES, CANCELLED, stageMeta, bestPrice, vehicleTitle, vehicleSpecs } from '../lib/vehicleMeta'
import { relativeCs } from '../lib/replyMeta'
import VehicleDetailAside from '../components/vozidla/VehicleDetailAside'
import './app-vozidla.css'

// Vozidla — the acquisition inventory as a dense, scannable, sortable
// TABLE (operator decision 2026-05-31: a kanban with 14 rows all in one
// column is noise; a table is how you actually read inventory). Row → detail
// aside with full interconnection (firma · CRM klient · zdroj · technika ·
// poznámky) + an interactive pipeline stepper + editable deal prices/marže +
// editable notes (parity port of /vehicles + /vehicles/:id so they retire).
// Reuses /api/vehicles — list, GET-by-id, and the audited PATCH for mutations.
// docs/initiatives/2026-05-31-ux-app-claude.md (Phase 3, table revision).

// The vehicles list has no pagination UI — it's meant to be scanned whole, and
// the inventory IS the operator's pipeline. Request the server's max page size
// (the endpoint reads `size`, NOT `limit` — `?limit=200` was a dead param that
// silently capped the table at the default 30 rows).
const LIST_SIZE = 500
// Search activates at ≥2 chars (mirrors the BFF /api/vehicles `q` gate + the
// TopTargets client-side search). Below that the full set is shown.
const SEARCH_MIN_CHARS = 2

// Sort accessors per column key — pure, null-safe.
const SORTERS = {
  status: (v) => v.status || '',
  vehicle: (v) => `${v.make || ''} ${v.model || ''}`.toLowerCase(),
  year: (v) => Number(v.year) || -1,
  company: (v) => (v.company_name || v.crm_client_name || '').toLowerCase(),
  created: (v) => v.created_at || '',
}

function StatusChip({ status }) {
  const m = stageMeta(status)
  return <span className="app-tag" style={{ color: m.fg, background: m.bg }}>{m.label}</span>
}

function Th({ col, label, sort, setSort, align }) {
  const active = sort.key === col
  return (
    <th
      className={`app-th${active ? ' app-th--active' : ''}`}
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => setSort((s) => ({ key: col, dir: s.key === col && s.dir === 'asc' ? 'desc' : 'asc' }))}
      data-testid={`app-th-${col}`}
    >
      {label}{active ? <span className="app-th__arrow">{sort.dir === 'asc' ? ' ↑' : ' ↓'}</span> : null}
    </th>
  )
}

export default function Vozidla() {
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const activeId = params.get('id')
  const statusFilter = params.get('stav') || 'all'
  const [sort, setSort] = useState({ key: 'created', dir: 'desc' })
  // Local filter state — client-side over the loaded set, mirroring TopTargets
  // (the list loads whole, so search/make/price refine in place, instantly).
  const [search, setSearch] = useState('')
  const [makeFilter, setMakeFilter] = useState('')
  const [priceMin, setPriceMin] = useState('')
  const [priceMax, setPriceMax] = useState('')

  const list = useResource(`/api/vehicles?size=${LIST_SIZE}`, { pollMs: 30_000, pauseHidden: true })
  // Stabilise the row array reference so the makes/filtered memos only recompute
  // on a real data change (not every render).
  const allRows = useMemo(() => list.data?.rows || [], [list.data])

  // Status filter chips: all + each stage that has rows (+ cancelled if present).
  const counts = allRows.reduce((m, v) => { m[v.status] = (m[v.status] || 0) + 1; return m }, {})
  const filterChips = [{ key: 'all', label: 'Vše', n: allRows.length },
    ...STAGES.filter((s) => counts[s.key]).map((s) => ({ key: s.key, label: s.label, n: counts[s.key] })),
    ...(counts.cancelled ? [{ key: 'cancelled', label: CANCELLED.label, n: counts.cancelled }] : [])]

  // Distinct makes present in inventory — drives the značka quick-filter.
  const makes = useMemo(() => {
    const set = new Set()
    for (const v of allRows) if (v.make) set.add(v.make)
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'cs'))
  }, [allRows])

  // Combined client-side filtering: status → search → make → price range.
  const q = search.trim().toLowerCase()
  const pMin = priceMin === '' ? null : Number(priceMin)
  const pMax = priceMax === '' ? null : Number(priceMax)
  const filtered = useMemo(() => allRows.filter((v) => {
    if (statusFilter !== 'all' && v.status !== statusFilter) return false
    if (makeFilter && v.make !== makeFilter) return false
    if (q.length >= SEARCH_MIN_CHARS) {
      const hay = [v.make, v.model, v.vin, v.notes, v.company_name, v.crm_client_name, v.year]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (pMin != null || pMax != null) {
      const amt = bestPrice(v)?.amount
      if (amt == null) return false
      if (pMin != null && Number.isFinite(pMin) && amt < pMin) return false
      if (pMax != null && Number.isFinite(pMax) && amt > pMax) return false
    }
    return true
  }), [allRows, statusFilter, makeFilter, q, pMin, pMax])

  const accessor = SORTERS[sort.key] || SORTERS.created
  const rows = [...filtered].sort((a, b) => {
    const av = accessor(a), bv = accessor(b)
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sort.dir === 'asc' ? cmp : -cmp
  })

  const open = (id) => { const n = new URLSearchParams(params); n.set('id', String(id)); setParams(n) }
  const close = () => { const n = new URLSearchParams(params); n.delete('id'); setParams(n, { replace: true }) }
  const setFilter = (key) => { const n = new URLSearchParams(params); if (key === 'all') n.delete('stav'); else n.set('stav', key); setParams(n, { replace: true }) }

  // Count of active auxiliary (non-status) filters → drives the reset control.
  const activeAux = (q.length >= SEARCH_MIN_CHARS ? 1 : 0) + (makeFilter ? 1 : 0) + (pMin != null || pMax != null ? 1 : 0)
  const resetAux = () => { setSearch(''); setMakeFilter(''); setPriceMin(''); setPriceMax('') }

  // Resolve the open vehicle from the loaded list; fall back to a by-id fetch so
  // a deep-link (?id=… from Kontakty/Firmy/Odpovedi) opens the detail even when
  // that vehicle isn't in the current page.
  const fromList = allRows.find((v) => String(v.id) === activeId) || null
  const vehDetail = useResource(
    activeId && !fromList ? `/api/vehicles/${encodeURIComponent(activeId)}` : null,
    { enabled: !!activeId && !fromList },
  )
  const selected = fromList || vehDetail.data || null

  if (list.status === 'error') {
    return <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{list.error}</div></div>
  }

  return (
    <div className="app-vozidla" data-testid="app-vozidla">
      <div className="app-vozidla__main">
        {/* Search + make + price-range toolbar (parity with search/filters). */}
        <div className="app-vozidla__toolbar" data-testid="app-vozidla-toolbar">
          <span className="app-vozidla__search">
            <Search size={14} />
            <input
              type="search" data-testid="app-vehicle-search"
              placeholder="Hledat firmu, značku, model, VIN…"
              value={search} onChange={(e) => setSearch(e.target.value)}
              aria-label="Hledat ve vozidlech"
            />
          </span>
          <select
            className="app-vozidla__select" data-testid="app-vehicle-make-filter"
            value={makeFilter} onChange={(e) => setMakeFilter(e.target.value)} aria-label="Filtr značky"
          >
            <option value="">Všechny značky</option>
            {makes.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="app-vozidla__price-range">
            <input
              type="number" min="0" inputMode="numeric" className="app-vozidla__price-in"
              data-testid="app-vehicle-price-min" placeholder="Cena od €"
              value={priceMin} onChange={(e) => setPriceMin(e.target.value)} aria-label="Cena od (€)"
            />
            <span className="app-vozidla__price-dash" aria-hidden="true">–</span>
            <input
              type="number" min="0" inputMode="numeric" className="app-vozidla__price-in"
              data-testid="app-vehicle-price-max" placeholder="do €"
              value={priceMax} onChange={(e) => setPriceMax(e.target.value)} aria-label="Cena do (€)"
            />
          </span>
          {activeAux > 0 ? (
            <button type="button" className="app-vozidla__reset" data-testid="app-vehicle-reset-filters" onClick={resetAux}>
              <X size={13} /> Zrušit filtry · {activeAux}
            </button>
          ) : null}
        </div>

        <div className="app-vozidla__filters">
          {filterChips.map((c) => (
            <button key={c.key} type="button" className="app-chip-toggle" aria-pressed={statusFilter === c.key}
              onClick={() => setFilter(c.key)} data-testid={`app-filter-${c.key}`}>
              {c.label} <span className="app-chip-toggle__n">{c.n}</span>
            </button>
          ))}
        </div>

        {list.status === 'loading' && allRows.length === 0 ? (
          <div className="app-vozidla__rows">{[0, 1, 2, 3, 4, 5].map((i) => <div className="app-skel-row" key={i} />)}</div>
        ) : rows.length === 0 ? (
          allRows.length === 0 ? (
            <div className="app-empty" data-testid="app-vozidla-empty">
              <div className="app-empty__title">Žádná vozidla</div>
              <div>Hot odpověď s technikou se sem propíše jako nové vozidlo.</div>
            </div>
          ) : (
            <div className="app-empty" data-testid="app-vozidla-empty-filtered">
              <div className="app-empty__title">Žádná vozidla pro zvolený filtr</div>
              <div>Zkus uvolnit hledání, značku nebo cenové rozpětí.</div>
              {activeAux > 0 ? <button type="button" className="app-empty__action" onClick={resetAux}>Zrušit filtry</button> : null}
            </div>
          )
        ) : (
          <div className="app-vozidla__tablewrap">
            <table className="app-table" data-testid="app-vehicle-table">
              <thead>
                <tr>
                  <Th col="status" label="Stav" sort={sort} setSort={setSort} />
                  <Th col="vehicle" label="Technika" sort={sort} setSort={setSort} />
                  <th>Specifikace</th>
                  <Th col="year" label="Rok" sort={sort} setSort={setSort} align="right" />
                  <Th col="company" label="Firma" sort={sort} setSort={setSort} />
                  <Th col="created" label="Přidáno" sort={sort} setSort={setSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id} className={`app-tr${String(v.id) === activeId ? ' app-tr--active' : ''}`}
                    onClick={() => open(v.id)} data-testid="app-vehicle-row">
                    <td><StatusChip status={v.status} /></td>
                    <td className="app-td-strong">{vehicleTitle(v)}</td>
                    <td className="app-td-muted">{vehicleSpecs(v) || '—'}</td>
                    <td style={{ textAlign: 'right' }} className="app-td-strong">{v.year || '—'}</td>
                    <td className="app-td-muted">{v.company_name || v.crm_client_name || '—'}</td>
                    <td style={{ textAlign: 'right' }} className="app-td-muted">{relativeCs(v.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selected && <VehicleDetailAside vehicle={selected} onClose={close} toast={toast}
        onChanged={() => { list.refresh?.(); vehDetail.refresh?.() }} />}
    </div>
  )
}
