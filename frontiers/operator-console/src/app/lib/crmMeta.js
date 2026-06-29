// Pure presentation helpers for the CRM klienti surface.

export function clientName(c) {
  return (c?.name || '').trim() || c?.email_primary || c?.ico || 'Bez názvu'
}

// crm_status → calm chip. Values seen in prod: Potenciální / Aktuální /
// Nezajímavý / lead. Returns null for blank (no noise chip).
const STATUS = {
  'Aktuální':    { label: 'Aktuální',    fg: 'var(--app-positive)', bg: 'var(--app-positive-soft)' },
  'Potenciální': { label: 'Potenciální', fg: 'var(--app-accent-strong)', bg: 'var(--app-accent-soft)' },
  'Nezajímavý':  { label: 'Nezajímavý',  fg: 'var(--app-text-muted)', bg: 'var(--app-surface-sunk)' },
  'lead':        { label: 'Lead',        fg: 'var(--app-warning)', bg: 'var(--app-warning-soft)' },
}
export function crmStatusMeta(status) {
  if (!status) return null
  return STATUS[status] || { label: status, fg: 'var(--app-text-soft)', bg: 'var(--app-surface-sunk)' }
}

// crm_relationship → short label, null when blank/none.
export function relationshipLabel(rel) {
  if (!rel) return null
  if (rel === 'vehicle_offered') return 'Nabídnuto vozidlo'
  return rel
}
