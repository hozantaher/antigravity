// Pure presentation helpers for the Kontakty surface.

// Best display name: "First Last", else email, else placeholder. Never blank.
export function contactName(c) {
  const n = `${c?.first_name || ''} ${c?.last_name || ''}`.trim()
  if (n) return n
  if (c?.email) return c.email
  return 'Bez jména'
}

// Email-status chip → calm Claude-palette. Mirrors the values the verifier
// writes (valid / risky / invalid / unknown / catch_all …).
const EMAIL_STATUS = {
  valid:     { label: 'Ověřený',  fg: 'var(--app-positive)', bg: 'var(--app-positive-soft)' },
  risky:     { label: 'Rizikový', fg: 'var(--app-warning)',  bg: 'var(--app-warning-soft)' },
  invalid:   { label: 'Neplatný', fg: 'var(--app-negative)', bg: 'var(--app-negative-soft)' },
  catch_all: { label: 'Catch-all', fg: 'var(--app-text-muted)', bg: 'var(--app-surface-sunk)' },
}
export function emailStatusMeta(s) {
  return EMAIL_STATUS[s] || null   // null = don't render a chip (unknown/blank)
}

// contacts.status → Czech label (#1586 R2). Real values: valid/sent/bounced/new
// (+ suppressed/unsubscribed defensively). Falls back to the raw value so an
// unmapped status still shows something, never an English enum-by-surprise.
const CONTACT_STATUS = {
  valid: 'Aktivní', new: 'Nový', sent: 'Osloven', bounced: 'Odražený',
  suppressed: 'Potlačený', unsubscribed: 'Odhlášen',
}
export function contactStatusLabel(s) {
  if (!s) return null
  return CONTACT_STATUS[s] || s
}

// campaign_contacts.status → Czech label (#1586 R2). Real values:
// pending/skipped/paused (+ in_flight/sent/failed per the lease lifecycle).
const CAMPAIGN_CONTACT_STATUS = {
  pending: 'Čeká', skipped: 'Přeskočeno', paused: 'Pozastaveno',
  in_flight: 'Odesílá se', sent: 'Odesláno', failed: 'Chyba',
}
export function campaignContactStatusLabel(s) {
  if (!s) return null
  return CAMPAIGN_CONTACT_STATUS[s] || s
}

// CRM relationship → short label. Returns null when not in CRM.
export function crmLabel(c) {
  if (!c?.crm_client_id) return null
  const rel = c?.crm?.crm_relationship || c?.crm?.crm_status
  return rel ? `CRM · ${rel}` : 'CRM'
}
