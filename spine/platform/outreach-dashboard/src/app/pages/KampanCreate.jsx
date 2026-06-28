import { useState, useMemo, useEffect } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Plus, Trash2, Users, ListOrdered, FileText, AlertTriangle, X, Rocket } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import './app-kampan-detail.css'

// Nová kampaň — create flow on the Antique Alchemist frame. Reuses the
// detail page's .kd-* design system. POSTs to /api/campaigns (Go-proxied;
// enrolls contacts), then redirects to the new campaign's detail (draft) where
// pacing / send-window / staircase get tuned. Subject/message text lives in
// Šablony — picked per sequence step here. docs/initiatives — campaign editor.

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0)

export default function KampanCreate() {
  const navigate = useNavigate()
  const toast = useToast()
  const [params] = useSearchParams()
  // Firmy → "Spustit kampaň" carries the selection as ?prefilled_companies=ico,ico.
  // Surface the carried count + pass the IČO through rather than silently dropping
  // them (the old behaviour). NOTE: per-company scoping of the estimate/audience
  // needs BFF + Go support — the BFF hard-codes the Go create payload (category-
  // scoped) today, so the live estimate stays category-driven. See PR notes.
  const prefilledIcos = useMemo(
    () => (params.get('prefilled_companies') || '').split(',').map((s) => s.trim()).filter(Boolean),
    [params],
  )
  const tplRes = useResource('/api/templates', { pollMs: 0, parse: (r) => (Array.isArray(r) ? r : (r?.templates || r?.rows || [])) })
  const templates = tplRes.status === 'ok' ? tplRes.data : []
  const tplNames = templates.map((t) => t.name)

  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [paths, setPaths] = useState([])
  const [match, setMatch] = useState('prefix')
  const [draft, setDraft] = useState('')
  const [steps, setSteps] = useState([
    { step: 0, delay_days: 0, template: '' },
    { step: 1, delay_days: 5, template: '' },
    { step: 2, delay_days: 12, template: '' },
  ])
  const [busy, setBusy] = useState(false)

  // Default each step's template to the first available once templates load.
  useEffect(() => {
    if (tplNames.length && steps.every((s) => !s.template)) {
      setSteps((arr) => arr.map((s) => ({ ...s, template: tplNames[0] })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tplRes.status])

  // Live audience estimate (id ignored when category_paths query is present).
  const estUrl = useMemo(
    () => `/api/campaigns/0/estimate?category_paths=${encodeURIComponent(JSON.stringify(paths))}&category_match=${match}`,
    [paths, match],
  )
  const est = useResource(estUrl, { pollMs: 0, parse: (r) => r })
  const count = est.status === 'ok' ? Number(est.data?.count ?? 0) : null

  const addPath = () => { const v = draft.trim(); if (v && !paths.includes(v)) setPaths((p) => [...p, v]); setDraft('') }
  const setStep = (i, patch) => setSteps((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const addStep = () => setSteps((arr) => [...arr, { step: arr.length, delay_days: arr.length === 0 ? 0 : 3, template: tplNames[0] || '' }])
  // Renumber after removal; force delay_days=0 for the new first step — it
  // inherits its predecessor's offset otherwise, leaving a non-zero delay the UI
  // hides behind the "ihned"/"(start)" label (and the disabled day input).
  const removeStep = (i) => setSteps((arr) => arr.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step: idx, delay_days: idx === 0 ? 0 : s.delay_days })))

  // Strictly increasing — the warning ("Rozestupy musí růst") promises growth,
  // and delay_days is an absolute offset from start, so two equal delays would
  // fire two follow-ups on the same day to the same contact.
  const monotonic = steps.every((s, i) => i === 0 || Number(s.delay_days) > Number(steps[i - 1].delay_days))
  const allTpl = steps.length > 0 && steps.every((s) => s.template && tplNames.includes(s.template))
  const valid = name.trim().length >= 2 && steps.length >= 1 && steps.length <= 10 && monotonic && allTpl

  const create = async () => {
    if (!valid || busy) return
    setBusy(true)
    try {
      const r = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: desc,
          category_paths: paths,
          category_match: match,
          // Pass the Firmy selection through (forward-compatible; the BFF
          // currently scopes by category — see prefilledIcos note above).
          ...(prefilledIcos.length > 0 ? { company_icos: prefilledIcos } : {}),
          steps: steps.map((s, idx) => ({ step: idx, delay_days: Number(s.delay_days) || 0, template: s.template })),
        }),
      })
      const text = await r.text()
      let json = null
      try { json = text ? JSON.parse(text) : null } catch { json = text }
      if (!r.ok) {
        if (r.status === 503) throw new Error('Go orchestrator není dostupný — kampaň nelze vytvořit (zkus za chvíli).')
        throw new Error((json && (json.message || json.error)) || `HTTP ${r.status}`)
      }
      toast('Kampaň vytvořena (koncept)', 'ok')
      const id = json?.id ?? json?.campaign?.id
      navigate(id ? `/kampane/${id}` : '/kampane')
    } catch (e) {
      toast(`Chyba: ${e.message}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kd" data-testid="app-kampan-create">
      <Link to="/kampane" className="kd-link kd-back"><ArrowLeft size={14} /> Kampaně</Link>
      <header className="kd-hero">
        <div className="kd-hero__main">
          <h1 className="kd-hero__name">Nová kampaň</h1>
        </div>
      </header>

      <div className="kd-stack">
        {/* Identity */}
        <section className="kd-card" data-testid="kc-identity">
          <div className="kd-card__head"><div className="kd-card__title"><FileText size={16} /> <span>Identita</span></div></div>
          <div className="kd-card__body kd-form">
            <label className="kd-field">
              <span>Název kampaně *</span>
              <input className="kd-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Např. Strojírenství — výkup techniky" data-testid="kc-name" autoFocus />
            </label>
            <label className="kd-field">
              <span>Popis</span>
              <textarea className="kd-input kd-textarea" value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="Volitelný interní popis…" />
            </label>
          </div>
        </section>

        {/* Audience */}
        <section className="kd-card" data-testid="kc-audience">
          <div className="kd-card__head"><div className="kd-card__title"><Users size={16} /> <span>Publikum</span></div></div>
          <div className="kd-card__hint">Bez kategorií = všechny aktivní firmy z registru.</div>
          <div className="kd-card__body kd-form">
            <div className="kd-field">
              <span>Cílové kategorie ({paths.length})</span>
              <div className="kd-chips">
                {paths.map((p) => (
                  <span className="kd-chip" key={p}>{p}<button type="button" onClick={() => setPaths((a) => a.filter((x) => x !== p))} aria-label={`Odebrat ${p}`}><X size={12} /></button></span>
                ))}
                {paths.length === 0 ? <span className="kd-muted">Bez filtru</span> : null}
              </div>
              <div className="kd-chip-add">
                <input className="kd-input" value={draft} placeholder="Přidat kategorii + Enter…" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPath() } }} data-testid="kc-audience-input" />
                <button type="button" className="kd-btn kd-btn--ghost" onClick={addPath} aria-label="Přidat kategorii"><Plus size={14} /></button>
              </div>
            </div>
            <div className="kd-field">
              <span>Režim shody</span>
              <div className="kd-seg">
                <button type="button" className={match === 'prefix' ? 'on' : ''} onClick={() => setMatch('prefix')}>Prefix</button>
                <button type="button" className={match === 'exact' ? 'on' : ''} onClick={() => setMatch('exact')}>Přesně</button>
              </div>
            </div>
            <div className="kd-estimate" data-testid="kc-estimate"><Users size={14} /><span>Odhad: <strong>{count == null ? '…' : fmt(count)}</strong> firem</span></div>
            {prefilledIcos.length > 0 ? (
              <div className="kd-estimate" data-testid="kc-prefilled"><Users size={14} /><span>Z výběru ve Firmách: <strong>{fmt(prefilledIcos.length)}</strong> firem — odešle se s kampaní.</span></div>
            ) : null}
          </div>
        </section>

        {/* Sequence */}
        <section className="kd-card" data-testid="kc-sequence">
          <div className="kd-card__head"><div className="kd-card__title"><ListOrdered size={16} /> <span>Sekvence</span></div></div>
          <div className="kd-card__hint">Vyber šablonu pro každý krok. Text e-mailu se píše v Šablonách.</div>
          <div className="kd-card__body kd-form">
            {tplNames.length === 0 ? (
              <div className="kd-warn"><AlertTriangle size={13} /> Nejdřív vytvoř aspoň jednu <Link to="/sablony" className="kd-link">šablonu</Link>.</div>
            ) : (
              <>
                <div className="kd-steps">
                  {steps.map((s, i) => (
                    <div className="kd-step" key={i} data-testid="kc-step">
                      <div className="kd-step__ord">{i + 1}.</div>
                      <label className="kd-step__f">
                        <span>Šablona</span>
                        <select className="kd-input" value={s.template || ''} onChange={(e) => setStep(i, { template: e.target.value })} data-testid="kc-step-template">
                          <option value="" disabled>— vyber —</option>
                          {tplNames.map((n) => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </label>
                      <label className="kd-step__f kd-step__f--narrow">
                        <span>Po {i === 0 ? '(start)' : 'dnech'}</span>
                        <input className="kd-input" type="number" min={0} max={90} value={s.delay_days ?? 0} onChange={(e) => setStep(i, { delay_days: e.target.value })} disabled={i === 0} />
                      </label>
                      <div className="kd-step__btns">
                        <button type="button" className="kd-icon kd-icon--danger" onClick={() => removeStep(i)} disabled={steps.length <= 1} aria-label="Odebrat krok"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
                {steps.length < 10 ? <button type="button" className="kd-btn kd-btn--ghost" onClick={addStep} data-testid="kc-add-step"><Plus size={14} /> Přidat krok</button> : null}
                {!monotonic ? <div className="kd-warn"><AlertTriangle size={13} /> Rozestupy musí růst.</div> : null}
              </>
            )}
          </div>
        </section>
      </div>

      <div className="kd-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="kd-btn kd-btn--primary" onClick={create} disabled={!valid || busy} data-testid="kc-create">
          <Rocket size={15} /> {busy ? 'Vytvářím…' : 'Vytvořit kampaň (koncept)'}
        </button>
        <Link to="/kampane" className="kd-btn kd-btn--ghost">Zrušit</Link>
      </div>
    </div>
  )
}
