// Shared presentation helpers for the Vozidla pipeline. Pure functions.
// "Leady JSOU vozidla" — this board IS the acquisition funnel.

// The acquisition pipeline stages, in order. Mirrors the vehicles.status
// CHECK constraint (offered → negotiating → agreed → paid → picked_up).
// 'cancelled' is terminal/off-funnel and shown separately, not as a stage.
export const STAGES = [
  { key: 'offered',     label: 'Nabídnuto',  fg: 'var(--app-text-muted)',     bg: 'var(--app-surface-sunk)' },
  { key: 'negotiating', label: 'Jednání',    fg: 'var(--app-accent-strong)',  bg: 'var(--app-accent-soft)' },
  { key: 'agreed',      label: 'Dohodnuto',  fg: 'var(--app-warning)',        bg: 'var(--app-warning-soft)' },
  { key: 'paid',        label: 'Zaplaceno',  fg: 'var(--app-positive)',       bg: 'var(--app-positive-soft)' },
  { key: 'picked_up',   label: 'Vyzvednuto', fg: 'var(--app-positive)',       bg: 'var(--app-positive-soft)' },
]

export const CANCELLED = { key: 'cancelled', label: 'Zrušeno', fg: 'var(--app-negative)', bg: 'var(--app-negative-soft)' }

const BY_KEY = Object.fromEntries([...STAGES, CANCELLED].map((s) => [s.key, s]))

export function stageMeta(status) {
  return BY_KEY[status] || { key: status || 'unknown', label: status || 'Neznámý', fg: 'var(--app-text-soft)', bg: 'var(--app-surface-sunk)' }
}

// Best available price for a vehicle, in the order the deal progresses:
// agreed > offered > asking. Returns { amount, kind } or null.
export function bestPrice(v) {
  if (v?.price_agreed_eur != null) return { amount: v.price_agreed_eur, kind: 'Dohodnutá' }
  if (v?.price_offered_eur != null) return { amount: v.price_offered_eur, kind: 'Nabídnutá' }
  if (v?.price_asking_eur != null) return { amount: v.price_asking_eur, kind: 'Požadovaná' }
  return null
}

export function formatEur(amount) {
  if (amount == null) return '—'
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(amount)
}

// Human title for a vehicle card: "Caterpillar 320 · 2018". Make is NOT NULL
// in the schema; model/year are optional, so build defensively.
export function vehicleTitle(v) {
  const parts = [v?.make, v?.model].filter(Boolean)
  let t = parts.join(' ') || 'Bez označení'
  if (v?.year) t += ` · ${v.year}`
  return t
}

// Short spec line: mileage + fuel + transmission, omitting blanks.
export function vehicleSpecs(v) {
  const out = []
  if (v?.mileage_km != null) out.push(`${new Intl.NumberFormat('cs-CZ').format(v.mileage_km)} km`)
  if (v?.fuel) out.push(v.fuel)
  if (v?.transmission) out.push(v.transmission)
  if (v?.body_type) out.push(v.body_type)
  return out.join(' · ')
}

// Status transition helpers for the detail stepper. Pure.
// The pipeline is linear; the operator may also jump back or cancel. We only
// compute the PATCH body — deterministic server write owns the final state.
export function statusPatch(nextStatus) {
  return { status: nextStatus }
}

// Index of a status within the linear funnel (-1 for cancelled/unknown).
export function stageIndex(status) {
  return STAGES.findIndex((s) => s.key === status)
}
