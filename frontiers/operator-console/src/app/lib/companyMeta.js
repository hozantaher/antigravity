// Pure presentation helpers for the Firmy surface.

// ICP tier → calm chip. The real icp_tier domain (services/contacts/classify/
// icp.go → ICPTier) is: ideal · good · marginal · irrelevant. Render a chip for
// the three meaningful tiers; skip 'irrelevant' + blanks (no chip is calmer than
// a grey "irrelevant" on every row). The previous keys (excellent/fair) matched
// NOTHING the classifier writes, so 'ideal' rows — the best targets — showed no
// badge at all.
const ICP = {
  ideal:    { label: 'ICP ideál',  fg: 'var(--app-positive)', bg: 'var(--app-positive-soft)' },
  good:     { label: 'ICP dobré',   fg: 'var(--app-accent-strong)', bg: 'var(--app-accent-soft)' },
  marginal: { label: 'ICP slabší',  fg: 'var(--app-warning)', bg: 'var(--app-warning-soft)' },
}
export function icpMeta(tier) {
  return ICP[tier] || null
}

// Composite/targeting score as a rounded int, or null when unscored.
export function scoreValue(c) {
  const s = c?.composite_score ?? c?.best_targeting_score
  return s != null ? Math.round(Number(s)) : null
}

// Sector + locality one-liner for the row subtitle. Omits blanks.
export function companySubtitle(c) {
  return [c?.sector_primary, c?.address_locality || c?.region_normalized].filter(Boolean).join(' · ')
}

export function companyTitle(c) {
  return (c?.name || '').trim() || c?.ico || 'Bez názvu'
}

// Company size band (companies.velikost_firmy) → Czech label.
const SIZE = { '1-9': 'Mikro', '10-49': 'Malá', '50-249': 'Střední', '250+': 'Velká' }
export function sizeLabel(v) {
  return SIZE[v] || v || null
}

// Email-verification status → calm chip (label + tones). Mirrors the
// emailVerify.js domain (valid · risky · catch_all · role_only · invalid ·
// spamtrap · no_email · unverified) but reads only --app-* tokens.
const EMAIL_STATUS = {
  valid:      { label: 'Platný',      fg: 'var(--app-positive)',     bg: 'var(--app-positive-soft)' },
  risky:      { label: 'Rizikový',    fg: 'var(--app-warning)',      bg: 'var(--app-warning-soft)' },
  catch_all:  { label: 'Catch-all',   fg: 'var(--app-warning)',      bg: 'var(--app-warning-soft)' },
  role_only:  { label: 'Role adresa', fg: 'var(--app-text-muted)',   bg: 'var(--app-surface-sunk)' },
  invalid:    { label: 'Neplatný',    fg: 'var(--app-negative)',     bg: 'var(--app-negative-soft)' },
  spamtrap:   { label: 'Spam-trap',   fg: 'var(--app-negative)',     bg: 'var(--app-negative-soft)' },
  no_email:   { label: 'Bez e-mailu', fg: 'var(--app-text-soft)',    bg: 'var(--app-surface-sunk)' },
  unverified: { label: 'Neověřeno',   fg: 'var(--app-text-soft)',    bg: 'var(--app-surface-sunk)' },
}
export function emailStatusMeta(status) {
  return EMAIL_STATUS[status] || EMAIL_STATUS.unverified
}

// Absolute date in cs-CZ (drawer rows / verification history). Null-safe.
export function fmtDateCs(d) {
  if (!d) return null
  const t = new Date(d)
  return Number.isNaN(t.getTime())
    ? null
    : t.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })
}
