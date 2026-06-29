import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { clientName, crmStatusMeta, relationshipLabel } from '../lib/crmMeta'
import { vehicleTitle, bestPrice, formatEur, stageMeta } from '../lib/vehicleMeta'
import { EmptySearch } from '../components/Empty'
import { relativeCs } from '../lib/replyMeta'
import './app-crm.css'

// CRM klienti — the CRM book (eWAY-CRM import) on the Claude frame.
// Operator story: scan the pipeline (stat strip + import freshness), filter the
// book (status / vztah / má e-mail), browse/search, open a client, see their
// card + linked kontakty / firmy / nabízená vozidla. Twin-parity rebuild of the
// CrmClients page against the SAME BFF endpoints (/api/crm/clients{,/:id,
// /stats,/freshness} + /api/vehicles?crm_client_id) — read-only surface.
// docs/initiatives/2026-06-20-dashboard-unification.md (CRM twin-parity).

const LIST_LIMIT = 60
const DEBOUNCE_MS = 300

const fmtN = (n) => Number(n || 0).toLocaleString('cs-CZ')

function StatusChip({ status }) {
  const m = crmStatusMeta(status)
  return m ? <span className="app-tag" style={{ color: m.fg, background: m.bg }}>{m.label}</span> : null
}

function Row({ c, active, onOpen }) {
  const rel = relationshipLabel(c.crm_relationship)
  return (
    <button type="button" className="app-crow" aria-current={active ? 'true' : undefined}
      onClick={() => onOpen(c.id)} data-testid="app-crm-row">
      <div className="app-crow__name">{clientName(c)}</div>
      <div className="app-crow__sub">{[c.owner_email, c.ico && `IČO ${c.ico}`].filter(Boolean).join(' · ') || '—'}</div>
      <div className="app-crow__tags">
        <StatusChip status={c.crm_status} />
        {rel ? <span className="app-tag app-tag--rel">{rel}</span> : null}
        {c.linked_companies > 0 ? <span className="app-tag app-tag--linked">{c.linked_companies} firem</span> : null}
        {c.linked_contacts > 0 ? <span className="app-tag app-tag--linked">{c.linked_contacts} kontaktů</span> : null}
      </div>
    </button>
  )
}

function DetailAside({ id }) {
  const detail = useResource(id ? `/api/crm/clients/${encodeURIComponent(id)}` : null, { enabled: !!id })
  // Vehicles this client is offering. The auto-capture pipeline links
  // vehicles → crm_client_id; a hot lead's whole point (firma chce prodat
  // techniku) was invisible on its CRM record. Fetched separately so the
  // /api/crm/clients/:id shape stays untouched (parity with drawer).
  const veh = useResource(id ? `/api/vehicles?crm_client_id=${encodeURIComponent(id)}&size=50` : null, { enabled: !!id })
  const vehicles = Array.isArray(veh.data) ? veh.data : (veh.data?.rows || [])

  if (!id) {
    return (
      <div className="app-empty" data-testid="app-crm-empty">
        <div className="app-empty__title">Vyber klienta</div>
        <div>Zvol klienta vlevo a uvidíš jeho kartu.</div>
      </div>
    )
  }
  if (detail.status === 'error') {
    return <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{detail.error}</div></div>
  }
  if (detail.status !== 'ok' || !detail.data) {
    return <div className="app-empty"><div className="app-empty__title">Načítám…</div></div>
  }
  const c = detail.data
  const rows = [
    ['IČO', c.ico],
    ['E-mail', c.email_primary],
    ['Vlastník', c.owner_email],
    ['Vztah', relationshipLabel(c.crm_relationship)],
    ['Poslední aktivita', (c.last_activity || c.last_activity_at) ? relativeCs(c.last_activity || c.last_activity_at) : null],
    ['Zdroj importu', c.imported_from],
  ].filter(([, v]) => v != null && v !== '')
  // The LIST endpoint returns linked_contacts/linked_companies as integer counts;
  // the DETAIL endpoint returns arrays. Guard so a list-shaped row (before the
  // detail fetch resolves) can't .map() over an integer (#1586 R2).
  const contacts = Array.isArray(c.linked_contacts) ? c.linked_contacts : []
  const companies = Array.isArray(c.linked_companies) ? c.linked_companies : []
  return (
    <div className="app-crm__pane" data-testid="app-crm-detail">
      <h2 className="app-cd__name">{clientName(c)}</h2>
      <div style={{ marginBottom: 'var(--app-space-3)' }}><StatusChip status={c.crm_status} /></div>
      <div className="app-cd__section">
        <div className="app-cd__label">Klient</div>
        <dl style={{ margin: 0 }}>{rows.map(([k, v]) => <div className="app-cd__row" key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      </div>
      {contacts.length > 0 ? (
        <div className="app-cd__section" data-testid="app-crm-contacts">
          <div className="app-cd__label">Kontakty ({contacts.length})</div>
          {contacts.map((ct) => (
            <Link key={ct.id} to={`/kontakty?id=${ct.id}`} className="app-cd__link" data-testid="app-crm-contact">
              {`${ct.first_name || ''} ${ct.last_name || ''}`.trim() || ct.email || `#${ct.id}`} →
            </Link>
          ))}
        </div>
      ) : null}
      {companies.length > 0 ? (
        <div className="app-cd__section">
          <div className="app-cd__label">Firmy ({companies.length})</div>
          {companies.map((co) => (
            <Link key={co.id} to={`/firmy?ico=${encodeURIComponent(co.ico)}`} className="app-cd__link" data-testid="app-crm-company">
              {co.name || co.ico} →
            </Link>
          ))}
        </div>
      ) : null}
      {vehicles.length > 0 ? (
        <div className="app-cd__section" data-testid="app-crm-vehicles">
          <div className="app-cd__label">Nabízená vozidla ({vehicles.length})</div>
          {vehicles.map((v) => {
            const sm = stageMeta(v.status)
            const price = bestPrice(v)
            return (
              <Link key={v.id} to={`/vozidla?id=${v.id}`} className="app-cd__vehicle" data-testid="app-crm-vehicle">
                <div className="app-cd__vehrow">
                  <span className="app-cd__vehtitle">{vehicleTitle(v)}</span>
                  <span className="app-tag" style={{ color: sm.fg, background: sm.bg }}>{sm.label}</span>
                </div>
                {(price || v.mileage_km) ? (
                  <div className="app-cd__vehmeta">
                    {price ? `${price.kind} ${formatEur(price.amount)}` : ''}
                    {price && v.mileage_km ? ' · ' : ''}
                    {v.mileage_km ? `${fmtN(v.mileage_km)} km` : ''}
                  </div>
                ) : null}
              </Link>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export default function Crm() {
  const [params, setParams] = useSearchParams()
  const activeId = params.get('id')
  const q = params.get('q') || ''
  const [draft, setDraft] = useState(q)

  // Facet filters (parity with ChipGroups) + pagination — local state, reset
  // to page 0 whenever the result set changes (q / filter toggle).
  const [statusF, setStatusF] = useState([])
  const [relF, setRelF] = useState([])
  const [hasEmail, setHasEmail] = useState(null)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => {
      // Read the LIVE url at fire-time (not the captured `params`) so a change
      // made during the debounce window — e.g. clicking a row to set ?id — isn't
      // clobbered by this stale snapshot.
      const next = new URLSearchParams(window.location.search)
      if (draft) next.set('q', draft); else next.delete('q')
      setParams(next, { replace: true })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  // Pipeline summary + import freshness — independent feeds (own poll cadence)
  // so the directory's 45s poll doesn't drag them; mirrors v1's parallel stats.
  const statsRes = useResource('/api/crm/clients/stats', { pollMs: 60_000, pauseHidden: true })
  const freshRes = useResource('/api/crm/clients/freshness')

  const listUrl = (() => {
    const p = new URLSearchParams()
    p.set('limit', String(LIST_LIMIT))
    p.set('offset', String(offset))
    if (q) p.set('search', q)
    statusF.forEach((s) => p.append('status', s))
    relF.forEach((r) => p.append('relationship', r))
    if (hasEmail === true) p.set('has_email', '1')
    return `/api/crm/clients?${p.toString()}`
  })()
  const list = useResource(listUrl, { pollMs: 45_000, pauseHidden: true })
  const rows = list.data?.rows || []
  const total = list.data?.total || 0
  const facets = list.data?.facets || { status: [], relationship: [] }

  const hasFilters = !!q || statusF.length > 0 || relF.length > 0 || hasEmail === true

  // Stat strip cells: Celkem + one calm cell per non-empty status (parity with
  // PageStatStrip), coloured via the shared crmStatusMeta palette.
  const stats = statsRes.data
  const statsReady = statsRes.status === 'ok' && !!stats
  const statusCells = stats
    ? Object.entries(stats.by_status || {})
        .filter(([k, v]) => k && k !== 'null' && v > 0)
        .sort((a, b) => b[1] - a[1])
    : []

  // Import-freshness indicator (the CRM-wide staleness signal shows as a
  // banner). Per-client last-activity already lives in the detail card.
  const fresh = freshRes.data
  let freshLabel = null, freshStale = false
  if (fresh) {
    if (fresh.never_imported) { freshLabel = 'CRM nikdy neimportován'; freshStale = true }
    else if (fresh.is_stale) { freshLabel = `CRM data stará ${fresh.days_stale} dní`; freshStale = true }
    else { freshLabel = 'CRM data aktuální' }
  }

  const statusOptions = (facets.status || []).map((f) => ({ value: f.value, label: crmStatusMeta(f.value)?.label || f.value, count: f.count }))
  const relOptions = (facets.relationship || []).map((f) => ({ value: f.value, label: relationshipLabel(f.value) || f.value, count: f.count }))

  const page = Math.floor(offset / LIST_LIMIT) + 1
  const pages = Math.max(1, Math.ceil(Math.max(0, total) / LIST_LIMIT))

  const open = (id) => { const n = new URLSearchParams(params); n.set('id', String(id)); setParams(n) }
  // Filter / search mutations reset to the first page (the result set changed).
  const toggle = (arr, setter, v) => { setOffset(0); setter(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]) }
  const onSearch = (v) => { setOffset(0); setDraft(v) }
  const onHasEmail = () => { setOffset(0); setHasEmail(hasEmail === true ? null : true) }
  const resetAll = () => {
    setStatusF([]); setRelF([]); setHasEmail(null); setOffset(0); setDraft('')
    const n = new URLSearchParams(window.location.search); n.delete('q'); setParams(n, { replace: true })
  }
  const refreshAll = () => { list.refresh?.(); statsRes.refresh?.(); freshRes.refresh?.() }

  return (
    <div className="app-crm-page" data-testid="app-crm-page">
      <div className="app-crm__head">
        <div>
          <h1 className="app-crm__title">CRM klienti</h1>
          {freshLabel ? (
            <span className={`app-crm__sub${freshStale ? ' app-crm__sub--warn' : ''}`} data-testid="app-crm-freshness">{freshLabel}</span>
          ) : list.loadedAt ? (
            <span className="app-crm__sub">Aktualizováno {relativeCs(list.loadedAt)}</span>
          ) : null}
        </div>
        <button type="button" className="app-crm__refresh" onClick={refreshAll}
          disabled={list.status === 'loading'} data-testid="app-crm-refresh" title="Obnovit">
          <RefreshCw size={15} /> Obnovit
        </button>
      </div>

      {/* Pipeline stat strip — mirrors Upozorneni / DedupGuard stat cells. */}
      <div className="app-crm__stats" data-testid="app-crm-stats">
        <div className="app-cstat">
          <div className="app-cstat__n">{statsReady ? fmtN(stats.total) : '—'}</div>
          <div className="app-cstat__l">Celkem</div>
        </div>
        {statusCells.map(([k, v]) => (
          <div className="app-cstat" key={k}>
            <div className="app-cstat__n" style={{ color: crmStatusMeta(k)?.fg }}>{fmtN(v)}</div>
            <div className="app-cstat__l">{crmStatusMeta(k)?.label || k}</div>
          </div>
        ))}
      </div>

      {/* Facet filters — status / vztah / má e-mail (parity with ChipGroups). */}
      {(statusOptions.length > 0 || relOptions.length > 0) ? (
        <div className="app-crm__filters" data-testid="app-crm-filters">
          {statusOptions.length > 0 ? (
            <div className="app-crm__fgroup">
              <span className="app-crm__flabel">Stav</span>
              {statusOptions.map((o) => (
                <button key={o.value} type="button" className="app-chip-toggle"
                  aria-pressed={statusF.includes(o.value)} data-testid="app-crm-status-filter"
                  onClick={() => toggle(statusF, setStatusF, o.value)}>
                  {o.label}<span className="app-crm__fcount">{o.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {relOptions.length > 0 ? (
            <div className="app-crm__fgroup">
              <span className="app-crm__flabel">Vztah</span>
              {relOptions.map((o) => (
                <button key={o.value} type="button" className="app-chip-toggle"
                  aria-pressed={relF.includes(o.value)} data-testid="app-crm-rel-filter"
                  onClick={() => toggle(relF, setRelF, o.value)}>
                  {o.label}<span className="app-crm__fcount">{o.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          <button type="button" className="app-chip-toggle" aria-pressed={hasEmail === true}
            data-testid="app-crm-hasemail" onClick={onHasEmail}>
            S e-mailem
          </button>
          {hasFilters ? (
            <button type="button" className="app-crm__reset" data-testid="app-crm-reset" onClick={resetAll}>
              Zrušit filtry
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="app-crm" data-testid="app-crm">
        <div className="app-crm__list">
          <div className="app-crm__search">
            <input value={draft} onChange={(e) => onSearch(e.target.value)}
              placeholder="Hledat klienta, IČO, e-mail…" data-testid="app-crm-search" />
          </div>
          <div className="app-crm__rows">
            {list.status === 'loading' && rows.length === 0 ? (
              <>{[0, 1, 2, 3, 4].map((i) => <div className="app-skeleton-row" key={i} />)}</>
            ) : list.status === 'error' ? (
              <div className="app-empty" data-testid="app-crm-list-error"><div className="app-empty__title">Nepodařilo se načíst</div><div>{list.error}</div></div>
            ) : rows.length === 0 ? (
              <EmptySearch
                testid="app-crm-list-empty"
                title={hasFilters ? 'Nic neodpovídá' : 'Žádní klienti'}
                hint={hasFilters ? 'Žádný klient neodpovídá filtrům.' : 'CRM kniha je prázdná.'}
                action={hasFilters ? { onClick: resetAll, label: 'Zrušit filtry' } : undefined}
              />
            ) : (
              rows.map((c) => <Row key={c.id} c={c} active={String(c.id) === activeId} onOpen={open} />)
            )}
          </div>
          <div className="app-crm__pager" data-testid="app-crm-pager">
            <span>{list.status === 'loading' && !list.data ? 'Načítám…' : `${fmtN(total)} klientů`}</span>
            {pages > 1 ? (
              <div className="app-crm__pagerbtns">
                <button type="button" className="app-crm__pagebtn" data-testid="app-crm-prev"
                  disabled={offset === 0} aria-label="Předchozí strana"
                  onClick={() => setOffset(Math.max(0, offset - LIST_LIMIT))}>
                  <ChevronLeft size={15} />
                </button>
                <span>{page}/{pages}</span>
                <button type="button" className="app-crm__pagebtn" data-testid="app-crm-next"
                  disabled={offset + LIST_LIMIT >= total} aria-label="Další strana"
                  onClick={() => setOffset(offset + LIST_LIMIT)}>
                  <ChevronRight size={15} />
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <DetailAside id={activeId} />
      </div>
    </div>
  )
}
