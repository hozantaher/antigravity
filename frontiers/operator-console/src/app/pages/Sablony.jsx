import { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Pencil, Copy, Trash2, Eye, Shuffle, AlertTriangle, FileText } from 'lucide-react'
import { useResource } from '../../hooks/useResource'
import { useToast } from '../../components/Toast'
import Empty from '../components/Empty'
import { expandSpintax, countVariations, validateSpintax } from '../../lib/spintax.js'
import './app-sablony.css'

// Šablony — e-mail template management on the Claude frame. List + aside
// editor (spintax-aware preview + variation counts) + performance ranking.
// Clean rebuild of the Templates page against the SAME BFF endpoints
// (/api/templates CRUD + /api/templates/ranking). Port P2 — dashboard-unification.
//
// AR2/AR5: the render guards (no tracking pixel, no short URLs) live server-side
// at send time; this editor only authors the body. Spintax {alt|alt} variation
// lowers spam-filter fingerprinting — surfaced via the variation badge.

const SAMPLE = { jmeno: 'Novák', firma: 'Stavba Plus s.r.o.', oddelovac: '--' }

function substituteVars(text) {
  return (text || '')
    .replace(/\{\{jmeno\}\}/g, SAMPLE.jmeno)
    .replace(/\{\{firma\}\}/g, SAMPLE.firma)
    .replace(/\{\{oddelovac\}\}/g, SAMPLE.oddelovac)
    .replace(/\{\{(\w+)\}\}/g, (_, k) => `[${k}]`)
}
function renderPreview(text, seed) {
  return expandSpintax(substituteVars(text), seed)
}

// Mirrors the server-side compliance gates in src/server-routes/templates.js
// (feedback_no_unsub_url_in_body + AR2/AR5 short-URL). Surfaced inline so the
// operator sees the problem before hitting Save — same Czech wording the BFF
// returns on a 400 (the server stays the source of truth; this is early
// feedback, not a replacement).
const SHORT_URL_RE = /(?:https?:\/\/)?(?:bit\.ly|t\.co|tinyurl\.com|goo\.gl|ow\.ly|tiny\.cc|is\.gd|buff\.ly|rebrand\.ly|short\.io)\//i
function complianceIssues(text) {
  const issues = []
  if (/\{\{\s*unsubscribe_url\s*\}\}/i.test(text) || /\{\{\s*\.UnsubURL\s*\}\}/i.test(text) || /\/unsubscribe\b/i.test(text)) {
    issues.push('Tělo NESMÍ obsahovat odhlašovací odkaz ({{.UnsubURL}}, {{unsubscribe_url}} ani /unsubscribe) — opt-out je přes odpověď + STOP.')
  }
  if (SHORT_URL_RE.test(text)) {
    issues.push('Tělo obsahuje zkrácenou URL (bit.ly, t.co, …) — použij plnou cílovou URL (zkrácené URL jsou anti-spam fingerprint).')
  }
  return issues
}

function variationLabel(n, validation) {
  const fatal = validation.errors.some((e) => /unclosed|unmatched/i.test(e.msg))
  if (fatal) return { tone: 'err', text: 'chyba syntaxe' }
  if (n === 1) return { tone: 'muted', text: 'bez spintax' }
  if (n === Infinity) return { tone: 'warn', text: '> 1M variant' }
  return { tone: 'ok', text: `${n} variant${n < 5 ? 'y' : ''}` }
}

function SpintaxBadge({ text }) {
  const validation = useMemo(() => validateSpintax(text), [text])
  const n = useMemo(() => countVariations(text), [text])
  const { tone, text: label } = variationLabel(n, validation)
  return <span className={`app-sablony__spintax app-sablony__spintax--${tone}`} data-testid="app-sablony-spintax">{label}</span>
}

function TemplateEditor({ template, onClose, onSaved }) {
  const toast = useToast()
  const [name, setName] = useState(template?.name || '')
  const [subject, setSubject] = useState(template?.subject || '')
  const [body, setBody] = useState(template?.body || '')
  const [preview, setPreview] = useState(false)
  const [seed, setSeed] = useState(1)
  const [busy, setBusy] = useState(false)

  const isEdit = !!template?.id
  const subjVal = useMemo(() => validateSpintax(subject), [subject])
  const bodyVal = useMemo(() => validateSpintax(body), [body])
  const hasSpintaxError = !subjVal.ok || !bodyVal.ok
  const compliance = useMemo(() => complianceIssues(`${subject}\n${body}`), [subject, body])
  const valid = name.trim() && subject.trim() && body.trim() && !hasSpintaxError && compliance.length === 0

  const save = async () => {
    if (!valid || busy) return
    setBusy(true)
    try {
      const url = isEdit ? `/api/templates/${template.id}` : '/api/templates'
      const r = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), subject, body }),
      })
      if (!r.ok) {
        // Surface the BFF's helpful compliance/validation message instead of a
        // bare "HTTP 400" (feedback_no_unsub_url_in_body, AR2/AR5 short-URL).
        let msg = `HTTP ${r.status}`
        try { const j = await r.json(); msg = j.message || j.error || msg } catch { /* non-JSON */ }
        throw new Error(msg)
      }
      toast(isEdit ? 'Šablona uložena' : 'Šablona vytvořena', 'ok')
      onSaved?.()
    } catch (e) {
      toast(`Chyba při ukládání: ${e.message || 'zkus znovu'}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="app-sablony__editor" data-testid="app-sablony-editor">
      <div className="app-sablony__editor-head">
        <h2>{isEdit ? 'Upravit šablonu' : 'Nová šablona'}</h2>
        <button type="button" className="app-sablony__close" onClick={onClose} aria-label="Zavřít">×</button>
      </div>

      <label className="app-sablony__field">
        <span>Název šablony *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Název…"
          data-testid="app-sablony-name" autoFocus />
      </label>

      <label className="app-sablony__field">
        <span>Předmět e-mailu * <SpintaxBadge text={subject} /></span>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Předmět…"
          data-testid="app-sablony-subject" />
      </label>

      <div className="app-sablony__field">
        <span className="app-sablony__field-label">
          <span>Tělo e-mailu * <SpintaxBadge text={body} /></span>
          <span className="app-sablony__count">{body.length} zn · {body.trim() ? body.trim().split(/\s+/).length : 0} slov</span>
        </span>
        {preview ? (
          <div className="app-sablony__preview" data-testid="app-sablony-preview">
            <div className="app-sablony__preview-subj">Předmět: <strong>{renderPreview(subject, seed) || '—'}</strong></div>
            <div className="app-sablony__preview-body">
              {renderPreview(body, seed) || <span className="app-sablony__muted">Tělo prázdné…</span>}
            </div>
            <div className="app-sablony__preview-foot">Náhled: jmeno="{SAMPLE.jmeno}", firma="{SAMPLE.firma}"</div>
          </div>
        ) : (
          <textarea className="app-sablony__body" value={body} onChange={(e) => setBody(e.target.value)}
            placeholder={'Dobrý den,\n\npíšu Vám ohledně…'} data-testid="app-sablony-body" />
        )}
        <div className="app-sablony__hint">
          Proměnné: <code>{'{{jmeno}}'}</code> <code>{'{{firma}}'}</code> · Spintax: <code>{'{Ahoj|Dobrý den}'}</code>
        </div>
        {hasSpintaxError ? (
          <div className="app-sablony__err" role="alert" data-testid="app-sablony-spintax-error">
            <AlertTriangle size={13} /> Chyba ve spintax syntaxi:{' '}
            {[...subjVal.errors, ...bodyVal.errors].filter((e) => /unclosed|unmatched/i.test(e.msg)).map((e) => e.msg).join(' · ') || 'neplatná struktura'}
          </div>
        ) : null}
        {compliance.length > 0 ? (
          <div className="app-sablony__err" role="alert" data-testid="app-sablony-compliance-error">
            <AlertTriangle size={13} /> {compliance.join(' ')}
          </div>
        ) : null}
      </div>

      <div className="app-sablony__editor-actions">
        <button type="button" className="app-sablony__btn" onClick={() => { setPreview((p) => !p); setSeed((s) => s + 1) }}
          data-testid="app-sablony-preview-toggle">
          <Eye size={14} /> {preview ? 'Editor' : 'Náhled'}
        </button>
        {preview ? (
          <button type="button" className="app-sablony__btn" onClick={() => setSeed((s) => s + 1)} title="Jiná varianta">
            <Shuffle size={14} /> Jiná varianta
          </button>
        ) : null}
        <button type="button" className="app-sablony__btn app-sablony__btn--primary" onClick={save}
          disabled={!valid || busy} data-testid="app-sablony-save">
          {busy ? 'Ukládám…' : isEdit ? 'Uložit' : 'Vytvořit'}
        </button>
      </div>
    </aside>
  )
}

export default function Sablony() {
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const list = useResource('/api/templates', { pollMs: 0 })
  const rankingRes = useResource('/api/templates/ranking', {
    parse: (raw) => (Array.isArray(raw?.ranking) ? raw.ranking : []),
    initialData: [],
  })

  const templates = Array.isArray(list.data) ? list.data : (list.data?.templates || list.data?.rows || [])
  const ranking = rankingRes.status === 'ok' ? rankingRes.data : []

  const activeId = params.get('id')
  const isNew = params.get('new') === '1'
  const [clone, setClone] = useState(null)
  const [delId, setDelId] = useState(null)

  const selected = templates.find((t) => String(t.id) === activeId) || null
  const editing = isNew ? (clone || {}) : selected
  const editorKey = isNew ? (clone ? `clone-${clone.name}` : 'new') : activeId

  const openNew = () => { setClone(null); const n = new URLSearchParams(params); n.delete('id'); n.set('new', '1'); setParams(n) }
  const openEdit = (id) => { setClone(null); const n = new URLSearchParams(params); n.delete('new'); n.set('id', String(id)); setParams(n) }
  const openClone = (t) => { setClone({ ...t, id: undefined, name: `${t.name} (kopie)` }); const n = new URLSearchParams(params); n.delete('id'); n.set('new', '1'); setParams(n) }
  const closeEditor = () => { setClone(null); const n = new URLSearchParams(params); n.delete('id'); n.delete('new'); setParams(n, { replace: true }) }
  const onSaved = () => { list.refresh?.(); rankingRes.refresh?.(); closeEditor() }

  const removeTemplate = async (id) => {
    try {
      const r = await fetch(`/api/templates/${id}`, { method: 'DELETE' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      toast('Šablona smazána', 'ok')
      setDelId(null)
      list.refresh?.()
      if (String(id) === activeId) closeEditor()
    } catch (e) { toast(`Chyba: ${e.message || 'zkus znovu'}`, 'err') }
  }

  const stats = useMemo(() => {
    const usedSlugs = new Set()
    for (const r of ranking) { if (r?.template) usedSlugs.add(r.template) }
    let used = 0, withSpintax = 0
    for (const t of templates) {
      if (usedSlugs.has(t.name) || usedSlugs.has(t.slug)) used++
      if (/\{[^{}]*\|[^{}]*\}/.test(`${t.subject || ''}\n${t.body || ''}`)) withSpintax++
    }
    return { total: templates.length, used, unused: templates.length - used, withSpintax }
  }, [templates, ranking])

  const editorOpen = isNew || !!selected
  const loading = list.status === 'loading' || list.status === 'idle'

  return (
    <div className="app-sablony" data-testid="app-sablony">
      <div className="app-sablony__main">
        <div className="app-sablony__head">
          <div>
            <h1 className="app-sablony__title">Šablony</h1>
            <div className="app-sablony__stats" data-testid="app-sablony-stats">
              <span>{list.status === 'ok' ? stats.total : '—'} šablon</span>
              {stats.used > 0 ? <span>· {stats.used} použité</span> : null}
              {stats.unused > 0 ? <span>· {stats.unused} nepoužité</span> : null}
              {stats.withSpintax > 0 ? <span>· {stats.withSpintax} se spintax</span> : null}
            </div>
          </div>
          <button type="button" className="app-sablony__btn app-sablony__btn--primary" onClick={openNew}
            data-testid="app-sablony-new">
            <Plus size={15} /> Nová šablona
          </button>
        </div>

        {list.status === 'error' ? (
          <div className="app-empty"><div className="app-empty__title">Nepodařilo se načíst</div><div>{list.error}</div></div>
        ) : loading && templates.length === 0 ? (
          <div className="app-sablony__list">{[0, 1, 2].map((i) => <div className="app-skeleton-row" key={i} />)}</div>
        ) : templates.length === 0 ? (
          <Empty icon={FileText} testid="app-sablony-empty" title="Žádné šablony"
            hint="Vytvoř první šablonu pro rychlejší psaní e-mailů." action={{ onClick: openNew, label: 'Nová šablona' }} />
        ) : (
          <div className="app-sablony__list" data-testid="app-sablony-list">
            {templates.map((t) => (
              <div key={t.id} className={`app-sablony__card${String(t.id) === activeId ? ' app-sablony__card--active' : ''}`}
                data-testid="app-sablony-row">
                <button type="button" className="app-sablony__card-main" onClick={() => openEdit(t.id)}>
                  <div className="app-sablony__card-name">{t.name}</div>
                  <div className="app-sablony__card-subj">Předmět: {t.subject}</div>
                  <div className="app-sablony__card-body">{t.body?.slice(0, 160)}{t.body?.length > 160 ? '…' : ''}</div>
                </button>
                <div className="app-sablony__card-actions">
                  <button type="button" className="app-sablony__icon" onClick={() => openEdit(t.id)} title="Upravit"><Pencil size={15} /></button>
                  <button type="button" className="app-sablony__icon" onClick={() => openClone(t)} title="Klonovat" data-testid={`app-sablony-clone-${t.id}`}><Copy size={15} /></button>
                  {delId === t.id ? (
                    <button type="button" className="app-sablony__icon app-sablony__icon--danger" onClick={() => removeTemplate(t.id)} title="Potvrdit smazání" data-testid={`app-sablony-del-confirm-${t.id}`}>Smazat?</button>
                  ) : (
                    <button type="button" className="app-sablony__icon app-sablony__icon--danger" onClick={() => setDelId(t.id)} title="Smazat"><Trash2 size={15} /></button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {rankingRes.status === 'error' ? (
          <div className="app-sablony__rank-err" data-testid="app-sablony-rank-error">
            <AlertTriangle size={14} /> Žebříček se nepodařilo načíst.
            <button type="button" className="app-sablony__btn" onClick={rankingRes.refresh}>Zkusit znovu</button>
          </div>
        ) : ranking.length > 0 ? (
          <div className="app-sablony__rank" data-testid="app-sablony-ranking">
            <div className="app-sablony__rank-title">Výkonnost šablon</div>
            <table className="app-sablony__rank-table">
              <thead>
                <tr><th>#</th><th>Šablona</th><th className="r">Kampaní</th><th className="r">Odesláno</th><th className="r">Reply</th><th className="r">Open</th></tr>
              </thead>
              <tbody>
                {ranking.map((r, i) => (
                  <tr key={r.template_id}>
                    <td>{i + 1}</td>
                    <td className="app-sablony__rank-name">{r.name}</td>
                    <td className="r">{r.campaigns_used}</td>
                    <td className="r">{r.total_sent}</td>
                    <td className="r" style={{ color: Number(r.reply_rate) > 5 ? 'var(--app-positive)' : 'var(--app-text-soft)' }}>{Number(r.reply_rate || 0).toFixed(1)} %</td>
                    <td className="r app-sablony__muted">{Number(r.open_rate || 0).toFixed(1)} %</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {editorOpen ? (
        <TemplateEditor key={editorKey} template={editing} onClose={closeEditor} onSaved={onSaved} />
      ) : null}
    </div>
  )
}
