import { useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useResource } from '../../hooks/useResource'
import { relativeCs, decodeMimeWords } from '../lib/replyMeta'
import './app-hledat.css'

// Hledat — cross-entity global search, the data-mining entry point. One box
// fans out across replies / vehicles / contacts / companies / CRM (GET
// /api/search) and groups hits, each linking to its surface deep-link. Read-only.

const DEBOUNCE_MS = 300

// Each group: how to label a hit + where it deep-links. Pure config.
const GROUPS = [
  { key: 'replies', label: 'Odpovědi', to: (r) => `/odpovedi?vse=1&id=${r.id}`,
    primary: (r) => decodeMimeWords(r.subject) || '(bez předmětu)', secondary: (r) => `${r.from_email || ''} · ${relativeCs(r.received_at)}` },
  { key: 'vehicles', label: 'Vozidla', to: (v) => `/vozidla?id=${v.id}`,
    primary: (v) => [v.make, v.model, v.year].filter(Boolean).join(' '), secondary: (v) => v.status || '' },
  { key: 'contacts', label: 'Kontakty', to: (c) => `/kontakty?id=${c.id}`,
    primary: (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email || `#${c.id}`, secondary: (c) => [c.email, c.company_name].filter(Boolean).join(' · ') },
  { key: 'companies', label: 'Firmy', to: (f) => `/firmy?ico=${encodeURIComponent(f.ico)}`,
    primary: (f) => f.name || f.ico, secondary: (f) => [f.sector_primary, f.address_locality].filter(Boolean).join(' · ') },
  { key: 'crm', label: 'CRM klienti', to: (c) => `/crm?id=${c.id}`,
    primary: (c) => c.name || c.email_primary || `#${c.id}`, secondary: (c) => [c.crm_status, c.ico && `IČO ${c.ico}`].filter(Boolean).join(' · ') },
]

export default function Hledat() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') || ''
  const [draft, setDraft] = useState(q)

  useEffect(() => { setDraft(q) }, [q])
  useEffect(() => {
    const t = setTimeout(() => {
      const next = new URLSearchParams(params)
      if (draft.trim()) next.set('q', draft.trim()); else next.delete('q')
      setParams(next, { replace: true })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const res = useResource(q.length >= 2 ? `/api/search?q=${encodeURIComponent(q)}` : null, { enabled: q.length >= 2 })
  const data = res.data || {}
  const totalHits = GROUPS.reduce((n, g) => n + (data[g.key]?.length || 0), 0)

  return (
    <div className="app-hledat" data-testid="app-hledat">
      <h1>Hledat</h1>
      <input className="app-hledat__input" value={draft} autoFocus
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Hledej napříč odpověďmi, vozidly, kontakty, firmami, CRM…"
        data-testid="app-hledat-input" />

      {q.length < 2 ? (
        <div className="app-hledat__hint">Napiš aspoň 2 znaky — prohledá celý propojený systém.</div>
      ) : res.status === 'loading' && !res.data ? (
        <div className="app-hledat__hint">Hledám…</div>
      ) : res.status === 'error' ? (
        <div className="app-hledat__hint">Hledání selhalo — zkus to znovu.</div>
      ) : totalHits === 0 ? (
        <div className="app-hledat__hint" data-testid="app-hledat-empty">Nic nenalezeno pro „{q}".</div>
      ) : (
        <div className="app-hledat__groups">
          {GROUPS.filter((g) => (data[g.key] || []).length > 0).map((g) => (
            <section className="app-hledat__group" key={g.key} data-testid={`app-hledat-group-${g.key}`}>
              <div className="app-hledat__grouphead">{g.label} <span className="app-hledat__count">{data[g.key].length}</span></div>
              {data[g.key].map((it, i) => (
                <Link key={i} to={g.to(it)} className="app-hledat__hit" data-testid="app-hledat-hit">
                  <span className="app-hledat__primary">{g.primary(it)}</span>
                  <span className="app-hledat__secondary">{g.secondary(it)}</span>
                </Link>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
