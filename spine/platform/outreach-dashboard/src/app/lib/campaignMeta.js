// Pure helpers for the Kampaně overview. Read-only — no send controls
// (campaign send requires explicit operator consent; this surface only reads).

const STATUS = {
  running:   { label: 'Běží',        fg: 'var(--app-positive)', bg: 'var(--app-positive-soft)' },
  paused:    { label: 'Pozastaveno', fg: 'var(--app-warning)',  bg: 'var(--app-warning-soft)' },
  draft:     { label: 'Koncept',     fg: 'var(--app-text-muted)', bg: 'var(--app-surface-sunk)' },
  completed: { label: 'Dokončeno',   fg: 'var(--app-accent-strong)', bg: 'var(--app-accent-soft)' },
}
export function campaignStatusMeta(s) {
  return STATUS[s] || { label: s || 'Neznámý', fg: 'var(--app-text-soft)', bg: 'var(--app-surface-sunk)' }
}

// Bounce rate as a percentage of sent (1 decimal), or null when nothing sent.
export function bounceRate(stats) {
  const sent = Number(stats?.sent || 0)
  if (sent <= 0) return null
  return Math.round((Number(stats?.bounced || 0) / sent) * 1000) / 10
}

// The stat tiles shown on a campaign card, in display order.
export function statTiles(stats) {
  return [
    { label: 'Odesláno',    value: Number(stats?.sent ?? 0) },
    { label: 'Odražené',    value: Number(stats?.bounced ?? 0) },
    { label: 'Selhalo',     value: Number(stats?.failed ?? 0) },
    { label: 'Přeskočeno',  value: Number(stats?.presend_skip ?? 0) },
  ]
}
