import { useState } from 'react'
import { STAGES, CANCELLED, statusPatch, stageMeta } from '../lib/vehicleMeta'

// Interactive pipeline stepper for the Vozidla detail aside. The operator
// moves a vehicle through its acquisition stages (forward or back), or cancels.
// Each click is an explicit PATCH — the audited server endpoint writes the
// final state (operator_audit_log: vehicle_updated).
// Calm: optimistic chip highlight, inline "ukládám…", revert + message on error.
//
// NOTE: no price is captured here. The business doesn't quote a price in the
// dashboard — the operator agrees terms by phone and the vehicle goes into our
// auction. The dashboard's job is to pull the car + its info, not deal economics.

export default function VehicleStatusStepper({ vehicle, onChanged, onToast }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const current = vehicle.status

  const setStatus = async (next) => {
    if (next === current || busy) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`/api/vehicles/${vehicle.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(statusPatch(next)),
      })
      if (!r.ok) throw new Error(`patch ${r.status}`)
      onToast?.(`Stav → ${stageMeta(next).label}`, 'ok')  // optional toast (additive)
      await onChanged?.()        // refresh the list so table + aside reflect it
    } catch {
      setErr('Změna se nezdařila — zkus znovu.')
      onToast?.('Změna stavu se nezdařila', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-stepper" data-testid="app-status-stepper">
      <div className="app-stepper__track">
        {STAGES.map((s) => {
          const active = s.key === current
          return (
            <button key={s.key} type="button" className={`app-step${active ? ' app-step--active' : ''}`}
              style={active ? { color: s.fg, background: s.bg, borderColor: s.fg } : undefined}
              aria-pressed={active} disabled={busy}
              onClick={() => setStatus(s.key)} data-testid={`app-step-${s.key}`}>
              {s.label}
            </button>
          )
        })}
      </div>
      <div className="app-stepper__foot">
        {current !== CANCELLED.key ? (
          <button type="button" className="app-step app-step--cancel" disabled={busy}
            onClick={() => setStatus(CANCELLED.key)} data-testid="app-step-cancel">Zrušit obchod</button>
        ) : (
          <span style={{ color: 'var(--app-negative)', fontSize: 'var(--app-text-xs)', fontWeight: 600 }}>Obchod zrušen</span>
        )}
        {busy ? <span className="app-stepper__msg">ukládám…</span> : null}
        {err ? <span className="app-stepper__msg app-stepper__msg--err">{err}</span> : null}
      </div>
    </div>
  )
}
