import { useState, useMemo } from 'react'
import { Save, RefreshCw, ChevronDown, ChevronRight, Info, CheckCircle2 } from 'lucide-react'
import { useResource } from '../../../hooks/useResource'
import { useToast } from '../../../components/Toast'
import { THRESHOLD_GROUPS, SPEC_BY_KEY, validateValue } from '../../../lib/thresholdDefaults.js'

// Nastavení → Provozní pravidla tab. Clean rebuild of
// src/components/settings/SettingsThresholdsTab.jsx on the frame.
//   GET /api/operator-settings        — current values
//   PUT /api/operator-settings/:key   — X-Confirm-Send: yes (verbatim)
// Defaults + validation reuse the SHARED src/lib/thresholdDefaults.js spec
// (feedback_no_magic_thresholds: no literal thresholds in JSX — all from spec).

function ThresholdControl({ spec, value, onChange, disabled }) {
  if (spec.type === 'boolean') {
    return (
      <select
        className="app-nast-input app-nast-input--num"
        value={(value === 'true' || value === true) ? 'true' : 'false'}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        data-testid={`app-nastaveni-thr-input-${spec.key}`}
      >
        <option value="true">true (zapnuto)</option>
        <option value="false">false (vypnuto)</option>
      </select>
    )
  }
  return (
    <input
      className="app-nast-input app-nast-input--num"
      type={spec.type === 'int' || spec.type === 'float' ? 'number' : 'text'}
      step={spec.type === 'float' ? '0.001' : '1'}
      min={typeof spec.min === 'number' ? spec.min : undefined}
      max={typeof spec.max === 'number' ? spec.max : undefined}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      data-testid={`app-nastaveni-thr-input-${spec.key}`}
    />
  )
}

function Group({ group, byKey, drafts, setDraft, disabled, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="app-nast-group" data-testid={`app-nastaveni-thr-group-${group.key}`}>
      <button type="button" className="app-nast-group__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="app-nast-group__title">{group.label}</span>
        <span className="app-nast-group__desc">{group.desc}</span>
        <span className="app-nast-group__count">{group.items.length}</span>
      </button>
      {open ? (
        <div className="app-nast-group__body">
          {group.items.map((spec) => {
            const current = byKey[spec.key]?.value ?? String(spec.defaultValue)
            const val = spec.key in drafts ? drafts[spec.key] : current
            const changed = String(val) !== String(current)
            const verr = changed ? validateValue(spec.key, String(val)) : null
            return (
              <div className={`app-nast-thr${changed ? ' app-nast-field--changed' : ''}`} key={spec.key}>
                <div className="app-nast-thr__info">
                  <div className="app-nast-field__label">{spec.label} <Info size={11} className="app-nast-ico-muted" aria-hidden="true" /></div>
                  <div className="app-nast-field__desc">{spec.desc} · <code>{spec.key}</code></div>
                </div>
                <div className="app-nast-thr__control">
                  <ThresholdControl spec={spec} value={val} onChange={(v) => setDraft(spec.key, v)} disabled={disabled} />
                  {spec.unit ? <span className="app-nast-unit">{spec.unit}</span> : null}
                  {verr ? <span className="app-nast-err" role="alert">{verr}</span> : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

export default function ThresholdsTab() {
  const toast = useToast()
  const res = useResource('/api/operator-settings', { initialData: [] })
  const rows = Array.isArray(res.data) ? res.data : []
  const byKey = useMemo(() => Object.fromEntries(rows.map((r) => [r.key, r])), [rows])

  const [drafts, setDrafts] = useState({})
  const [saving, setSaving] = useState(false)
  const setDraft = (key, v) => setDrafts((prev) => ({ ...prev, [key]: v }))

  const currentOf = (key) => byKey[key]?.value ?? String(SPEC_BY_KEY[key]?.defaultValue ?? '')
  const changedKeys = useMemo(
    () => Object.keys(drafts).filter((k) => String(drafts[k]) !== String(currentOf(k))),
    [drafts, byKey],
  )
  const dirty = changedKeys.length > 0
  const hasInvalid = changedKeys.some((k) => validateValue(k, String(drafts[k])))

  const save = async () => {
    if (!dirty || saving) return
    for (const k of changedKeys) {
      const err = validateValue(k, String(drafts[k]).trim())
      if (err) { toast(`Chyba (${SPEC_BY_KEY[k]?.label ?? k}): ${err}`, 'err'); return }
    }
    setSaving(true)
    let okCount = 0
    try {
      for (const key of changedKeys) {
        const r = await fetch(`/api/operator-settings/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Confirm-Send': 'yes', 'X-Actor': 'dashboard' },
          body: JSON.stringify({ value: String(drafts[key]).trim() }),
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
    <div className="app-nast-panel" data-testid="app-nastaveni-thresholds">
      {state === 'error' ? (
        <div className="app-empty" data-testid="app-nastaveni-thresholds-error">
          <div className="app-empty__title">Nepodařilo se načíst pravidla</div>
          <div>{res.error}</div>
        </div>
      ) : state === 'loading' ? (
        <div className="app-nast-card">{[0, 1, 2, 3].map((i) => <div className="app-nast-skel" key={i} />)}</div>
      ) : (
        <>
          <p className="app-nast-note">Prahy, limity a feature flags pro bounce monitoring, verify queue, distribuci kampaní a corporate-domain cap. Hodnoty se aplikují bez restartu — nejpozději do 60 s od uložení.</p>
          {THRESHOLD_GROUPS.map((g, i) => (
            <Group key={g.key} group={g} byKey={byKey} drafts={drafts} setDraft={setDraft} disabled={saving} defaultOpen={i === 0} />
          ))}

          <div className="app-nast-actionbar">
            <span className="app-nast-actionbar__hint">
              {dirty ? `${changedKeys.length} neuložených změn${hasInvalid ? ' · oprav chyby' : ''}` : <><CheckCircle2 size={13} /> Vše uloženo</>}
            </span>
            <button
              type="button"
              className="app-nast-save"
              data-testid="app-nastaveni-save-thresholds"
              onClick={save}
              disabled={!dirty || saving || hasInvalid}
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
