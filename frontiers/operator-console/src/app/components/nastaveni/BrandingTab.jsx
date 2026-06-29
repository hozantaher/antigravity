import { useState, useMemo } from 'react'
import { Save, RefreshCw, CheckCircle2 } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { useToast } from '../../../components/Toast'

// Nastavení → Entita & brand tab. Clean rebuild of
// src/components/settings/SettingsBrandingTab.jsx on the frame.
//   GET /api/operator-settings              — 9 controller/brand keys
//   PUT /api/operator-settings/:key         — X-Confirm-Send: yes (verbatim)
// Free-form GDPR controller identity strings injected into every outbound mail.

// Field labels (Czech) — verbatim from FIELD_META.
const FIELD_META = {
  controller_name:                 { label: 'Název správce', desc: 'Celý název kontroloru (GDPR Art. 13)', required: true },
  controller_id_label:             { label: 'Typ identifikátoru', desc: 'Např. PIB, IČO, RegNo', required: true },
  controller_id_value:             { label: 'Hodnota identifikátoru', desc: 'Číslo registrace správce', required: true },
  controller_seat_address:         { label: 'Sídlo správce', desc: 'Ulice, PSČ město, stát', required: true },
  controller_legal_basis_citation: { label: 'Citace právního základu', desc: 'Např. čl. 6(1)(f) GDPR + Recital 47', required: true },
  unsubscribe_base_url:            { label: 'Základní URL odhlášení', desc: 'https:// URL pro odhlašovací stránku', required: true },
  privacy_contact_email:           { label: 'E-mail soukromí', desc: 'Kontakt pro GDPR žádosti', required: true },
  data_source_label:               { label: 'Zdroj dat', desc: 'Název zdroje kontaktů (firmy.cz)', required: true },
  brand_label:                     { label: 'Značka', desc: 'Marketingový název (Garaaage)', required: true },
}
const KEY_ORDER = [
  'controller_name', 'controller_id_label', 'controller_id_value',
  'controller_seat_address', 'controller_legal_basis_citation',
  'unsubscribe_base_url', 'privacy_contact_email', 'data_source_label', 'brand_label',
]

function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' }) } catch { return iso }
}

export default function BrandingTab() {
  const toast = useToast()
  const res = useResource('/api/operator-settings', { initialData: [] })
  const rows = Array.isArray(res.data) ? res.data : []
  const byKey = useMemo(() => Object.fromEntries(rows.map((r) => [r.key, r])), [rows])

  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)

  const valueOf = (key) => (key in drafts ? drafts[key] : (byKey[key]?.value ?? ''))
  const isChanged = (key) => key in drafts && (drafts[key] ?? '') !== (byKey[key]?.value ?? '')
  const changedKeys = KEY_ORDER.filter(isChanged)
  const dirty = changedKeys.length > 0

  const setDraft = (key, v) => setDrafts((prev) => ({ ...prev, [key]: v }))

  const save = async () => {
    if (!dirty || saving) return
    const empty = changedKeys.filter((k) => !String(valueOf(k)).trim())
    if (empty.length) { toast('Hodnoty nesmí být prázdné', 'err'); return }
    setSaving(true)
    let okCount = 0
    try {
      for (const key of changedKeys) {
        const r = await fetch(`/api/operator-settings/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes', 'X-Actor': 'dashboard' },
          body: JSON.stringify({ value: String(valueOf(key)).trim() }),
        })
        if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `HTTP ${r.status}`) }
        okCount++
      }
      toast(`Uloženo (${okCount})`, 'ok')
      setDrafts({})
      res.refresh?.()
    } catch (e) {
      toast(`Chyba uložení: ${e.message || 'zkus to znovu'}${okCount ? ` (uloženo ${okCount} před chybou)` : ''}`, 'err')
      res.refresh?.()
    } finally {
      setSaving(false)
    }
  }

  const state = res.status === 'error' ? 'error'
    : (res.status === 'loading' || res.status === 'idle') && rows.length === 0 ? 'loading'
      : 'ok'

  return (
    <div className="app-nast-panel" data-testid="app-nastaveni-branding">
      {state === 'error' ? (
        <div className="app-empty" data-testid="app-nastaveni-branding-error">
          <div className="app-empty__title">Nepodařilo se načíst nastavení</div>
          <div>{res.error}</div>
        </div>
      ) : state === 'loading' ? (
        <div className="app-nast-card">{[0, 1, 2, 3, 4].map((i) => <div className="app-nast-skel" key={i} />)}</div>
      ) : (
        <>
          <p className="app-nast-note">Hodnoty se načítají do všech odeslaných e-mailů nejpozději do 60 s od uložení — bez restartu, bez nasazení.</p>
          <div className="app-nast-card">
            {KEY_ORDER.map((key) => {
              const meta = FIELD_META[key]
              const row = byKey[key]
              const changed = isChanged(key)
              return (
                <div className={`app-nast-field${changed ? ' app-nast-field--changed' : ''}`} key={key}>
                  <div className="app-nast-field__top">
                    <label className="app-nast-field__label" htmlFor={`nast-${key}`}>
                      {meta.label}{meta.required ? <span className="app-nast-req">*</span> : null}
                    </label>
                    {row ? <span className="app-nast-field__meta">{fmtDate(row.updated_at)} · {row.updated_by ?? '—'}</span> : null}
                  </div>
                  <div className="app-nast-field__desc">{meta.desc}</div>
                  <input
                    id={`nast-${key}`}
                    className="app-nast-input"
                    type="text"
                    value={valueOf(key)}
                    onChange={(e) => setDraft(key, e.target.value)}
                    disabled={saving}
                    data-testid={`app-nastaveni-branding-input-${key}`}
                  />
                </div>
              )
            })}
          </div>

          <div className="app-nast-actionbar">
            <span className="app-nast-actionbar__hint">
              {dirty ? `${changedKeys.length} neuložených změn` : <><CheckCircle2 size={13} /> Vše uloženo</>}
            </span>
            <button
              type="button"
              className="app-nast-save"
              data-testid="app-nastaveni-save-branding"
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? <RefreshCw size={14} className="app-nast-spin" /> : <Save size={14} />}
              {saving ? 'Ukládám…' : 'Uložit změny'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
