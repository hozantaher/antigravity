import { useState, useEffect } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { SlidersHorizontal } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import { scoreValue, sizeLabel, fmtDateCs } from '../lib/companyMeta'
import { EmptySearch } from '../components/Empty'
import FirmyRow from '../components/firmy/FirmyRow'
import FirmyFilters from '../components/firmy/FirmyFilters'
import FirmyBulkBar from '../components/firmy/FirmyBulkBar'
import FirmyDetail from '../components/firmy/FirmyDetail'
import './app-firmy.css'

// Firmy — prospecting directory on the Antique Alchemist frame. 426k
// ICP-scored companies, ordered best-target-first; debounced search; advanced
// firmographic filters (size · sector · kraj · e-mail jistota · web · kontakt);
// multi-select → launch a campaign or bulk-verify the selection; CSV export of
// the filtered view; and a deep detail aside (score trend + activity + verify /
// recompute + linked vehicles + contacts + campaigns). Twin-parity rebuild of
// the src/pages/Companies.jsx against the SAME /api/companies endpoints — no
// new backend. docs/initiatives/2026-06-20-dashboard-unification.md.

// ── Named constants — no magic numbers (feedback_no_magic_thresholds T0). ──
const LIST_LIMIT = 60
const DEBOUNCE_MS = 300
const POLL_MS = 45_000
const MAX_BULK_VERIFY = 50 // matches the BFF bulk-verify-email cap

const csv = (raw) => (raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [])
const nf = new Intl.NumberFormat('cs-CZ')

// CSV export of the current filtered view (mirrors exportRowsToCsv).
function exportRowsToCsv(rows) {
  const esc = (v) => {
    if (v == null) return ''
    const s = String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const headers = ['IČO', 'Název', 'E-mail', 'Web', 'Region', 'Sektor', 'Velikost', 'Skóre', 'ICP', 'Posl. kontakt']
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      esc(r.ico), esc(r.name), esc(r.email || ''), esc(r.website || ''),
      esc(r.region_normalized || r.address_locality || ''), esc(r.sector_primary || ''),
      esc(sizeLabel(r.velikost_firmy) || ''), esc(scoreValue(r) ?? ''),
      esc(r.icp_tier || ''), esc(fmtDateCs(r.last_contacted) || ''),
    ].join(','))
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `firmy-export-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export default function Firmy() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const activeIco = params.get('ico')
  const q = params.get('q') || ''
  const [draft, setDraft] = useState(q)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [verifying, setVerifying] = useState(false)

  // Debounced search → URL. Read the LIVE url at fire-time (not the captured
  // `params`) so a change made during the debounce window (clicking a row to
  // set ?ico, toggling a filter) isn't clobbered by this stale snapshot.
  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(window.location.search)
      if (draft) next.set('q', draft); else next.delete('q')
      setParams(next, { replace: true })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // Keep the search box in sync when `q` changes from OUTSIDE typing — e.g.
  // "Zrušit filtry" navigating to /firmy (clears q) or the browser Back button.
  // Without this the input keeps the stale draft after such a reset.
  useEffect(() => { setDraft(q) }, [q])

  // Quick filters (preserved from the original Firmy).
  const icp = params.get('icp') || ''      // '' | 'ideal' | 'good'
  const emailOk = params.get('email') === '1'
  // Advanced filters — every one maps to an existing /api/companies query param.
  const f = {
    size: csv(params.get('size')),
    sectors: csv(params.get('sector')),
    regions: csv(params.get('region')),
    emailConf: params.get('emailconf') ? Number(params.get('emailconf')) : null,
    web: params.get('web') === 'with' ? 'with' : params.get('web') === 'without' ? 'without' : null,
    never: params.get('never') === '1',
    since: params.get('since') || '',
  }
  const advancedActive = f.size.length + f.sectors.length + f.regions.length
    + (f.emailConf ? 1 : 0) + (f.web ? 1 : 0) + (f.never ? 1 : 0) + (f.since ? 1 : 0)
  const anyFilter = !!q || !!icp || emailOk || advancedActive > 0

  // Build the list URL — light default (top composite-score first), NEVER the
  // heaviest unfiltered scan. The prod DB can 500 on heavy unfiltered scans;
  // useResource keeps the graceful error state.
  const sp = new URLSearchParams()
  sp.set('limit', String(LIST_LIMIT)); sp.set('sort', 'score'); sp.set('dir', 'desc')
  if (q) sp.set('search', q)
  if (icp) sp.set('icp', icp)
  if (emailOk) sp.append('email_status[]', 'valid')
  if (f.size.length) sp.set('size', f.size.join(','))
  f.sectors.forEach((s) => sp.append('sector[]', s))
  f.regions.forEach((r) => sp.append('region[]', r))
  if (f.emailConf != null) sp.set('emailConfidenceMin', String(f.emailConf))
  if (f.web === 'with') sp.set('hasWebsite', '1'); else if (f.web === 'without') sp.set('hasWebsite', '0')
  if (f.since) sp.set('lastContactedSince', f.since)
  if (f.never) sp.set('lastContactedNever', '1')
  const listUrl = `/api/companies?${sp.toString()}`
  const list = useResource(listUrl, { pollMs: POLL_MS, pauseHidden: true })
  const rows = list.data?.rows || []
  const total = list.data?.total

  // Any list-query change (search OR any filter) means the row set changed →
  // drop the selection so a stale ico can't ride into a bulk action. Opening a
  // detail (?ico) and ticking a checkbox don't touch listUrl, so they persist.
  // React's "adjust state during render" pattern (no effect, no cascading
  // render): https://react.dev/learn/you-might-not-need-an-effect
  const [prevListUrl, setPrevListUrl] = useState(listUrl)
  if (listUrl !== prevListUrl) {
    setPrevListUrl(listUrl)
    setSelected(new Set())
  }

  // ── URL mutators ──
  const open = (ico) => { const n = new URLSearchParams(params); n.set('ico', String(ico)); setParams(n) }
  const setIcp = (v) => { const n = new URLSearchParams(params); if (v) n.set('icp', v); else n.delete('icp'); setParams(n, { replace: true }) }
  const toggleEmail = () => { const n = new URLSearchParams(params); if (emailOk) n.delete('email'); else n.set('email', '1'); setParams(n, { replace: true }) }
  // Patch advanced filters into the URL (csv arrays / scalars; delete on empty).
  const patch = (partial) => {
    const n = new URLSearchParams(params)
    const apply = (key, val) => {
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) n.delete(key)
      else n.set(key, Array.isArray(val) ? val.join(',') : String(val))
    }
    if ('size' in partial) apply('size', partial.size)
    if ('sectors' in partial) apply('sector', partial.sectors)
    if ('regions' in partial) apply('region', partial.regions)
    if ('emailConf' in partial) apply('emailconf', partial.emailConf)
    if ('web' in partial) apply('web', partial.web)
    if ('since' in partial) apply('since', partial.since)
    if ('never' in partial) { if (partial.never) n.set('never', '1'); else n.delete('never') }
    setParams(n, { replace: true })
  }

  // ── Selection ──
  const toggleSelect = (ico) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(ico)) next.delete(ico); else next.add(ico)
    return next
  })
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.ico))
  const someSelected = rows.some((r) => selected.has(r.ico))
  const toggleAll = () => setSelected((prev) => {
    const next = new Set(prev)
    if (rows.length > 0 && rows.every((r) => next.has(r.ico))) rows.forEach((r) => next.delete(r.ico))
    else rows.forEach((r) => next.add(r.ico))
    return next
  })
  const clearSel = () => setSelected(new Set())
  // Cap the count at the BFF bulk-verify limit — onVerify truncates the POST at
  // MAX_BULK_VERIFY, so an uncapped label would promise more than it verifies.
  const eligibleVerify = Math.min(rows.filter((r) => selected.has(r.ico) && r.email).length, MAX_BULK_VERIFY)

  // ── Bulk actions ──
  const onExport = () => { exportRowsToCsv(rows); toast(`Exportováno ${nf.format(rows.length)} firem`, 'ok') }

  const onLaunch = async () => {
    const icos = Array.from(selected)
    if (icos.length === 0) return
    const out = icos.join(',')
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(out)
        toast(`${nf.format(icos.length)} IČO zkopírováno do schránky`, 'ok')
      } else {
        toast(`Vybráno ${nf.format(icos.length)} firem`, 'ok')
      }
    } catch { toast(`Vybráno ${nf.format(icos.length)} firem`, 'ok') }
    navigate(`/kampane/nova?prefilled_companies=${encodeURIComponent(out)}`)
  }

  // Bulk-verify reuses the SAME endpoint + headers uses (no X-Confirm-Send —
  // companies.js is not in the BFF X-Confirm gate). Refresh the list on success.
  const onVerify = async () => {
    const icos = rows.filter((r) => selected.has(r.ico) && r.email).slice(0, MAX_BULK_VERIFY).map((r) => r.ico)
    if (icos.length === 0) return
    setVerifying(true)
    try {
      const r = await fetch('/api/companies/bulk-verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icos }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = await r.json()
      const n = Array.isArray(body.results) ? body.results.length : icos.length
      toast(`Ověřeno ${nf.format(n)} firem`, 'ok')
      list.refresh?.()
    } catch (e) {
      toast(e?.message ? `Hromadné ověření selhalo: ${e.message}` : 'Hromadné ověření selhalo', 'err')
    } finally { setVerifying(false) }
  }

  return (
    <div className="app-firmy" data-testid="app-firmy">
      <div className="app-firmy__list">
        <div className="app-firmy__search">
          <input value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Hledat firmu nebo IČO…" data-testid="app-company-search" />
        </div>
        <div className="app-firmy__filters" data-testid="app-firmy-filters">
          <button type="button" className="app-chip-toggle" aria-pressed={!icp} onClick={() => setIcp('')} data-testid="app-firmy-icp-all">Vše</button>
          <button type="button" className="app-chip-toggle" aria-pressed={icp === 'ideal'} onClick={() => setIcp('ideal')} data-testid="app-firmy-icp-ideal">ICP ideál</button>
          <button type="button" className="app-chip-toggle" aria-pressed={icp === 'good'} onClick={() => setIcp('good')} data-testid="app-firmy-icp-good">ICP dobré</button>
          <button type="button" className="app-chip-toggle" aria-pressed={emailOk} onClick={toggleEmail} data-testid="app-firmy-email">Ověřený e-mail</button>
          <button type="button" className="app-chip-toggle app-firmy__advbtn" aria-pressed={advancedOpen}
            aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((o) => !o)} data-testid="app-firmy-advanced-toggle">
            <SlidersHorizontal size={13} /> Filtry{advancedActive > 0 ? ` (${advancedActive})` : ''}
          </button>
          {total != null ? <span className="app-firmy__count">{nf.format(total)}</span> : null}
        </div>

        {advancedOpen ? <FirmyFilters f={f} patch={patch} /> : null}

        <FirmyBulkBar
          rowCount={rows.length}
          selectedCount={selected.size}
          allSelected={allSelected}
          someSelected={someSelected}
          eligibleVerify={eligibleVerify}
          verifying={verifying}
          onToggleAll={toggleAll}
          onExport={onExport}
          onLaunch={onLaunch}
          onVerify={onVerify}
          onClear={clearSel}
        />

        <div className="app-firmy__rows">
          {list.status === 'loading' && rows.length === 0 ? (
            <>{[0, 1, 2, 3, 4].map((i) => <div className="app-skeleton-row" key={i} />)}</>
          ) : list.status === 'error' ? (
            <div className="app-empty" data-testid="app-companies-list-error"><div className="app-empty__title">Nepodařilo se načíst</div><div>{list.error}</div></div>
          ) : rows.length === 0 ? (
            <EmptySearch
              testid="app-companies-list-empty"
              title={anyFilter ? 'Nic neodpovídá' : 'Žádné firmy'}
              hint={anyFilter ? 'Žádná firma neodpovídá hledání ani filtrům. Zkus je uvolnit.' : 'Zatím tu nejsou žádné firmy.'}
              action={anyFilter ? { to: '/firmy', label: 'Zrušit filtry' } : undefined}
            />
          ) : (
            rows.map((c) => (
              <FirmyRow key={c.ico} c={c} active={c.ico === activeIco}
                selected={selected.has(c.ico)} onOpen={open} onToggleSelect={toggleSelect} />
            ))
          )}
        </div>
      </div>
      <FirmyDetail key={activeIco} ico={activeIco} />
    </div>
  )
}
