import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { stageMeta, bestPrice, formatEur, vehicleTitle } from '../../lib/vehicleMeta'
import { relativeCs } from '../../lib/replyMeta'
import VehicleStatusStepper from '../../pages/VehicleStatusStepper'

// Editable detail aside for the Vozidla inventory — parity port of
// VehicleDetail.jsx so /vehicles + /vehicles/:id can be retired. It advances
// the pipeline status (offered→…→picked_up, or cancel), edits the three deal
// prices (Požadovaná / Nabídnutá / Dohodnutá → marže) and the free-text notes,
// and links provenance (firma · CRM klient · zdrojová odpověď · kontakt).
// Every mutation is the SAME audited PATCH /api/vehicles/:id the detail used
// (Content-Type json; the vehicles routes require no X-Confirm-Send) — no new
// endpoints. A toast confirms each save + offers retry on failure.

const cs = new Intl.NumberFormat('cs-CZ')

// Parse a price input → number EUR or null. Blank/non-numeric/negative → null
// ("unknown"), so clearing a field means "unknown" — mirrors v1's PriceField.
function parsePrice(raw) {
  const s = String(raw).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n : null
}

// One editable price cell with an inline save (✓) that appears only when the
// draft diverges from the stored value. Holds its own draft so typing never
// thrashes the parent list re-render.
function PriceField({ label, value, field, patch, busy, testid }) {
  const [draft, setDraft] = useState(null)
  const cur = draft == null ? (value ?? '') : draft
  const dirty = draft != null && parsePrice(draft) !== (value ?? null)
  return (
    <div className="app-vd__price">
      <label className="app-vd__price-label">{label}</label>
      <div className="app-vd__price-row">
        <input
          type="number" min="0" inputMode="numeric" className="app-vd__price-input"
          value={cur} onChange={(e) => setDraft(e.target.value)}
          placeholder="—" data-testid={testid} aria-label={`${label} (€)`}
        />
        {dirty ? (
          <button
            type="button" className="app-vd__price-save" disabled={busy}
            data-testid={`${testid}-save`} aria-label={`Uložit ${label}`}
            onClick={async () => {
              const ok = await patch({ [field]: parsePrice(draft) }, `${label} uložena`)
              if (ok) setDraft(null)
            }}
          >
            <Check size={13} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

export default function VehicleDetailAside({ vehicle: v, onClose, onChanged, toast }) {
  const [busy, setBusy] = useState(false)
  const [notes, setNotes] = useState(null) // null = pristine; string = editing

  if (!v) return null

  // Audited PATCH — same endpoint + headers v1's detail used. Returns a boolean
  // so callers can clear their dirty draft only on success.
  const patch = async (body, okMsg) => {
    setBusy(true)
    try {
      const r = await fetch(`/api/vehicles/${v.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      toast?.(okMsg || 'Uloženo', 'ok')
      await onChanged?.()
      return true
    } catch (e) {
      toast?.(`Chyba: ${e.message}`, 'err', { action: { label: 'Zkusit znovu', onClick: () => patch(body, okMsg) } })
      return false
    } finally {
      setBusy(false)
    }
  }

  const stage = stageMeta(v.status)
  const price = bestPrice(v)
  const margin = (v.price_agreed_eur != null && v.price_offered_eur != null)
    ? v.price_agreed_eur - v.price_offered_eur
    : null

  // Technika rows — the three prices moved to the editable Cena section below.
  const rows = [
    ['VIN', v.vin],
    ['Najeto', v.mileage_km != null ? `${cs.format(v.mileage_km)} km` : null],
    ['Palivo', v.fuel],
    ['Převodovka', v.transmission],
    ['Karoserie', v.body_type],
    ['Barva', v.color],
  ].filter(([, val]) => val != null && val !== '')

  const links = [
    ['Firma', v.company_ico
      ? <Link to={`/firmy?ico=${encodeURIComponent(v.company_ico)}`} className="app-vd__link" data-testid="app-vehicle-company-link">{v.company_name || v.company_ico} →</Link>
      : v.company_name],
    ['CRM klient', v.crm_client_name],
    ['Zdroj (e-mail)', v.source_reply_email],
  ].filter(([, val]) => val)

  const photos = Array.isArray(v.photos) ? v.photos.filter((ph) => ph && ph.url) : []
  const notesDirty = notes != null && notes !== (v.notes || '')

  return (
    <aside className="app-vozidla__aside" data-testid="app-vehicle-detail">
      <button type="button" className="app-vd__close" aria-label="Zavřít" onClick={onClose}>×</button>
      <h2 className="app-vd__title">{vehicleTitle(v)}</h2>
      <div>
        <span className="app-tag" style={{ color: stage.fg, background: stage.bg }}>{stage.label}</span>
        {price ? <span style={{ marginLeft: 8, fontWeight: 600 }}>{formatEur(price.amount)} <span style={{ color: 'var(--app-text-soft)', fontWeight: 400, fontSize: 'var(--app-text-xs)' }}>· {price.kind}</span></span> : null}
      </div>

      <div className="app-vd__section">
        <div className="app-vd__label">Posunout v pipeline</div>
        <VehicleStatusStepper vehicle={v} onChanged={onChanged} onToast={toast} />
      </div>

      {/* Editable prices + computed margin — parity with VehicleDetail. */}
      <div className="app-vd__section" data-testid="app-vehicle-prices">
        <div className="app-vd__label">Cena a marže</div>
        <div className="app-vd__prices">
          <PriceField label="Požadovaná" value={v.price_asking_eur} field="price_asking_eur" patch={patch} busy={busy} testid="app-vehicle-price-asking" />
          <PriceField label="Nabídnutá" value={v.price_offered_eur} field="price_offered_eur" patch={patch} busy={busy} testid="app-vehicle-price-offered" />
          <PriceField label="Dohodnutá" value={v.price_agreed_eur} field="price_agreed_eur" patch={patch} busy={busy} testid="app-vehicle-price-agreed" />
          <div className="app-vd__price">
            <span className="app-vd__price-label">Marže</span>
            <div
              className="app-vd__margin" data-testid="app-vehicle-margin"
              style={{ color: margin == null ? 'var(--app-text-soft)' : margin >= 0 ? 'var(--app-positive)' : 'var(--app-negative)' }}
            >
              {margin == null ? '—' : formatEur(margin)}
            </div>
          </div>
        </div>
      </div>

      {photos.length > 0 ? (
        <div className="app-vd__section" data-testid="app-vehicle-photos">
          <div className="app-vd__label">Fotky ({photos.length})</div>
          <div className="app-vd__photos">
            {photos.map((ph, i) => (
              <a key={i} href={ph.url} target="_blank" rel="noreferrer" className="app-vd__photo" title={ph.filename || ''}>
                <img src={ph.url} alt={ph.filename || `foto ${i + 1}`} loading="lazy" />
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {rows.length > 0 && (
        <div className="app-vd__section">
          <div className="app-vd__label">Technika</div>
          <dl style={{ margin: 0 }}>{rows.map(([k, val]) => <div className="app-vd__row" key={k}><dt>{k}</dt><dd>{val}</dd></div>)}</dl>
        </div>
      )}

      {(links.length > 0 || v.contact_id) && (
        <div className="app-vd__section">
          <div className="app-vd__label">Propojení</div>
          <dl style={{ margin: 0 }}>{links.map(([k, val]) => <div className="app-vd__row" key={k}><dt>{k}</dt><dd>{val}</dd></div>)}</dl>
          {v.contact_id ? (
            <Link to={`/kontakty?id=${v.contact_id}`} className="app-vd__link" data-testid="app-vehicle-contact-link">
              Zobrazit kontakt →
            </Link>
          ) : null}
          {v.source_reply_id ? (
            <Link to={`/odpovedi?vse=1&id=${v.source_reply_id}`} className="app-vd__link" data-testid="app-vehicle-reply-link">
              Zobrazit zdrojovou odpověď →
            </Link>
          ) : null}
        </div>
      )}

      <div className="app-vd__section">
        <div className="app-vd__label">Stav</div>
        <div style={{ fontSize: 'var(--app-text-sm)', color: 'var(--app-text-muted)' }}>
          {v.status_changed_at ? `Změněno ${relativeCs(v.status_changed_at)} · ` : ''}vytvořeno {relativeCs(v.created_at)}
        </div>
      </div>

      {/* Editable notes — parity with (always present; was read-only/hidden). */}
      <div className="app-vd__section">
        <div className="app-vd__label">Poznámky</div>
        <textarea
          className="app-vd__notes-edit" data-testid="app-vehicle-notes" rows={4}
          value={notes == null ? (v.notes || '') : notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Poznámky k vozidlu, stav, domluva…"
        />
        {notesDirty ? (
          <button
            type="button" className="app-vd__notes-save" disabled={busy} data-testid="app-vehicle-notes-save"
            onClick={async () => { const ok = await patch({ notes }, 'Poznámka uložena'); if (ok) setNotes(null) }}
          >
            Uložit poznámku
          </button>
        ) : null}
      </div>
    </aside>
  )
}
