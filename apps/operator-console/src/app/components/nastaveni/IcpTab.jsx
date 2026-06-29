import { useState, useMemo } from 'react'
import { Plus, Trash2, Save, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { useToast } from '../../../components/Toast'

// Nastavení → ICP sektory tab. Clean rebuild of
// src/components/settings/SettingsIcpTab.jsx on the frame.
//   GET    /api/icp-sectors        — target + anti_target sectors
//   PATCH  /api/icp-sectors/:id    — weight/name/nace_prefixes/active (x-actor)
//   POST   /api/icp-sectors        — add sector (x-actor)
//   DELETE /api/icp-sectors/:id    — soft-delete (x-actor)
// NOTE: ICP mutations carry NO X-Confirm-Send — the BFF route is explicitly not
// a send-path endpoint (icpSectors.js). The header is x-actor only.

const ICP_API = '/api/icp-sectors'

function parsePrefixes(raw) {
  if (Array.isArray(raw)) return raw
  if (!raw) return []
  return String(raw).split(',').map((p) => p.trim()).filter(Boolean)
}
function prefixStr(arr) { return Array.isArray(arr) ? arr.join(', ') : (arr || '') }

// ── Add-sector modal (immediate POST — cannot batch a create) ──────────────
function AddSectorModal({ defaultKind, onClose, onAdded }) {
  const toast = useToast()
  const [form, setForm] = useState({
    code: '', name: '', kind: defaultKind || 'target',
    nace_prefixes: '', weight: defaultKind === 'anti_target' ? 0 : 10,
  })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }))

  const submit = async (e) => {
    e.preventDefault()
    setErr(null)
    setSaving(true)
    try {
      const r = await fetch(ICP_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-actor': 'operator-ui' },
        body: JSON.stringify({
          code: form.code.trim(), name: form.name.trim(), kind: form.kind,
          nace_prefixes: parsePrefixes(form.nace_prefixes), weight: Number(form.weight),
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      toast(`Sektor „${data.code}" přidán`, 'ok')
      onAdded()
      onClose()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-nast-modal" role="dialog" aria-modal="true" aria-label="Přidat sektor" onClick={onClose} data-testid="app-nastaveni-icp-modal">
      <form className="app-nast-modal__panel" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3 className="app-nast-modal__title">Přidat sektor</h3>
        {err ? <div className="app-nast-modal__err"><AlertTriangle size={13} /> {err}</div> : null}
        <label className="app-nast-modal__label">Kód (identifikátor)
          <input className="app-nast-input" required value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="např. mining_coal" />
        </label>
        <label className="app-nast-modal__label">Název
          <input className="app-nast-input" required value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="např. Uhelné doly" />
        </label>
        <label className="app-nast-modal__label">Druh
          <select className="app-nast-input" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="target">target — cílový sektor</option>
            <option value="anti_target">anti_target — blokující sektor</option>
          </select>
        </label>
        <label className="app-nast-modal__label">NACE prefixy (čárkou oddělené)
          <input className="app-nast-input" value={form.nace_prefixes} onChange={(e) => set('nace_prefixes', e.target.value)} placeholder="např. 05, 06, 07" />
        </label>
        <label className="app-nast-modal__label">Váha (0–100)
          <input className="app-nast-input" type="number" min={0} max={100} value={form.weight} onChange={(e) => set('weight', e.target.value)} />
        </label>
        <div className="app-nast-modal__actions">
          <button type="button" className="app-nast-ghost" onClick={onClose} disabled={saving}>Zrušit</button>
          <button type="submit" className="app-nast-save" disabled={saving}>{saving ? 'Ukládám…' : 'Přidat sektor'}</button>
        </div>
      </form>
    </div>
  )
}

// ── One sector section (target | anti_target) ──────────────────────────────
function SectorSection({ title, kind, sectors, drafts, setDraft, onDelete, onAdd }) {
  return (
    <section className="app-nast-card">
      <div className="app-nast-section-head">
        <h2 className="app-nast-section-title">{title} <span className="app-nast-count">({sectors.length})</span></h2>
        <button type="button" className="app-nast-ghost" onClick={() => onAdd(kind)} data-testid={`app-nastaveni-icp-add-${kind}`}>
          <Plus size={13} /> Přidat
        </button>
      </div>
      {sectors.length === 0 ? (
        <div className="app-nast-emptyline">Žádné sektory v této kategorii.</div>
      ) : (
        <div className="app-nast-table" role="table">
          <div className="app-nast-tr app-nast-tr--head" role="row">
            <span>Kód</span><span>Název</span><span>Váha</span><span>NACE prefixy</span><span>Aktivní</span><span />
          </div>
          {sectors.map((s) => {
            const d = drafts[s.id] || {}
            const name = 'name' in d ? d.name : s.name
            const weight = 'weight' in d ? d.weight : s.weight
            const pfx = 'nace_prefixes' in d ? d.nace_prefixes : prefixStr(s.nace_prefixes)
            const active = 'active' in d ? d.active : s.active
            return (
              <div className={`app-nast-tr${!active ? ' app-nast-tr--off' : ''}`} role="row" key={s.id} data-testid="app-nastaveni-icp-row" style={{ gridArea: undefined }}>
                <span className="app-nast-code" title={s.code} style={{ gridArea: 'code' }}>{s.code}</span>
                <input className="app-nast-input" value={name} onChange={(e) => setDraft(s.id, 'name', e.target.value)} style={{ gridArea: 'name' }} aria-label={`Název ${s.code}`} />
                <input className="app-nast-input app-nast-input--num" type="number" min={0} max={100} value={weight} onChange={(e) => setDraft(s.id, 'weight', e.target.value)} style={{ gridArea: 'weight', width: '100%' }} aria-label={`Váha ${s.code}`} />
                <input className="app-nast-input" value={pfx} onChange={(e) => setDraft(s.id, 'nace_prefixes', e.target.value)} placeholder="—" style={{ gridArea: 'pfx' }} aria-label={`NACE prefixy ${s.code}`} />
                <label className="app-nast-check" style={{ gridArea: 'active' }}>
                  <input type="checkbox" checked={!!active} onChange={(e) => setDraft(s.id, 'active', e.target.checked)} aria-label={`Aktivní ${s.code}`} />
                </label>
                <button type="button" className="app-nast-iconbtn app-nast-iconbtn--danger" title="Smazat" onClick={() => onDelete(s)} style={{ gridArea: 'del' }} aria-label={`Smazat ${s.code}`}>
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

export default function IcpTab() {
  const toast = useToast()
  const res = useResource(ICP_API, { initialData: [] })
  const sectors = Array.isArray(res.data) ? res.data : []

  const [drafts, setDrafts] = useState({}) // id -> { name?, weight?, nace_prefixes?(string), active? }
  const [saving, setSaving] = useState(false)
  const [modalKind, setModalKind] = useState(null)

  const setDraft = (id, field, value) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }))

  const isChanged = (s) => {
    const d = drafts[s.id]
    if (!d) return false
    if ('name' in d && d.name !== s.name) return true
    if ('weight' in d && String(d.weight) !== String(s.weight)) return true
    if ('active' in d && d.active !== s.active) return true
    if ('nace_prefixes' in d && d.nace_prefixes !== prefixStr(s.nace_prefixes)) return true
    return false
  }
  const changed = useMemo(() => sectors.filter(isChanged), [sectors, drafts])
  const dirty = changed.length > 0

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    let okCount = 0
    try {
      for (const s of changed) {
        const d = drafts[s.id]
        const payload = {}
        if ('name' in d) payload.name = String(d.name).trim()
        if ('weight' in d) payload.weight = Number(d.weight)
        if ('active' in d) payload.active = !!d.active
        if ('nace_prefixes' in d) payload.nace_prefixes = parsePrefixes(d.nace_prefixes)
        const r = await fetch(`${ICP_API}/${s.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-actor': 'operator-ui' },
          body: JSON.stringify(payload),
        })
        if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `HTTP ${r.status}`) }
        okCount++
      }
      toast(`Uloženo (${okCount} sektorů)`, 'ok')
      setDrafts({})
      res.refresh?.()
    } catch (e) {
      toast(`Chyba uložení: ${e.message || 'zkus to znovu'}`, 'err')
      res.refresh?.()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (s) => {
    if (!window.confirm(`Smazat sektor „${s.code}"? (soft-delete, lze obnovit)`)) return
    try {
      const r = await fetch(`${ICP_API}/${s.id}`, { method: 'DELETE', headers: { 'x-actor': 'operator-ui' } })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      toast(`Sektor „${s.code}" smazán`, 'ok')
      setDrafts((prev) => { const n = { ...prev }; delete n[s.id]; return n })
      res.refresh?.()
    } catch (e) {
      toast(`Chyba: ${e.message || 'zkus to znovu'}`, 'err')
    }
  }

  const state = res.status === 'error' ? 'error'
    : (res.status === 'loading' || res.status === 'idle') && sectors.length === 0 ? 'loading'
      : 'ok'

  const targets = sectors.filter((s) => s.kind === 'target')
  const antis = sectors.filter((s) => s.kind === 'anti_target')

  return (
    <div className="app-nast-panel" data-testid="app-nastaveni-icp">
      {state === 'error' ? (
        <div className="app-empty" data-testid="app-nastaveni-icp-error">
          <div className="app-empty__title">Nepodařilo se načíst sektory</div>
          <div>{res.error}</div>
        </div>
      ) : state === 'loading' ? (
        <div className="app-nast-card">{[0, 1, 2, 3].map((i) => <div className="app-nast-skel" key={i} />)}</div>
      ) : (
        <>
          <p className="app-nast-note">Classifier načítá sektory s TTL 5 minut — změna se projeví nejpozději do 5 minut bez nasazení. Mazání je soft-delete (řádek zůstává pro audit).</p>
          <SectorSection title="Cílové sektory (target)" kind="target" sectors={targets} drafts={drafts} setDraft={setDraft} onDelete={remove} onAdd={setModalKind} />
          <SectorSection title="Blokující sektory (anti_target)" kind="anti_target" sectors={antis} drafts={drafts} setDraft={setDraft} onDelete={remove} onAdd={setModalKind} />

          <div className="app-nast-actionbar">
            <span className="app-nast-actionbar__hint">
              {dirty ? `${changed.length} upravených sektorů` : <><CheckCircle2 size={13} /> Vše uloženo</>}
            </span>
            <button
              type="button"
              className="app-nast-save"
              data-testid="app-nastaveni-save-icp"
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? <RefreshCw size={14} className="app-nast-spin" /> : <Save size={14} />}
              {saving ? 'Ukládám…' : 'Uložit změny'}
            </button>
          </div>
        </>
      )}

      {modalKind ? <AddSectorModal defaultKind={modalKind} onClose={() => setModalKind(null)} onAdded={() => res.refresh?.()} /> : null}
    </div>
  )
}
