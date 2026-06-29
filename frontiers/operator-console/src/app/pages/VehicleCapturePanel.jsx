import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { draftFromCandidate, isDraftValid, buildCreatePayload, photoRefsFromAttachments } from '../lib/vehicleDraft'
import { vehicleTitle } from '../lib/vehicleMeta'

// Odpovědi → Vozidlo capture. Connects the two surfaces: a hot reply
// becomes a vehicle in the acquisition pipeline. The Ollama extraction is a
// SUGGESTION the operator edits; only the explicit "Vytvořit vozidlo" click
// (deterministic POST) writes the final state — the LLM never auto-creates.
// Fills the real gap: 50 of 64 'Zájem' replies had no vehicle (2026-05-31).

const FIELDS = [
  { k: 'make', label: 'Značka', w: 2 },
  { k: 'model', label: 'Model', w: 2 },
  { k: 'year', label: 'Rok', w: 1 },
  { k: 'mileage_km', label: 'Najeto km', w: 1 },
  { k: 'price_offered_eur', label: 'Cena EUR', w: 1 },
  { k: 'body_type', label: 'Typ', w: 2 },
]

// `open` is controlled by the composer's "Vozidlo" toggle: the capture form
// is hidden until the operator asks for it (declutters the reply pane). An
// already-captured vehicle still shows its compact chip regardless of `open`.
export default function VehicleCapturePanel({ reply, open }) {
  // Fast check: did this reply already produce a vehicle?
  const existing = useResource(reply?.id ? `/api/vehicles?source_reply_id=${reply.id}&limit=1` : null,
    { enabled: !!reply?.id })
  const linked = existing.data?.rows?.[0] || null

  // The reply's image attachments — attached to the vehicle on create so the
  // seller's machine photos enter the auction pipeline.
  const att = useResource(reply?.id != null ? `/api/replies/${reply.id}/attachments` : null,
    { enabled: reply?.id != null })
  const photos = photoRefsFromAttachments(reply?.id, att.data?.attachments || [])

  const [phase, setPhase] = useState('idle')   // idle | extracting | draft | creating | done | error
  const [draft, setDraft] = useState(null)
  const [version, setVersion] = useState(null) // ollama_v1 | regex_v3
  const [msg, setMsg] = useState('')
  const [createdId, setCreatedId] = useState(null)

  if (!reply?.id) return null

  if (linked || phase === 'done') {
    const id = linked?.id || createdId
    const title = linked ? vehicleTitle(linked) : 'Nové vozidlo'
    return (
      <div className="app-capture app-capture--linked" data-testid="app-capture-linked">
        <span className="app-capture__ok"><Check size={14} className="app-ico" aria-hidden="true" /> Vozidlo</span>
        <Link to={`/vozidla?id=${id}`} className="app-capture__link">{title} →</Link>
      </div>
    )
  }

  // Not yet captured + the composer's vehicle toggle is closed → stay hidden.
  if (!open) return null

  const runExtract = async () => {
    setPhase('extracting'); setMsg('Ollama čte e-mail… (~15 s)')
    try {
      const r = await fetch(`/api/replies/${reply.id}/extracted-vehicles?refresh=1`)
      if (!r.ok) throw new Error(`extract ${r.status}`)
      const data = await r.json()
      setVersion(data.extractor_version || null)
      setDraft(draftFromCandidate((data.vehicles || [])[0] || null))
      setPhase('draft')
      setMsg((data.vehicles || []).length ? '' : 'Ollama nic nenašla — vyplň ručně.')
    } catch (e) {
      setPhase('error'); setMsg('Extrakce selhala — vyplň ručně.')
      setDraft(draftFromCandidate(null))
    }
  }

  const create = async () => {
    if (!isDraftValid(draft)) return
    setPhase('creating'); setMsg('Vytvářím…')
    try {
      const r = await fetch('/api/vehicles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildCreatePayload(draft, reply, photos)),
      })
      if (!r.ok) throw new Error(`create ${r.status}`)
      const v = await r.json()
      setCreatedId(v.id); setPhase('done'); setMsg('')
    } catch (e) {
      setPhase('error'); setMsg('Vytvoření selhalo — zkus znovu.')
    }
  }

  return (
    <div className="app-capture" data-testid="app-capture">
      <div className="app-capture__head">
        <span className="app-vd__label" style={{ margin: 0 }}>Vozidlo z této odpovědi</span>
        {version ? <span className="app-capture__ver">{version === 'ollama_v1' ? 'Ollama' : 'regex'}</span> : null}
      </div>

      {phase === 'idle' || phase === 'extracting' ? (
        <button type="button" className="app-btn" disabled={phase === 'extracting'}
          onClick={runExtract} data-testid="app-capture-extract">
          {phase === 'extracting' ? 'Ollama čte e-mail…' : 'Najít vozidlo v textu (Ollama)'}
        </button>
      ) : null}

      {(phase === 'draft' || phase === 'creating' || phase === 'error') && draft ? (
        <>
          <div className="app-capture__grid">
            {FIELDS.map((f) => (
              <label key={f.k} className="app-capture__field" style={{ gridColumn: `span ${f.w}` }}>
                <span>{f.label}</span>
                <input value={draft[f.k]} data-testid={`app-capture-${f.k}`}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.k]: e.target.value }))} />
              </label>
            ))}
          </div>
          {photos.length > 0 ? (
            <div className="app-capture__photos" data-testid="app-capture-photos">
              <span className="app-capture__photos-label">Fotky z odpovědi ({photos.length}) — připojí se k vozidlu</span>
              <div className="app-capture__photos-row">
                {photos.map((ph) => (
                  <img key={ph.idx} src={ph.url} alt={ph.filename} loading="lazy" className="app-capture__photo" />
                ))}
              </div>
            </div>
          ) : null}
          <button type="button" className="app-btn app-btn--primary"
            disabled={!isDraftValid(draft) || phase === 'creating'}
            onClick={create} data-testid="app-capture-create">
            {phase === 'creating' ? 'Vytvářím…' : `Vytvořit vozidlo${photos.length ? ` + ${photos.length} foto` : ''}`}
          </button>
        </>
      ) : null}

      {msg ? <div className="app-capture__msg">{msg}</div> : null}
    </div>
  )
}
