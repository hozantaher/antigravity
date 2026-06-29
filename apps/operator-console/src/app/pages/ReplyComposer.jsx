import { useState, useEffect, useRef } from 'react'
import { Check, Truck, Paperclip, X } from 'lucide-react'
import { displayName } from '../lib/replyMeta'

// Odpovědi — reply composer. The operator writes a reply (optionally
// pre-filled by an on-demand Ollama draft) and optionally attaches files, then
// sends. Send goes through the EXISTING safe path: POST /api/replies/:id/reply
// (multipart) → manual_reply_outbox (+ manual_reply_outbox_attachments) →
// runOutboundReplyCron dispatches via the anti-trace-relay (~2 min). NEVER raw
// SMTP. The send is gated behind an explicit two-step confirm so a single stray
// click can't dispatch real mail — the confirm IS the operator consent.
//
// Attachments (2026-06-24): drag-drop / paste / picker. The client mirrors the
// server whitelist in replyMultipart.js so the operator gets an instant, local
// rejection instead of a 400 round-trip — the SERVER stays the source of truth.
//
// props: reply (the inbound row — id + from_email for the recipient line),
//        onSent() (parent refreshes detail + list so the row flips handled).

// Mirror of replyMultipart.js — feedback_no_magic_thresholds: named, not literal.
const MAX_FILES = 3
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB per attachment
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
])
const FILE_ACCEPT = 'image/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt'

export default function ReplyComposer({ reply, onSent, onToggleVehicle, vehicleOpen }) {
  const [text, setText] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [phase, setPhase] = useState('idle')   // idle | sending | sent | error
  const [msg, setMsg] = useState('')
  const [templates, setTemplates] = useState([])
  const [files, setFiles] = useState([])         // [{ id, file, previewUrl }]
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef(null)

  // Revoke any object URLs still alive when the composer unmounts (reply switch).
  const filesRef = useRef(files)
  filesRef.current = files
  useEffect(() => () => { filesRef.current.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)) }, [])

  // Load operator reply scaffolds once (#1022). Best-effort.
  useEffect(() => {
    let live = true
    fetch('/api/reply-templates')
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d) => { if (live) setTemplates(Array.isArray(d.templates) ? d.templates : []) })
      .catch(() => {})
    return () => { live = false }
  }, [])

  if (!reply?.id) return null
  const recipient = reply.from_email || displayName(reply) || 'odesílatele'
  const canSend = text.trim().length > 0 && phase !== 'sending'

  const useTemplate = (body) => {
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${body}` : body))
    if (phase === 'error') setPhase('idle')
    setMsg('Šablona vložena — uprav a odešli.')
  }

  // Client-side validation mirrors the server; the server still re-checks.
  const addFiles = (incoming) => {
    const list = Array.from(incoming || [])
    if (!list.length) return
    setFiles((cur) => {
      const next = [...cur]
      for (const f of list) {
        if (next.length >= MAX_FILES) { setMsg(`Maximálně ${MAX_FILES} přílohy.`); break }
        const ct = (f.type || '').toLowerCase()
        if (!ALLOWED_MIME.has(ct)) { setMsg(`Nepodporovaný typ: ${f.name}`); continue }
        if (f.size > MAX_FILE_BYTES) { setMsg(`${f.name} je větší než 10 MB.`); continue }
        const id = `${f.name}:${f.size}:${f.lastModified}`
        if (next.some((x) => x.id === id)) continue
        next.push({ id, file: f, previewUrl: ct.startsWith('image/') ? URL.createObjectURL(f) : null })
      }
      return next
    })
    if (phase === 'error') setPhase('idle')
  }
  const removeFile = (id) => setFiles((cur) => {
    const hit = cur.find((f) => f.id === id)
    if (hit?.previewUrl) URL.revokeObjectURL(hit.previewUrl)
    return cur.filter((f) => f.id !== id)
  })

  const draft = async () => {
    setDrafting(true); setMsg('Ollama píše návrh… (~20 s)')
    try {
      const r = await fetch(`/api/replies/${reply.id}/draft-reply`, { method: 'POST' })
      if (!r.ok) throw new Error(`draft ${r.status}`)
      const d = await r.json()
      if (!d.draft) { setMsg(d.message || 'Návrh se nepodařil.'); return }
      // The draft only fills an EMPTY composer (never clobbers existing text), so
      // branch the message instead of always claiming an insertion that didn't
      // happen when the operator had already written something.
      const hadText = text.trim().length > 0
      setText((cur) => (cur.trim() ? cur : d.draft))
      setMsg(hadText
        ? 'Návrh nebyl vložen — máš rozepsaný text. Vymaž ho, chceš-li návrh použít.'
        : 'Návrh vložen — uprav a odešli.')
    } catch {
      setMsg('Návrh se nepodařil — zkus to znovu.')
    } finally {
      setDrafting(false)
    }
  }

  const send = async () => {
    setConfirming(false); setPhase('sending')
    setMsg(files.length ? `Odesílám do fronty (${files.length} příl.)…` : 'Odesílám do fronty…')
    try {
      const fd = new FormData()
      fd.append('body', text.trim())
      files.forEach((f) => fd.append('files', f.file, f.file.name))
      const r = await fetch(`/api/replies/${reply.id}/reply`, { method: 'POST', body: fd })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) throw new Error(d.error || `send ${r.status}`)
      files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl))
      setFiles([])
      setPhase('sent')
      setMsg('Zařazeno do fronty — relay odešle do ~2 min.')
      if (typeof onSent === 'function') onSent()
    } catch (e) {
      setPhase('error')
      setMsg(`Odeslání selhalo: ${e.message || 'zkus to znovu'}`)
    }
  }

  if (phase === 'sent') {
    return (
      <div className="app-compose app-compose--done" data-testid="app-compose-done">
        <div className="app-compose__sent"><Check size={14} className="app-ico" aria-hidden="true" /> Odpověď zařazena do fronty</div>
        <div className="app-compose__note">{msg}</div>
      </div>
    )
  }

  return (
    <div className="app-compose" data-testid="app-compose">
      <div className="app-compose__head">
        <span className="app-vd__label" style={{ margin: 0 }}>Odpovědět</span>
        <span className="app-compose__to" data-testid="app-compose-to">komu: {recipient}</span>
      </div>

      {!confirming && templates.length > 0 ? (
        <div className="app-compose__templates" data-testid="app-compose-templates">
          <span className="app-compose__templates-label">Šablony:</span>
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="app-compose__template-chip"
              onClick={() => useTemplate(t.body)}
              disabled={phase === 'sending'}
              title={t.body}
              data-testid={`app-compose-template-${t.slug}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={`app-compose__drop${dragging ? ' app-compose__drop--over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
      >
        <textarea
          className="app-compose__text"
          value={text}
          rows={6}
          placeholder="Napiš odpověď… nebo nech Ollamu navrhnout. Přílohu přetáhni sem."
          onChange={(e) => { setText(e.target.value); if (phase === 'error') setPhase('idle') }}
          onPaste={(e) => { if (e.clipboardData?.files?.length) addFiles(e.clipboardData.files) }}
          disabled={phase === 'sending'}
          data-testid="app-compose-text"
        />
      </div>

      {files.length > 0 ? (
        <div className="app-compose__attach" data-testid="app-compose-attach">
          {files.map((f) => (
            <div key={f.id} className="app-compose__att" title={f.file.name}>
              {f.previewUrl
                ? <img src={f.previewUrl} alt={f.file.name} className="app-compose__att-img" />
                : <span className="app-compose__att-doc" aria-hidden="true"><Paperclip size={14} /></span>}
              <span className="app-compose__att-name">{f.file.name}</span>
              <button type="button" className="app-compose__att-x" onClick={() => removeFile(f.id)} aria-label={`Odebrat ${f.file.name}`} data-testid="app-compose-att-remove">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="app-compose__actions">
        {!confirming ? (
          <button type="button" className="app-btn app-btn--primary" disabled={!canSend}
            onClick={() => setConfirming(true)} data-testid="app-compose-send">
            {phase === 'sending' ? 'Odesílám…' : 'Odeslat →'}
          </button>
        ) : (
          <>
            <span className="app-compose__confirm-q">Odeslat {recipient}{files.length ? ` (${files.length} příl.)` : ''}?</span>
            <button type="button" className="app-btn app-btn--primary" onClick={send} disabled={phase === 'sending'} data-testid="app-compose-confirm">
              {phase === 'sending' ? 'Odesílám…' : 'Ano, odeslat'}
            </button>
            <button type="button" className="app-btn" onClick={() => setConfirming(false)} data-testid="app-compose-cancel">
              Zpět
            </button>
          </>
        )}
        {!confirming ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={FILE_ACCEPT}
              onChange={(e) => { addFiles(e.target.files); e.target.value = '' }}
              style={{ display: 'none' }}
              data-testid="app-compose-file-input"
            />
            <button type="button" className="app-btn" disabled={files.length >= MAX_FILES || phase === 'sending'}
              onClick={() => fileInputRef.current?.click()} data-testid="app-compose-attach-btn"
              title={files.length >= MAX_FILES ? `Maximálně ${MAX_FILES} přílohy` : 'Přidat přílohu'}>
              <Paperclip size={14} className="app-ico" aria-hidden="true" /> Příloha
            </button>
            <button type="button" className="app-btn" disabled={drafting}
              onClick={draft} data-testid="app-compose-draft">
              {drafting ? 'Ollama píše…' : 'Navrhni (Ollama)'}
            </button>
            {onToggleVehicle ? (
              <button type="button" className="app-btn" aria-pressed={vehicleOpen ? 'true' : 'false'}
                onClick={onToggleVehicle} data-testid="app-compose-vehicle">
                <Truck size={14} className="app-ico" aria-hidden="true" /> Vozidlo
              </button>
            ) : null}
          </>
        ) : null}
      </div>

      {msg ? <div className="app-compose__msg" data-testid="app-compose-msg">{msg}</div> : null}
      <div className="app-compose__note">Odesílá se přes relay z napojené schránky — ne přímé SMTP.</div>
    </div>
  )
}
