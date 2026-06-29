import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Layers, Plus, RefreshCw, Send, Trash2 } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { relativeCs } from '../lib/replyMeta'
import { useToast } from '../../components/Toast'
import Empty from '../components/Empty'
import './app-segmenty.css'

// Segmenty — saved-filter (segment) list on the antique-alchemist frame.
// Clean rebuild of the Segments page (src/pages/Segments.jsx) against the
// SAME BFF endpoints. This surface only LISTS saved segments + offers per-row
// actions; the segment BUILDER (create/edit via QueryBuilder) is its own route
// /segmenty/novy (a sibling page). Port P? — dashboard unification .
//
// Endpoints:
//   GET    /api/segments              — list (id,name,description,query,company_count,created_at)
//   POST   /api/segments/:id/rebuild  — recompute membership + company_count
//   DELETE /api/segments/:id          — delete (operator confirm)
//
// Per-row actions:
//   · Do kampaně  → /kampane/nova?segment=<id> (link carries the segment id;
//     the create page does not yet consume it — deferred feature wiring.
//     A segment is a query tree, not a category_paths list, so prefilling the
//     create form needs a build-campaign-from-segment path that doesn't exist yet)
//   · Přepočítat  → POST .../rebuild (refresh membership + count, then re-GET)
//   · Smazat      → DELETE (window.confirm gate, like v1)
//
// Dropped vs v1: the QueryBuilder create/edit modal, clone, live preview count,
// the detail drawer, and the stale-badge — all of those belong to the builder
// surface (/segmenty/novy) or depend on the QueryBuilder lib / a
// last_built_at field the list endpoint does not return. No imports.

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0)

// Calm one-line filter summary derived from the RAW query JSON — avoids the
// QueryBuilder dependency. The full human-readable breakdown lives on the
// builder page; here we only hint at the filter's shape.
function filterSummary(query) {
  const conds = Array.isArray(query?.conditions) ? query.conditions.length : 0
  if (!conds) return 'Bez filtru — všechny firmy'
  const noun = conds === 1 ? 'podmínka' : conds < 5 ? 'podmínky' : 'podmínek'
  return `${conds} ${noun}`
}

export default function Segmenty() {
  const toast = useToast()
  const feed = useResource('/api/segments')
  // `${id}:${op}` while a single mutation is in flight (disables just that row's button).
  const [busy, setBusy] = useState(null)

  const segments = Array.isArray(feed.data) ? feed.data : []
  const totalCompanies = segments.reduce((sum, s) => sum + (Number(s.company_count) || 0), 0)
  const emptyCount = segments.filter((s) => !(Number(s.company_count) > 0)).length

  const rebuild = async (seg) => {
    setBusy(`${seg.id}:rebuild`)
    try {
      const r = await fetch(`/api/segments/${seg.id}/rebuild`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const res = await r.json()
      const n = res.companies ?? res.segment?.company_count ?? 0
      toast(`Přepočítáno — ${fmt(n)} firem`, 'ok')
      feed.refresh?.()
    } catch (e) {
      toast(`Přepočet selhal: ${e.message || 'zkus to znovu'}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (seg) => {
    if (!window.confirm(`Smazat segment „${seg.name}“?`)) return
    setBusy(`${seg.id}:delete`)
    try {
      const r = await fetch(`/api/segments/${seg.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      toast('Segment smazán', 'ok')
      feed.refresh?.()
    } catch (e) {
      toast(`Mazání selhalo: ${e.message || 'zkus to znovu'}`, 'err')
    } finally {
      setBusy(null)
    }
  }

  const statCells = [
    { l: 'Segmentů', v: segments.length },
    { l: 'Firem celkem', v: fmt(totalCompanies) },
    { l: 'Prázdné', v: emptyCount, tone: emptyCount > 0 ? 'warn' : null, title: 'Segmenty s 0 firmami — zvaž přepočet' },
  ]

  return (
    <div className="app-segmenty" data-testid="app-segmenty">
      <div className="app-segmenty__head">
        <div>
          <h1 className="app-segmenty__title">Segmenty</h1>
          <span className="app-segmenty__sub">
            Uložené filtry firem — cílové skupiny pro kampaně
            {feed.loadedAt ? ` · aktualizováno ${relativeCs(feed.loadedAt)}` : ''}
          </span>
        </div>
        <div className="app-segmenty__head-actions">
          <button type="button" className="app-segmenty__refresh" onClick={() => feed.refresh?.()}
            disabled={feed.status === 'loading'} data-testid="app-segmenty-refresh" title="Obnovit">
            <RefreshCw size={15} /> Obnovit
          </button>
          <Link to="/segmenty/novy" className="app-segmenty__new" data-testid="app-segmenty-new">
            <Plus size={15} /> Nový segment
          </Link>
        </div>
      </div>

      <div className="app-segmenty__stats" data-testid="app-segmenty-stats">
        {statCells.map((c) => (
          <div className={`app-sstat${c.tone ? ' app-sstat--' + c.tone : ''}`} key={c.l} title={c.title || undefined}>
            <div className="app-sstat__n">{feed.status === 'ok' ? c.v : '—'}</div>
            <div className="app-sstat__l">{c.l}</div>
          </div>
        ))}
      </div>

      {feed.status === 'error' ? (
        <div className="app-empty" data-testid="app-segmenty-error">
          <div className="app-empty__title">Nepodařilo se načíst</div>
          <div>{feed.error}</div>
        </div>
      ) : (feed.status === 'loading' || feed.status === 'idle') && segments.length === 0 ? (
        <div className="app-segmenty__list" data-testid="app-segmenty-loading">
          {[0, 1, 2].map((i) => <div className="app-seg-skel" key={i} />)}
        </div>
      ) : segments.length === 0 ? (
        <Empty
          icon={Layers}
          testid="app-segmenty-empty"
          title="Žádný segment"
          hint="Segment je uložený filtr firem podle kategorie, regionu, velikosti nebo skóre. Použiješ ho jako cílovou skupinu pro kampaň."
          action={{ to: '/segmenty/novy', label: 'Vytvořit segment' }}
        />
      ) : (
        <ul className="app-segmenty__list" data-testid="app-segmenty-list">
          {segments.map((seg) => {
            const rebuilding = busy === `${seg.id}:rebuild`
            const deleting = busy === `${seg.id}:delete`
            return (
              <li key={seg.id} className="app-seg" data-testid="app-segment-row">
                <div className="app-seg__icon"><Layers size={18} strokeWidth={1.7} /></div>
                <div className="app-seg__body">
                  <div className="app-seg__name" data-testid="app-segment-name">{seg.name}</div>
                  <div className="app-seg__meta">
                    <span>{filterSummary(seg.query)}</span>
                    {seg.description ? <span>· {seg.description}</span> : null}
                    {seg.created_at ? <span>· vytvořeno {relativeCs(seg.created_at)}</span> : null}
                  </div>
                </div>
                <div className="app-seg__count" title="Firem v segmentu">
                  <span className="app-seg__count-n" data-testid="app-segment-count">{fmt(seg.company_count)}</span>
                  <span className="app-seg__count-l">firem</span>
                </div>
                <div className="app-seg__actions">
                  <Link to={`/kampane/nova?segment=${seg.id}`} className="app-seg__btn app-seg__btn--primary"
                    data-testid="app-segment-use" title="Použít jako cílovou skupinu kampaně">
                    <Send size={14} /> Do kampaně
                  </Link>
                  <button type="button" className="app-seg__btn" onClick={() => rebuild(seg)}
                    disabled={rebuilding} data-testid="app-segment-rebuild" title="Přepočítat členství segmentu">
                    <RefreshCw size={14} /> {rebuilding ? '…' : 'Přepočítat'}
                  </button>
                  <button type="button" className="app-seg__btn app-seg__btn--danger" onClick={() => remove(seg)}
                    disabled={deleting} data-testid="app-segment-delete" title="Smazat segment" aria-label={`Smazat segment ${seg.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
