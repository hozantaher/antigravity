import { useState, useMemo, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, Play, Pause, Trash2, Pencil, Check, X, Plus, GripVertical,
  Users, ListOrdered, Gauge, Clock, BarChart3, AlertTriangle, FileText,
  ChevronRight, Shield, Layers,
} from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import { campaignStatusMeta, bounceRate, statTiles } from '../lib/campaignMeta'
import './app-kampan-detail.css'

// Kampaň — detail + full editor (Antique Alchemist frame). Reads
// GET /api/campaigns/:id and edits every meaningful field through the existing
// audited BFF endpoints:
//   identity/audience/staircase → PATCH /api/campaigns/:id
//   pacing                      → PUT  /api/campaigns/:id/pacing
//   send-window                 → PUT  /api/campaigns/:id/send-window
//   sequence                    → PUT  /api/campaigns/:id/sequence
//   lifecycle                   → POST /api/campaigns/:id/run | /pause
//   delete                      → DELETE /api/campaigns/:id
//
// Running-edit policy: pacing + send-window edit live; structural edits
// (audience, sequence, staircase) require a paused campaign — locked sections
// offer a one-click "Pozastavit a upravit". Subject is NOT editable here — the
// send pipeline renders subject from the template, so message text is edited in
// Šablony (/sablony). docs/initiatives — campaign editor.

const fmt = (n) => new Intl.NumberFormat('cs-CZ').format(Number(n) || 0)
const LIVE_STATUSES = ['running', 'active'] // structural edits blocked here

// campaigns.category_paths is a JSON-encoded string in a TEXT column.
function parsePaths(raw) {
  if (Array.isArray(raw)) return raw.filter((p) => typeof p === 'string')
  if (typeof raw !== 'string') return []
  const t = raw.trim()
  if (!t) return []
  if (t.startsWith('[')) { try { const a = JSON.parse(t); return Array.isArray(a) ? a.filter((p) => typeof p === 'string') : [] } catch { return [] } }
  if (t.startsWith('{') && t.endsWith('}')) return t.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
  return [t]
}
const toHHMM = (t) => (t ? String(t).slice(0, 5) : '')
const parseSeq = (raw) => (Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw || '[]') } catch { return [] } })())
const parseStaircase = (raw) => (Array.isArray(raw) ? raw : (() => { try { return JSON.parse(raw || '[]') } catch { return [] } })())

async function mutate(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!r.ok) {
    const msg = (json && (json.message || json.error || json.hint)) || `HTTP ${r.status}`
    const e = new Error(msg)
    e.status = r.status
    e.body = json
    throw e
  }
  return json
}

// ── Generic editable card ────────────────────────────────────────────────
function Card({ icon: Icon, title, hint, right, children, testid }) {
  return (
    <section className="kd-card" data-testid={testid}>
      <div className="kd-card__head">
        <div className="kd-card__title">
          {Icon ? <Icon size={16} strokeWidth={2} /> : null}
          <span>{title}</span>
        </div>
        {right}
      </div>
      {hint ? <div className="kd-card__hint">{hint}</div> : null}
      <div className="kd-card__body">{children}</div>
    </section>
  )
}

function EditBtn({ onClick, label = 'Upravit' }) {
  return (
    <button type="button" className="kd-btn kd-btn--ghost" onClick={onClick} data-testid="kd-edit">
      <Pencil size={13} /> {label}
    </button>
  )
}
function SaveCancel({ onSave, onCancel, busy, disabled }) {
  return (
    <div className="kd-actions">
      <button type="button" className="kd-btn kd-btn--ghost" onClick={onCancel} disabled={busy}>
        <X size={14} /> Zrušit
      </button>
      <button type="button" className="kd-btn kd-btn--primary" onClick={onSave} disabled={busy || disabled} data-testid="kd-save">
        <Check size={14} /> {busy ? 'Ukládám…' : 'Uložit'}
      </button>
    </div>
  )
}

// Locked notice for structural sections while the campaign is live.
function LockedNotice({ onPauseEdit, busy }) {
  return (
    <div className="kd-locked" data-testid="kd-locked">
      <Shield size={14} />
      <span>Strukturální změny vyžadují pozastavenou kampaň.</span>
      <button type="button" className="kd-btn kd-btn--ghost" onClick={onPauseEdit} disabled={busy}>
        {busy ? 'Pozastavuji…' : 'Pozastavit a upravit'}
      </button>
    </div>
  )
}

// ── Identity (name + description) — editable even while running ───────────
function IdentitySection({ c, onSaved }) {
  const toast = useToast()
  const [edit, setEdit] = useState(false)
  const [name, setName] = useState(c.name || '')
  const [desc, setDesc] = useState(c.description || '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setName(c.name || ''); setDesc(c.description || '') }, [c.name, c.description])

  const save = async () => {
    setBusy(true)
    try {
      await mutate(`/api/campaigns/${c.id}`, 'PATCH', { name: name.trim(), description: desc })
      toast('Identita uložena', 'ok'); setEdit(false); onSaved()
    } catch (e) { toast(`Chyba: ${e.message}`, 'err') } finally { setBusy(false) }
  }

  return (
    <Card icon={FileText} title="Identita" testid="kd-identity"
      right={!edit ? <EditBtn onClick={() => setEdit(true)} /> : null}>
      {edit ? (
        <div className="kd-form">
          <label className="kd-field">
            <span>Název kampaně</span>
            <input className="kd-input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-testid="kd-name" autoFocus />
          </label>
          <label className="kd-field">
            <span>Popis</span>
            <textarea className="kd-input kd-textarea" value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="Volitelný interní popis…" />
          </label>
          <SaveCancel onSave={save} onCancel={() => setEdit(false)} busy={busy} disabled={name.trim().length < 2} />
        </div>
      ) : (
        <div className="kd-readrows">
          <div className="kd-readrow"><span className="kd-k">Název</span><span className="kd-v">{c.name || '—'}</span></div>
          <div className="kd-readrow"><span className="kd-k">Popis</span><span className="kd-v">{c.description || <em className="kd-muted">bez popisu</em>}</span></div>
        </div>
      )}
    </Card>
  )
}

// ── Audience (category_paths + match) with live estimate — structural ─────
function AudienceSection({ c, locked, onPauseEdit, pauseBusy, onSaved }) {
  const toast = useToast()
  const [edit, setEdit] = useState(false)
  const [paths, setPaths] = useState(() => parsePaths(c.category_paths))
  const [match, setMatch] = useState(c.category_match === 'exact' ? 'exact' : 'prefix')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setPaths(parsePaths(c.category_paths)); setMatch(c.category_match === 'exact' ? 'exact' : 'prefix') }, [c.category_paths, c.category_match])

  // Live estimate of the CURRENT selection (preview mode of the estimate API).
  const qs = useMemo(() => {
    const p = encodeURIComponent(JSON.stringify(paths))
    return `/api/campaigns/${c.id}/estimate?category_paths=${p}&category_match=${match}`
  }, [c.id, paths, match])
  const est = useResource(edit ? qs : `/api/campaigns/${c.id}/estimate`, { pollMs: 0, parse: (r) => r })
  const count = est.status === 'ok' ? Number(est.data?.count ?? 0) : null

  const addPath = () => {
    const v = draft.trim()
    if (!v) return
    if (!paths.includes(v)) setPaths((p) => [...p, v])
    setDraft('')
  }
  const save = async () => {
    setBusy(true)
    try {
      await mutate(`/api/campaigns/${c.id}`, 'PATCH', { category_paths: paths, category_match: match })
      toast('Publikum uloženo', 'ok'); setEdit(false); onSaved()
    } catch (e) { toast(`Chyba: ${e.message}`, 'err') } finally { setBusy(false) }
  }

  const savedPaths = parsePaths(c.category_paths)
  return (
    <Card icon={Users} title="Publikum" testid="kd-audience"
      hint="Které firmy kampaň osloví — podle kategorií z registru (ARES/firmy.cz)."
      right={!edit && !locked ? <EditBtn onClick={() => setEdit(true)} /> : null}>
      {edit ? (
        <div className="kd-form">
          <div className="kd-field">
            <span>Cílové kategorie ({paths.length})</span>
            <div className="kd-chips" data-testid="kd-audience-chips">
              {paths.map((p) => (
                <span className="kd-chip" key={p}>
                  {p}
                  <button type="button" onClick={() => setPaths((arr) => arr.filter((x) => x !== p))} aria-label={`Odebrat ${p}`}><X size={12} /></button>
                </span>
              ))}
              {paths.length === 0 ? <span className="kd-muted">Bez filtru = všechny aktivní firmy</span> : null}
            </div>
            <div className="kd-chip-add">
              <input className="kd-input" value={draft} placeholder="Přidat kategorii (cesta) + Enter…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPath() } }}
                data-testid="kd-audience-input" />
              <button type="button" className="kd-btn kd-btn--ghost" onClick={addPath} aria-label="Přidat kategorii"><Plus size={14} /></button>
            </div>
          </div>
          <div className="kd-field">
            <span>Režim shody</span>
            <div className="kd-seg">
              <button type="button" className={match === 'prefix' ? 'on' : ''} onClick={() => setMatch('prefix')}>Prefix (vč. podkategorií)</button>
              <button type="button" className={match === 'exact' ? 'on' : ''} onClick={() => setMatch('exact')}>Přesně</button>
            </div>
          </div>
          <div className="kd-estimate" data-testid="kd-estimate">
            <Users size={14} />
            <span>Odhad: <strong>{count == null ? '…' : fmt(count)}</strong> firem</span>
          </div>
          <SaveCancel onSave={save} onCancel={() => setEdit(false)} busy={busy} />
        </div>
      ) : (
        <>
          {locked ? <LockedNotice onPauseEdit={() => onPauseEdit(() => setEdit(true))} busy={pauseBusy} /> : null}
          <div className="kd-readrows">
            <div className="kd-readrow">
              <span className="kd-k">Kategorie</span>
              <span className="kd-v">
                {savedPaths.length === 0 ? <em className="kd-muted">vše (bez filtru)</em> : (
                  <span className="kd-chips kd-chips--read">{savedPaths.slice(0, 8).map((p) => <span className="kd-chip kd-chip--read" key={p}>{p}</span>)}{savedPaths.length > 8 ? <span className="kd-muted">+{savedPaths.length - 8}</span> : null}</span>
                )}
              </span>
            </div>
            <div className="kd-readrow"><span className="kd-k">Režim</span><span className="kd-v">{(c.category_match || 'prefix') === 'exact' ? 'Přesně' : 'Prefix'}</span></div>
            <div className="kd-readrow"><span className="kd-k">Odhad firem</span><span className="kd-v">{count == null ? '…' : fmt(count)}</span></div>
          </div>
        </>
      )}
    </Card>
  )
}

// ── Sequence (steps: template + delay_days) — structural ──────────────────
function SequenceSection({ c, locked, onPauseEdit, pauseBusy, templates, onSaved }) {
  const toast = useToast()
  const [edit, setEdit] = useState(false)
  const [steps, setSteps] = useState(() => parseSeq(c.sequence_config))
  const [busy, setBusy] = useState(false)
  useEffect(() => { setSteps(parseSeq(c.sequence_config)) }, [c.sequence_config])

  const tplNames = templates.map((t) => t.name)
  const setStep = (i, patch) => setSteps((arr) => arr.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))
  const addStep = () => setSteps((arr) => [...arr, { step: arr.length, delay_days: arr.length === 0 ? 0 : 3, template: tplNames[0] || '' }])
  // Renumber after removal; force delay_days=0 for the new first step — it
  // inherits its predecessor's offset otherwise, leaving a non-zero delay the UI
  // hides behind the "ihned" label (and the disabled day input).
  const removeStep = (i) => setSteps((arr) => arr.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step: idx, delay_days: idx === 0 ? 0 : s.delay_days })))
  const move = (i, dir) => setSteps((arr) => {
    const j = i + dir
    if (j < 0 || j >= arr.length) return arr
    const next = arr.slice()
    ;[next[i], next[j]] = [next[j], next[i]]
    return next.map((s, idx) => ({ ...s, step: idx }))
  })

  // Strictly increasing — the warning ("Rozestupy musí růst") promises growth,
  // and delay_days is an absolute offset from start, so two equal delays would
  // fire two follow-ups on the same day to the same contact.
  const monotonic = steps.every((s, i) => i === 0 || Number(s.delay_days) > Number(steps[i - 1].delay_days))
  const allTpl = steps.every((s) => s.template && tplNames.includes(s.template))
  const valid = steps.length >= 1 && steps.length <= 10 && monotonic && allTpl

  const save = async () => {
    setBusy(true)
    try {
      const payload = steps.map((s, idx) => ({ step: idx, delay_days: Number(s.delay_days) || 0, template: s.template }))
      await mutate(`/api/campaigns/${c.id}/sequence`, 'PUT', { steps: payload })
      toast('Sekvence uložena', 'ok'); setEdit(false); onSaved()
    } catch (e) { toast(`Chyba: ${e.message}`, 'err') } finally { setBusy(false) }
  }

  const readSteps = parseSeq(c.sequence_config)
  return (
    <Card icon={ListOrdered} title="Sekvence" testid="kd-sequence"
      hint="Pořadí e-mailů a rozestupy. Text e-mailu se edituje v Šablonách."
      right={!edit && !locked ? <EditBtn onClick={() => setEdit(true)} /> : null}>
      {edit ? (
        <div className="kd-form">
          <div className="kd-steps">
            {steps.map((s, i) => (
              <div className="kd-step" key={i} data-testid="kd-step">
                <div className="kd-step__ord"><GripVertical size={14} className="kd-muted" /> {i + 1}.</div>
                <label className="kd-step__f">
                  <span>Šablona</span>
                  <select className="kd-input" value={s.template || ''} onChange={(e) => setStep(i, { template: e.target.value })} data-testid="kd-step-template">
                    <option value="" disabled>— vyber šablonu —</option>
                    {tplNames.map((n) => <option key={n} value={n}>{n}</option>)}
                    {s.template && !tplNames.includes(s.template) ? <option value={s.template}>{s.template} (chybí!)</option> : null}
                  </select>
                </label>
                <label className="kd-step__f kd-step__f--narrow">
                  <span>Po {i === 0 ? '(start)' : 'dnech'}</span>
                  <input className="kd-input" type="number" min={0} max={90} value={s.delay_days ?? 0} onChange={(e) => setStep(i, { delay_days: e.target.value })} disabled={i === 0} />
                </label>
                <div className="kd-step__btns">
                  <button type="button" className="kd-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Nahoru">↑</button>
                  <button type="button" className="kd-icon" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Dolů">↓</button>
                  <button type="button" className="kd-icon kd-icon--danger" onClick={() => removeStep(i)} disabled={steps.length <= 1} aria-label="Odebrat krok"><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
          {steps.length < 10 ? (
            <button type="button" className="kd-btn kd-btn--ghost" onClick={addStep} data-testid="kd-add-step"><Plus size={14} /> Přidat krok</button>
          ) : null}
          <div className="kd-seq-foot">
            <Link to="/sablony" className="kd-link"><FileText size={13} /> Spravovat šablony</Link>
            {!monotonic ? <span className="kd-warn"><AlertTriangle size={13} /> Rozestupy musí růst</span> : null}
            {!allTpl ? <span className="kd-warn"><AlertTriangle size={13} /> Každý krok potřebuje existující šablonu</span> : null}
          </div>
          <SaveCancel onSave={save} onCancel={() => setEdit(false)} busy={busy} disabled={!valid} />
        </div>
      ) : (
        <>
          {locked ? <LockedNotice onPauseEdit={() => onPauseEdit(() => setEdit(true))} busy={pauseBusy} /> : null}
          <ol className="kd-seqlist">
            {readSteps.length === 0 ? <li className="kd-muted">Bez sekvence</li> : readSteps.map((s, i) => (
              <li className="kd-seqitem" key={i}>
                <span className="kd-seqitem__tpl"><FileText size={13} /> {s.template || '—'}</span>
                <span className="kd-seqitem__delay">{i === 0 ? 'ihned' : `+${s.delay_days} dní`}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Card>
  )
}

// ── Pacing (spacing + daily cap) — live editable ──────────────────────────
function PacingSection({ c, onSaved }) {
  const toast = useToast()
  const [edit, setEdit] = useState(false)
  const [spacing, setSpacing] = useState(c.mailbox_min_spacing_seconds ?? '')
  const [cap, setCap] = useState(c.mailbox_daily_cap_override ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setSpacing(c.mailbox_min_spacing_seconds ?? ''); setCap(c.mailbox_daily_cap_override ?? '') }, [c.mailbox_min_spacing_seconds, c.mailbox_daily_cap_override])

  const save = async () => {
    setBusy(true)
    try {
      await mutate(`/api/campaigns/${c.id}/pacing`, 'PUT', {
        mailbox_min_spacing_seconds: spacing === '' ? null : Number(spacing),
        mailbox_daily_cap_override: cap === '' ? null : Number(cap),
      })
      toast('Pacing uložen', 'ok'); setEdit(false); onSaved()
    } catch (e) { toast(`Chyba: ${e.message}`, 'err') } finally { setBusy(false) }
  }

  return (
    <Card icon={Gauge} title="Tempo odesílání" testid="kd-pacing"
      hint="Denní strop jen snižuje warmup limit schránky (nikdy nezvyšuje)."
      right={!edit ? <EditBtn onClick={() => setEdit(true)} /> : null}>
      {edit ? (
        <div className="kd-form">
          <label className="kd-field">
            <span>Min. rozestup mezi e-maily (s) — prázdné = výchozí</span>
            <input className="kd-input" type="number" min={30} max={3600} value={spacing} onChange={(e) => setSpacing(e.target.value)} placeholder="60" />
          </label>
          <label className="kd-field">
            <span>Denní strop kampaně — prázdné/0 = limit schránky</span>
            <input className="kd-input" type="number" min={0} max={5000} value={cap} onChange={(e) => setCap(e.target.value)} placeholder="0" />
          </label>
          <SaveCancel onSave={save} onCancel={() => setEdit(false)} busy={busy} />
        </div>
      ) : (
        <div className="kd-readrows">
          <div className="kd-readrow"><span className="kd-k">Rozestup</span><span className="kd-v">{c.mailbox_min_spacing_seconds != null ? `${c.mailbox_min_spacing_seconds} s` : <em className="kd-muted">výchozí (60 s)</em>}</span></div>
          <div className="kd-readrow"><span className="kd-k">Denní strop</span><span className="kd-v">{c.mailbox_daily_cap_override ? fmt(c.mailbox_daily_cap_override) : <em className="kd-muted">limit schránky</em>}</span></div>
        </div>
      )}
    </Card>
  )
}

// ── Send window — live editable ───────────────────────────────────────────
function SendWindowSection({ c, onSaved }) {
  const toast = useToast()
  const [edit, setEdit] = useState(false)
  const [start, setStart] = useState(toHHMM(c.send_window_start))
  const [end, setEnd] = useState(toHHMM(c.send_window_end))
  const [busy, setBusy] = useState(false)
  useEffect(() => { setStart(toHHMM(c.send_window_start)); setEnd(toHHMM(c.send_window_end)) }, [c.send_window_start, c.send_window_end])

  const valid = (!start && !end) || (start && end && start < end)
  const save = async () => {
    setBusy(true)
    try {
      await mutate(`/api/campaigns/${c.id}/send-window`, 'PUT', { start: start || null, end: end || null })
      toast('Časové okno uloženo', 'ok'); setEdit(false); onSaved()
    } catch (e) { toast(`Chyba: ${e.message}`, 'err') } finally { setBusy(false) }
  }

  return (
    <Card icon={Clock} title="Časové okno" testid="kd-window"
      hint="Kdy se smí odesílat. Prázdné = výchozí okno z nastavení."
      right={!edit ? <EditBtn onClick={() => setEdit(true)} /> : null}>
      {edit ? (
        <div className="kd-form">
          <div className="kd-row2">
            <label className="kd-field"><span>Začátek</span><input className="kd-input" type="time" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <label className="kd-field"><span>Konec</span><input className="kd-input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
          </div>
          {!valid ? <div className="kd-warn"><AlertTriangle size={13} /> Začátek musí být dříve než konec.</div> : null}
          <SaveCancel onSave={save} onCancel={() => setEdit(false)} busy={busy} disabled={!valid} />
        </div>
      ) : (
        <div className="kd-readrows">
          <div className="kd-readrow"><span className="kd-k">Okno</span><span className="kd-v">{c.send_window_start && c.send_window_end ? `${toHHMM(c.send_window_start)} – ${toHHMM(c.send_window_end)}` : <em className="kd-muted">výchozí</em>}</span></div>
        </div>
      )}
    </Card>
  )
}

// ── Staircase (per-step launch caps) — structural ─────────────────────────
function StaircaseSection({ c, locked, onPauseEdit, pauseBusy, onSaved }) {
  const toast = useToast()
  const [edit, setEdit] = useState(false)
  const [vals, setVals] = useState(() => parseStaircase(c.staircase_max_per_step))
  const [busy, setBusy] = useState(false)
  useEffect(() => { setVals(parseStaircase(c.staircase_max_per_step)) }, [c.staircase_max_per_step])

  const valid = vals.length >= 1 && vals.length <= 20 && vals.every((n) => Number.isInteger(Number(n)) && Number(n) >= 0)
  const save = async () => {
    setBusy(true)
    try {
      await mutate(`/api/campaigns/${c.id}`, 'PATCH', { staircase_max_per_step: vals.map((n) => Number(n)) })
      toast('Staircase uloženo', 'ok'); setEdit(false); onSaved()
    } catch (e) { toast(`Chyba: ${e.message}`, 'err') } finally { setBusy(false) }
  }

  const read = parseStaircase(c.staircase_max_per_step)
  return (
    <Card icon={Layers} title="Rozjezd (staircase)" testid="kd-staircase"
      hint="Strop kontaktů per krok během náběhu — chrání reputaci (1 → 5 → 20 → 100)."
      right={!edit && !locked ? <EditBtn onClick={() => setEdit(true)} /> : null}>
      {edit ? (
        <div className="kd-form">
          <div className="kd-stair" data-testid="kd-stair">
            {vals.map((n, i) => (
              <div className="kd-stair__cell" key={i}>
                <span className="kd-stair__lbl">Den {i + 1}</span>
                <input className="kd-input" type="number" min={0} value={n} onChange={(e) => setVals((a) => a.map((x, idx) => (idx === i ? e.target.value : x)))} />
                {vals.length > 1 ? <button type="button" className="kd-icon kd-icon--danger" onClick={() => setVals((a) => a.filter((_, idx) => idx !== i))} aria-label="Odebrat"><X size={12} /></button> : null}
              </div>
            ))}
            {vals.length < 20 ? <button type="button" className="kd-btn kd-btn--ghost" onClick={() => setVals((a) => [...a, 100])}><Plus size={14} /> Krok</button> : null}
          </div>
          <SaveCancel onSave={save} onCancel={() => setEdit(false)} busy={busy} disabled={!valid} />
        </div>
      ) : (
        <>
          {locked ? <LockedNotice onPauseEdit={() => onPauseEdit(() => setEdit(true))} busy={pauseBusy} /> : null}
          <div className="kd-stairread">
            {read.length === 0 ? <span className="kd-muted">výchozí</span> : read.map((n, i) => (
              <span className="kd-pill" key={i}>{fmt(n)}{i < read.length - 1 ? <ChevronRight size={12} /> : null}</span>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}

// ── Danger zone (delete) ──────────────────────────────────────────────────
function DangerSection({ c }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const del = async () => {
    setBusy(true)
    try {
      await mutate(`/api/campaigns/${c.id}`, 'DELETE')
      toast('Kampaň smazána', 'ok'); navigate('/kampane')
    } catch (e) {
      toast(e.status === 409 || /in use|reference/i.test(e.message) ? 'Kampaň nelze smazat — je používána.' : `Chyba: ${e.message}`, 'err')
      setBusy(false)
    }
  }
  return (
    <Card icon={Trash2} title="Nebezpečná zóna" testid="kd-danger">
      <div className="kd-danger">
        <p className="kd-muted">Smazání je nevratné. Pro potvrzení napiš název kampaně.</p>
        <input className="kd-input" value={confirm} placeholder={c.name || `Kampaň ${c.id}`} onChange={(e) => setConfirm(e.target.value)} data-testid="kd-del-confirm" />
        <button type="button" className="kd-btn kd-btn--danger" disabled={busy || confirm.trim() !== (c.name || `Kampaň ${c.id}`).trim()} onClick={del} data-testid="kd-delete">
          <Trash2 size={14} /> {busy ? 'Mažu…' : 'Smazat kampaň'}
        </button>
      </div>
    </Card>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function KampanDetail() {
  const { id } = useParams()
  const toast = useToast()
  const res = useResource(`/api/campaigns/${id}`, { pollMs: 0, parse: (r) => r })
  const tplRes = useResource('/api/templates', { pollMs: 0, parse: (r) => (Array.isArray(r) ? r : (r?.templates || r?.rows || [])) })
  const [lifeBusy, setLifeBusy] = useState(false)
  const [blockers, setBlockers] = useState(null)
  const afterPauseRef = useRef(null)

  const data = res.data || {}
  const c = data.campaign
  const stats = data.stats || {}
  const templates = tplRes.status === 'ok' ? tplRes.data : []
  const locked = c ? LIVE_STATUSES.includes(c.status) : false

  const refresh = () => res.refresh?.()

  const lifecycle = async (action) => {
    setLifeBusy(true); setBlockers(null)
    try {
      await mutate(`/api/campaigns/${id}/${action}`, 'POST')
      toast(action === 'run' ? 'Kampaň spuštěna' : 'Kampaň pozastavena', 'ok')
      refresh()
      if (action === 'pause' && afterPauseRef.current) { const fn = afterPauseRef.current; afterPauseRef.current = null; setTimeout(fn, 50) }
    } catch (e) {
      if (e.status === 412 && e.body?.blockers) { setBlockers(e.body.blockers); toast('Kampaň nelze spustit — viz blockery.', 'err') }
      else if (e.status === 503) toast('Go orchestrator není dostupný — zkus to za chvíli.', 'err')
      else toast(`Chyba: ${e.message}`, 'err')
    } finally { setLifeBusy(false) }
  }
  // One-click "pause then edit" for structural sections.
  const onPauseEdit = (openEdit) => { afterPauseRef.current = openEdit; lifecycle('pause') }

  if (res.status === 'loading' || res.status === 'idle') {
    return <div className="kd"><div className="app-skel" style={{ height: 120 }} /></div>
  }
  if (res.status === 'error' || !c) {
    return (
      <div className="kd">
        <Link to="/kampane" className="kd-link"><ArrowLeft size={14} /> Zpět na kampaně</Link>
        <div className="app-empty" data-testid="kd-error">
          <div className="app-empty__title">{res.status === 'error' ? 'Nepodařilo se načíst' : 'Kampaň nenalezena'}</div>
          <div>{res.error || `Kampaň ${id} neexistuje.`}</div>
        </div>
      </div>
    )
  }

  const st = campaignStatusMeta(c.status)
  const rate = bounceRate(stats)
  const canRun = ['draft', 'paused', 'completed'].includes(c.status)

  return (
    <div className="kd" data-testid="app-kampan-detail">
      <Link to="/kampane" className="kd-link kd-back"><ArrowLeft size={14} /> Kampaně</Link>

      {/* Header */}
      <header className="kd-hero">
        <div className="kd-hero__main">
          <h2 className="kd-hero__name">{c.name || `Kampaň ${c.id}`}</h2>
          <span className="app-tag" style={{ color: st.fg, background: st.bg }} data-testid="kd-status">{st.label}</span>
        </div>
        <div className="kd-hero__actions">
          {canRun ? (
            <button type="button" className="kd-btn kd-btn--primary" disabled={lifeBusy} onClick={() => lifecycle('run')} data-testid="kd-run"><Play size={15} /> Spustit</button>
          ) : (
            <button type="button" className="kd-btn kd-btn--warn" disabled={lifeBusy} onClick={() => lifecycle('pause')} data-testid="kd-pause"><Pause size={15} /> Pozastavit</button>
          )}
        </div>
      </header>

      {blockers ? (
        <div className="kd-blockers" data-testid="kd-blockers">
          <div className="kd-blockers__t"><AlertTriangle size={15} /> Kampaň nelze spustit:</div>
          <ul>{blockers.map((b, i) => <li key={i}>{b.detail || b.label || b.code}</li>)}</ul>
        </div>
      ) : null}

      {/* KPI strip */}
      <div className="kd-kpis" data-testid="kd-kpis">
        {statTiles(stats).map((t) => (
          <div className="kd-kpi" key={t.label}><div className="kd-kpi__n">{fmt(t.value)}</div><div className="kd-kpi__l">{t.label}</div></div>
        ))}
        <div className="kd-kpi"><div className="kd-kpi__n">{rate == null ? '—' : `${rate} %`}</div><div className="kd-kpi__l">Bounce rate</div></div>
      </div>

      {/* Two intentional columns: left = obsah (identita / publikum / sekvence),
          right = doručování (tempo / okno / staircase) + danger. On mobile the
          columns collapse to one stack in this same reading order. */}
      <div className="kd-grid">
        <div className="kd-col">
          <IdentitySection c={c} onSaved={refresh} />
          <AudienceSection c={c} locked={locked} onPauseEdit={onPauseEdit} pauseBusy={lifeBusy} onSaved={refresh} />
          <SequenceSection c={c} locked={locked} onPauseEdit={onPauseEdit} pauseBusy={lifeBusy} templates={templates} onSaved={refresh} />
        </div>
        <div className="kd-col">
          <PacingSection c={c} onSaved={refresh} />
          <SendWindowSection c={c} onSaved={refresh} />
          <StaircaseSection c={c} locked={locked} onPauseEdit={onPauseEdit} pauseBusy={lifeBusy} onSaved={refresh} />
          <DangerSection c={c} />
        </div>
      </div>
    </div>
  )
}
